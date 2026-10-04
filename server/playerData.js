// firebaseAdmin.js exports the `admin` SDK object itself with `.db` bolted on
// (see module.exports there) - not a { admin, db } object, so we grab both off
// the same import rather than destructuring.
const admin = require('./firebaseAdmin');
const { db } = admin;
const fs = require('fs');
const path = require('path');
const { checkAndAwardBadges, getBadgeDisplayInfo } = require('./badges');

// same Coins attribute id used throughout this file (see IMPORT_VALUE_CAPS
// below) - pulled out as its own constant here since savePersistedEntityData
// needs it directly to apply badge coin rewards onto a fresh attributes
// snapshot before it's saved.
const COINS_ATTR_ID = 'KAohfBnN6V';
const GEMS_FIELD = 'gems';

const DISCORD_IMPORT_WEBHOOK_URL = process.env.DISCORD_IMPORT_WEBHOOK_URL || '';

async function notifyDiscordImport({ uid, username, previousValues, newValues, force }) {
    if (!DISCORD_IMPORT_WEBHOOK_URL) return;

    const now = new Date();
    const date = `${now.getMonth() + 1}/${now.getDate()}`;
    const time = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });

    const changes = [];
    const allIds = new Set([
        ...Object.keys(previousValues || {}),
        ...Object.keys(newValues || {}),
    ]);

    for (const attrId of allIds) {
        const previous = previousValues && previousValues[attrId];
        const next = newValues && newValues[attrId];
        if (previous === undefined && next === undefined) continue;
        if (previous === next) continue;

        const label =
            (next && next.name) ||
            (previous && previous.name) ||
            attrId;

        const oldValue = previous && previous.value !== undefined ? previous.value : 0;
        const newValue = next && next.value !== undefined ? next.value : 0;

        changes.push(`${label}: ${oldValue} => ${newValue}`);
    }

    const header = `Data import: ${date}, ${time}, ${username || uid}`;
    const changeLines = changes.length > 0
        ? changes.slice(0, 50)
        : ['No attribute value changes.'];

    let content = `${header}\n${changeLines.join('\n')}`;
    if (content.length > 1900) {
        content = `${content.slice(0, 1890)}\n...`;
    }

    try {
        const response = await fetch(DISCORD_IMPORT_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                content,
                allowed_mentions: { parse: [] },
            }),
        });

        if (!response.ok) {
            console.error(`Discord import webhook returned HTTP ${response.status}`);
        }
    } catch (err) {
        console.error('Discord import webhook failed:', err.message);
    }
}


// stuuuff
//
// game.json's data.data.attributeTypes is the single source of truth for
// every attribute id's name/min/max in the actual running game - the same
// registry the client reads as taro.game.data.attributeTypes. We use it here
// to validate anything a player pastes into the modd.io/indie.fun import box
// (see importModdData below), since that's the one place in the whole app
// where raw player-supplied JSON gets treated as trusted persisted data.
let attributeTypesById = {};
try {
	const gameJsonPath = path.join(__dirname, '..', 'src', 'game.json');
	const gameJson = JSON.parse(fs.readFileSync(gameJsonPath, 'utf8'));
	attributeTypesById = (gameJson.data && gameJson.data.attributeTypes) || {};
} catch (err) {
	console.log('playerData: failed to load game.json attribute schema, imports will reject everything:', err.message);
}

// most attribute maxes in the schema above are editor placeholder defaults
// (e.g. Coins' max is the string "999999999999999999999999") - they exist to
// stop the in-game UI from rendering garbage, not to stop someone from
// pasting {"value": 999999999} into the import box. for attributes where an
// unrealistic value would actually be a competitive/economy advantage, set a
// real ceiling here based on what's actually achievable through normal play.
// anything not listed here just falls back to the schema's own max, which is
// effectively no cap - so add to this list whenever a new ownable/earnable
// stat is added to the game and matters for fairness
const IMPORT_VALUE_CAPS = {
	KAohfBnN6V: 49510, // Coins
	fKYSjs9Zw4: 50, // Wins
	NbZXJa87MY: 100, // Tacos
	GSYwTBl68S: 2, // spawnAIMax - schema's own max is 100, but real intended gameplay ceiling is 2
	// "*Owned?" / "*Won?" flags are just 0/1 toggles in the schema already
	// (min:0, max:1), so they don't need an entry here - the schema clamp
	// alone is sufficient for booleans, only numeric currency-like stats
	// need a hand-picked ceiling.
};

// attribute ids that should never come back through an import, because
// they're intentionally session-only and get overwritten every time a
// player joins regardless (see the "player joins" script's stage-based Sun
// reset) - importing a stale Sun value would just get stomped anyway, so we
// drop it here rather than let it sit in Firestore looking meaningful.
const NON_PERSISTENT_ATTRIBUTE_IDS = new Set([
	'dXSTbWLa7y', // Sun
]);

async function getPlayerData(uid) {
	const doc = await db.collection('players').doc(uid).get();
	if (!doc.exists) {
		return null;
	}
	return doc.data();
}

async function savePlayerData(uid, data) {
	await db.collection('players').doc(uid).set(data, { merge: true });
}

function notifyBadgesUnlocked(uid, newlyAwarded) {
	try {
		if (typeof taro === 'undefined' || !taro.network || !taro.$$) return;
		const player = taro
			.$$('player')
			.find((p) => p._stats && (p._stats.userId === uid || p._stats.guestUserId === uid));
		if (!player || !player._stats.clientId) return;

		const badgesForToast = newlyAwarded.map((id) => getBadgeDisplayInfo(id)).filter(Boolean);
		if (badgesForToast.length === 0) return;

		taro.network.send('ui', { command: 'achievementUnlocked', badges: badgesForToast }, player._stats.clientId);
	} catch (err) {
		console.error('notifyBadgesUnlocked failed', err);
	}
}

// badge checking
function checkBadgesLive(player, changedAttrId) {
	if (!player || !player._stats) return;
	const userId = player._stats.userId || player._stats.guestUserId;
    const isGuestUser = !player._stats.userId && !!player._stats.guestUserId;
    if (!userId) return; // no badges for guests

	const knownBadges = player._badgeCache || {};
	const { badges, newlyAwarded, coinsEarned, gemsEarned } = checkAndAwardBadges(knownBadges, player._stats.attributes);

	if (newlyAwarded.length === 0) return; // the common case - nothing further to do

	player._badgeCache = badges; // keep the in-memory cache in sync for next time

	if (coinsEarned > 0 && player._stats.attributes[COINS_ATTR_ID]) {
		const newCoins = (player._stats.attributes[COINS_ATTR_ID].value || 0) + coinsEarned;
		// routes back through AttributeComponent.update() - safe against
		// infinite recursion, since checkAndAwardBadges skips already-owned
		// badges, so any further recursive call can only ever award badges
		// that are still new, which is bounded by the fixed badge count.
		player.attribute.update(COINS_ATTR_ID, newCoins);
	}

	const update = { badges };
	if (gemsEarned > 0) {
		// atomic increment - avoids needing to read the current gems value
		// first (which would mean a Firestore read on every badge earned)
		update.gems = admin.firestore.FieldValue.increment(gemsEarned);
	}

	if (isGuestUser) {
        notifyBadgesUnlocked(userId, newlyAwarded);
        return;
    }

    db.collection('players')
        .doc(userId)
        .set(update, { merge: true })
        .then(() => notifyBadgesUnlocked(userId, newlyAwarded))
        .catch((err) => console.log('checkBadgesLive: failed to save badges for', userId, err.message));
}

async function savePersistedEntityData(uid, { player, unit } = {}, isGuestUser = false) {
    if (isGuestUser) {
    	return;
    }
	
	const data = { data: {} };
	const mergeFields = [];

	if (player !== undefined) {
		if (player.attributes) {
			const existing = await getPlayerData(uid);
			const { badges, newlyAwarded, coinsEarned, gemsEarned } = checkAndAwardBadges(
				(existing && existing.badges) || {},
				player.attributes
			);
			if (newlyAwarded.length > 0) {
				if (coinsEarned > 0 && player.attributes[COINS_ATTR_ID]) {
					player.attributes[COINS_ATTR_ID].value =
						(player.attributes[COINS_ATTR_ID].value || 0) + coinsEarned;
				}
				data.badges = badges;
				mergeFields.push(new admin.firestore.FieldPath('badges'));
				if (gemsEarned > 0) {
					data.gems = ((existing && existing.gems) || 0) + gemsEarned;
					mergeFields.push(new admin.firestore.FieldPath('gems'));
				}
				notifyBadgesUnlocked(uid, newlyAwarded);
			}
		}
		data.data.player = player;
		mergeFields.push(new admin.firestore.FieldPath('data', 'player'));
	}
	if (unit !== undefined) {
		data.data.unit = unit;
		mergeFields.push(new admin.firestore.FieldPath('data', 'unit'));
	}
	if (mergeFields.length === 0) {
		return;
	}

	await db.collection('players').doc(uid).set(data, { mergeFields });
}


async function getSkinState(uid) {
	const doc = await db.collection('players').doc(uid).get();
	const data = doc.exists ? doc.data() : {};
	return {
		ownedSkins: Array.isArray(data.ownedSkins) ? data.ownedSkins : [],
		equippedSkins: data.equippedSkins && typeof data.equippedSkins === 'object' ? data.equippedSkins : {},
		gems: Number(data[GEMS_FIELD]) || 0,
	};
}

async function purchaseSkin(uid, skinId, getSkinById, getEffectiveSkinPrice, isSkinAvailable) {
	const skin = getSkinById(skinId);
	if (!skin) {
		throw new Error('Skin not found.');
	}

	if (!isSkinAvailable(skin)) {
		throw new Error('Skin is not currently available.');
	}

	const price = getEffectiveSkinPrice(skin);
	if (!Number.isFinite(price) || price < 0) {
		throw new Error('Skin has an invalid price.');
	}

	const playerRef = db.collection('players').doc(uid);
	let result;

	await db.runTransaction(async (tx) => {
		const playerDoc = await tx.get(playerRef);
		const data = playerDoc.exists ? playerDoc.data() : {};
		const ownedSkins = Array.isArray(data.ownedSkins) ? data.ownedSkins : [];
		const gems = Number(data[GEMS_FIELD]) || 0;

		if (ownedSkins.includes(skinId)) {
			throw new Error('You already own this skin.');
		}
		if (gems < price) {
			throw new Error('Not enough Gems.');
		}

		tx.set(
			playerRef,
			{
				[GEMS_FIELD]: gems - price,
				ownedSkins: [...ownedSkins, skinId],
			},
			{ merge: true }
		);

		result = {
			ownedSkins: [...ownedSkins, skinId],
			gems: gems - price,
		};
	});

	return result;
}

async function equipOwnedSkin(uid, skinId, unitTypeId, getSkinById) {
	const playerRef = db.collection('players').doc(uid);
	let equippedSkins;

	await db.runTransaction(async (tx) => {
		const skin = getSkinById(skinId);
		if (!skin) {
			throw new Error('Skin not found.');
		}
		if (skin.unitTypeId !== unitTypeId) {
			throw new Error('That skin does not belong to this unit type.');
		}

		const playerDoc = await tx.get(playerRef);
		const data = playerDoc.exists ? playerDoc.data() : {};
		const ownedSkins = Array.isArray(data.ownedSkins) ? data.ownedSkins : [];
		if (!ownedSkins.includes(skinId)) {
			throw new Error('You do not own this skin.');
		}

		equippedSkins =
			data.equippedSkins && typeof data.equippedSkins === 'object'
				? { ...data.equippedSkins }
				: {};
		equippedSkins[unitTypeId] = skinId;

		tx.set(playerRef, { equippedSkins }, { merge: true });
	});

	return equippedSkins;
}

async function unequipSkin(uid, unitTypeId) {
	const playerRef = db.collection('players').doc(uid);
	await playerRef.set(
		{
			equippedSkins: {
				[unitTypeId]: admin.firestore.FieldValue.delete(),
			},
		},
		{ merge: true }
	);
	return (await getSkinState(uid)).equippedSkins;
}

// Thrown by claimUsername() when someone else already holds that username -
// server.js catches this specifically to send back a 409 instead of a 500.
class UsernameTakenError extends Error {
	constructor(username) {
		super(`Username "${username}" is already taken.`);
		this.name = 'UsernameTakenError';
	}
}

// atomically gives `username` to `uid`, and releases whatever username `uid`
// previously held (if any). The `usernames` collection is a "claim table" -
// its document IDs (lowercased usernames) are what actually enforce
// uniqueness, since Firestore guarantees two documents can never share an ID.
// Wrapping the read + write in a transaction is what makes this race-proof:
// if two people try to claim the same username at once, Firestore serializes
// the two transactions so only one of them can see the doc as still free.
async function claimUsername(uid, username) {
	const usernameKey = username.toLowerCase();
	const usernameRef = db.collection('usernames').doc(usernameKey);
	const playerRef = db.collection('players').doc(uid);

	await db.runTransaction(async (tx) => {
		const [usernameDoc, playerDoc] = await Promise.all([tx.get(usernameRef), tx.get(playerRef)]);

		if (usernameDoc.exists && usernameDoc.data().uid !== uid) {
			throw new UsernameTakenError(username);
		}

		// if this player already had a different username, free it up so someone
		// else can take it - otherwise every rename would leak a permanently
		// reserved username behind them
		const oldUsername = playerDoc.exists ? playerDoc.data().username : null;
		if (oldUsername && oldUsername.toLowerCase() !== usernameKey) {
			tx.delete(db.collection('usernames').doc(oldUsername.toLowerCase()));
		}

		tx.set(usernameRef, { uid, username });
		tx.set(playerRef, { username }, { merge: true });
	});
}

// looks up a player's uid from their claimed username (the `usernames`
// collection - see claimUsername above). Used by the admin import helper,
// where an admin targets a player by username rather than a raw Firebase uid.
async function getUidByUsername(username) {
	const doc = await db.collection('usernames').doc(username.toLowerCase()).get();
	return doc.exists ? doc.data().uid : null;
}

// snapshots whatever's currently saved for uid into
// players/{uid}/backups/{timestamp} before a destructive operation (modd
// import, wipe) touches it, so a mistake is always recoverable and nothing
// is ever silently thrown away. Returns the backup doc's id.
async function backupPlayerData(uid, reason) {
	const current = await getPlayerData(uid);
	const backupId = String(Date.now());
	await db
		.collection('players')
		.doc(uid)
		.collection('backups')
		.doc(backupId)
		.set({ reason, snapshotOf: current || null, backedUpAt: Date.now() });
	return backupId;
}

// convert
function transformModdPlayerExport(moddExport) {
	if (!moddExport || typeof moddExport !== 'object' || !moddExport.player) {
		throw new Error("That doesn't look like a modd.io/indie.fun save export - expected a top-level \"player\" key.");
	}

	const incomingAttributes = moddExport.player.attributes || {};
	const attributes = {};
	const skipped = [];

	for (const attrId in incomingAttributes) {
		const schema = attributeTypesById[attrId];

		if (!schema) {
			// not a real attribute in this game - either a typo, a leftover
			// from an older version of the game, or someone hand-crafting
			// JSON. Either way, there's nothing to validate it against, so
			// it's dropped rather than trusted.
			skipped.push({ attrId, reason: 'unknown attribute' });
			continue;
		}

		if (NON_PERSISTENT_ATTRIBUTE_IDS.has(attrId)) {
			continue; // silently dropped, not a rejection - this is expected
		}

		const rawValue = incomingAttributes[attrId] && incomingAttributes[attrId].value;
		const numericValue = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue);

		if (!Number.isFinite(numericValue)) {
			skipped.push({ attrId, reason: 'non-numeric value' });
			continue;
		}

		// schema min/max always win - never the pasted data's own min/max.
		// schema max is sometimes a string (e.g. Coins' "999999999999999999999999")
		// since the editor stores it as free text, so this always runs it
		// through Number() rather than trusting its type.
		const schemaMin = Number(schema.min) || 0;
		const schemaMax = Number(schema.max);
		const cap = IMPORT_VALUE_CAPS[attrId];
		const effectiveMax = cap !== undefined ? Math.min(cap, schemaMax) : schemaMax;

		const clampedValue = Math.max(schemaMin, Math.min(numericValue, effectiveMax));

		attributes[attrId] = {
			name: schema.name,
			min: schemaMin,
			max: schemaMax,
			regenerateSpeed: schema.regenerateSpeed || 0,
			value: clampedValue,
		};

		if (clampedValue !== numericValue) {
			skipped.push({ attrId, reason: `value ${numericValue} clamped to ${clampedValue}` });
		}
	}

	return {
		attributes,
		variables: moddExport.player.variables || {},
		skipped,
	};
}

// imports a modd.io/indie.fun export into uid's Firestore player data.
// per-key (attribute id / variable name), the modd.io value wins over
// whatever's already saved - but only after backupPlayerData() snapshots the
// pre-import state, so nothing is ever unrecoverably lost. Blocked from
// running a second time on the same account unless `force` is set (used by
// the admin import helper to redo an import for someone who ran into
// trouble - see /api/admin-import-modd-data in server.js).
async function importModdData(uid, moddExport, { force = false } = {}) {
	const current = await getPlayerData(uid);
    const previousPlayer = (current && current.data && current.data.player) || {};
    const previousAttributes = previousPlayer.attributes || {};
    const username = (current && current.username) || uid;
	if (current && current.moddImportedAt && !force) {
		const err = new Error('This account has already imported its modd.io/indie.fun data.');
		err.code = 'ALREADY_IMPORTED';
		throw err;
	}

	const incoming = transformModdPlayerExport(moddExport);
	const existingPlayer = (current && current.data && current.data.player) || {};

	const mergedPlayer = {
		attributes: { ...(existingPlayer.attributes || {}), ...incoming.attributes },
		variables: { ...(existingPlayer.variables || {}), ...incoming.variables },
		quests: existingPlayer.quests,
	};

	const backupId = await backupPlayerData(uid, force ? 'admin-modd-import' : 'modd-import');
	await savePersistedEntityData(uid, { player: mergedPlayer });
	await db.collection('players').doc(uid).set({ moddImportedAt: Date.now() }, { merge: true });

    await notifyDiscordImport({
        uid,
        username,
        previousValues: previousAttributes,
        newValues: mergedPlayer.attributes || {},
        force,
    });

	return { backupId, skipped: incoming.skipped };
}

// resets uid's saved progress to a blank slate - backs the old data up first
// (same safety net as importModdData) and clears moddImportedAt, so the
// account is free to run the modd.io import again afterward if the player
// wants to.
async function wipePlayerData(uid) {
	const backupId = await backupPlayerData(uid, 'wipe');
	await savePersistedEntityData(uid, { player: { attributes: {}, variables: {}, quests: undefined } });
	await db
		.collection('players')
		.doc(uid)
		.set({ moddImportedAt: admin.firestore.FieldValue.delete() }, { merge: true });
	return { backupId };
}
const LEADERBOARD_ATTRIBUTE_IDS = {
	wins: 'fKYSjs9Zw4', // Wins
	coins: 'KAohfBnN6V', // Coins
};
const LEADERBOARD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // one week
const LEADERBOARD_ENTRY_LIMIT = 50;

// username hiding
const LEADERBOARD_EXCLUDED_USERNAMES = new Set(
  ['testaccount12345', 'testaccount1', 'testaccount2', 'testaccount3', 'testaccount4', 'testaccount5'].map((name) => name.toLowerCase())
);

// guards against a stampede of concurrent recomputes if several requests
// land back to back right as the cache goes stale - later callers just await
// the recompute already in progress instead of each firing their own query
let leaderboardRefreshInFlight = null;

async function computeLeaderboard() {
	const [winsSnapshot, coinsSnapshot] = await Promise.all([
		db
			.collection('players')
			.orderBy(`data.player.attributes.${LEADERBOARD_ATTRIBUTE_IDS.wins}.value`, 'desc')
			.limit(LEADERBOARD_ENTRY_LIMIT)
			.get(),
		db
			.collection('players')
			.orderBy(`data.player.attributes.${LEADERBOARD_ATTRIBUTE_IDS.coins}.value`, 'desc')
			.limit(LEADERBOARD_ENTRY_LIMIT)
			.get(),
	]);

	function toEntries(snapshot, attrId) {
		return snapshot.docs
			.map((doc) => {
				const data = doc.data();
				const attr = data.data && data.data.player && data.data.player.attributes && data.data.player.attributes[attrId];
				return {
					username: data.username,
					value: (attr && attr.value) || 0,
				};
			})
			.filter((entry) => !!entry.username) // accounts that never claimed a username shouldn't show up on a public leaderboard
			.filter((entry) => !LEADERBOARD_EXCLUDED_USERNAMES.has(entry.username.toLowerCase()));
	}

	return {
		wins: toEntries(winsSnapshot, LEADERBOARD_ATTRIBUTE_IDS.wins),
		coins: toEntries(coinsSnapshot, LEADERBOARD_ATTRIBUTE_IDS.coins),
		computedAt: Date.now(),
	};
}

async function getLeaderboard() {
	const cacheRef = db.collection('meta').doc('leaderboard');
	const cacheDoc = await cacheRef.get();
	const cached = cacheDoc.exists ? cacheDoc.data() : null;

	if (cached && Date.now() - cached.computedAt < LEADERBOARD_CACHE_TTL_MS) {
		return cached;
	}

	if (leaderboardRefreshInFlight) {
		return leaderboardRefreshInFlight;
	}

	leaderboardRefreshInFlight = (async () => {
		try {
			const fresh = await computeLeaderboard();
			await cacheRef.set(fresh);
			return fresh;
		} finally {
			leaderboardRefreshInFlight = null;
		}
	})();

	return leaderboardRefreshInFlight;
}

module.exports = {
	getPlayerData,
	savePlayerData,
	savePersistedEntityData,
	checkBadgesLive,
	claimUsername,
	UsernameTakenError,
	getUidByUsername,
	backupPlayerData,
	importModdData,
	wipePlayerData,
	getLeaderboard,
	getSkinState,
	purchaseSkin,
	equipOwnedSkin,
	unequipSkin,
};
