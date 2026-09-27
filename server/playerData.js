// firebaseAdmin.js exports the `admin` SDK object itself with `.db` bolted on
// (see module.exports there) - not a { admin, db } object, so we grab both off
// the same import rather than destructuring.
const admin = require('./firebaseAdmin');
const { db } = admin;
const fs = require('fs');
const path = require('path');
const { checkAndAwardBadges, getBadgeDisplayInfo } = require('./badges');
const { getSkinById, isPurchasable, getEffectivePrice } = require('./skins');

// same Coins attribute id used throughout this file (see IMPORT_VALUE_CAPS
// below) - pulled out as its own constant here since savePersistedEntityData
// needs it directly to apply badge coin rewards onto a fresh attributes
// snapshot before it's saved.
const COINS_ATTR_ID = 'KAohfBnN6V';

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
// real ceiling here based on what's actually achievable through normal play

// anything not listed here just falls back to the schema's own max, which is
// effectively no cap - so add to this list whenever a new ownable/earnable
// stat is added to the game and matters for fairness.
const IMPORT_VALUE_CAPS = {
	KAohfBnN6V: 49950, // Coins
	fKYSjs9Zw4: 25, // Wins
	NbZXJa87MY: 25, // Tacos
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

// saves persisted player/unit game-state (attributes, variables, quests - the
// stuff ActionComponent's 'savePlayerData' script action builds via
// entity.getPersistentData()) under players/{uid}.data.player / .data.unit,
// without touching sibling top-level fields like username or coins.
//
// this does not use `savePlayerData(uid, { 'data.player': player })` above -
// that looks like dot-path notation but isn't. Firestore only expands dots
// into nested paths for explicit field paths (update(), or set(..., {
// mergeFields })). When merge:true computes its own mask from a plain
// object's keys, it takes each top-level key literally - db.collection(...)
// .set({ 'data.player': x }, { merge: true }) creates one real field
// literally named "data.player" (dot and all), not a nested `data.player`
// path. Reads that expect persistedData.data.player (see Player.js's
// loadPersistentData) then find persistedData.data is undefined and silently
// skip loading - which is exactly why saved data never came back.
//
// passing real FieldPath objects as `mergeFields` is what actually replaces
// the nested data.player / data.unit maps wholesale on each save, which is
// what we want here since getPersistentData() already returns a complete,
// self-contained snapshot each time - not a partial diff to deep-merge.
//
// Also the one spot badge-earning gets checked: every time a fresh player
// attributes snapshot comes in from the game server, we diff it against
// whatever badges are already recorded and award any newly-earned ones (see
// badges.js). Coin rewards, where a badge has one, are applied directly onto
// the attributes snapshot before it's saved, the same way Coins are stored
// the rest of the time. Gem rewards go onto a separate top-level `gems`
// field on the player doc instead (see checkAndAwardBadges's gemsEarned) -
// Gems isn't an in-game attribute, so it doesn't belong inside data.player.
//
// notifyBadgesUnlocked pushes the live achievement-toast event (see
// gameClasses/ClientNetworkEvents.js's 'achievementUnlocked' ui case and
// templates/achievement-toast.ejs) to the player's connected client, the same
// way sendChatMessageToPlayer / the shop / sound actions push to one client:
// taro.network.send(eventName, data, clientId). This assumes `taro` is
// reachable as a bare global from this module the same way it already is in
// server.js (taro.playerDataStore = ...) - if that assumption is wrong in
// this deployment, the try/catch below just means the toast silently doesn't
// fire while badge saving/awarding itself is unaffected. Worth confirming
// against a live badge unlock the first time.
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

// real-time badge checking
//
// this runs ALONGSIDE the existing badge-check inside savePersistedEntityData
// (still triggered every 2 minutes + on leave) rather than replacing it -
// that slower path re-reads badges fresh from Firestore each time, so it's a
// harmless safety net (catches anything this path might miss) rather than a
// source of double-awarding; checkAndAwardBadges only ever grants a badge
// once regardless of which path notices it first
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

// thrown by claimUsername() when someone else already holds that username -
// server.js catches this specifically to send back a 409 instead of a 500
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
		// Firestore transactions require ALL reads to happen before ANY writes -
		// that's why both gets are up here, before the tx.set/tx.delete calls below.
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
// where an admin targets a player by username rather than a raw Firebase uid
async function getUidByUsername(username) {
	const doc = await db.collection('usernames').doc(username.toLowerCase()).get();
	return doc.exists ? doc.data().uid : null;
}

// atomically charges `uid` for skin `skinId` and adds it to their owned
// skins - wrapped in a transaction (same pattern as claimUsername above) so
// two rapid purchase clicks (or two requests racing) can't both succeed off
// a stale gem balance, price and purchasability are never taken from the
// client - both come from skins.js, which is the only source of truth for
// what a skin actually costs and whether it's currently buyable at all
async function buySkin(uid, skinId) {
	const skin = getSkinById(skinId);
	if (!skin) {
		throw new Error('unknown skin');
	}
	if (!isPurchasable(skin)) {
		throw new Error('this skin is not currently available for purchase');
	}
	const price = getEffectivePrice(skin);
	const playerRef = db.collection('players').doc(uid);

	await db.runTransaction(async (tx) => {
		const playerDoc = await tx.get(playerRef);
		const data = playerDoc.exists ? playerDoc.data() : {};
		const ownedSkins = data.ownedSkins || [];

		if (ownedSkins.includes(skinId)) {
			throw new Error('you already own this skin');
		}
		const gems = data.gems || 0;
		if (gems < price) {
			throw new Error('not enough Gems');
		}

		tx.set(playerRef, { gems: gems - price, ownedSkins: [...ownedSkins, skinId] }, { merge: true });
	});
}

// sets (or clears, if skinId is null) which owned skin is equipped for a
// given unit type. A skin can only ever be equipped for the one unit type
// it belongs to - equippedSkins is a map from unitType -> skinId, so
// equipping a new skin for a unit type simply overwrites whatever was
// equipped there before, no separate "unequip" call needed for that case
async function equipSkinForUnitType(uid, unitType, skinId) {
	const playerRef = db.collection('players').doc(uid);

	await db.runTransaction(async (tx) => {
		const playerDoc = await tx.get(playerRef);
		const data = playerDoc.exists ? playerDoc.data() : {};
		const ownedSkins = data.ownedSkins || [];

		if (skinId !== null) {
			const skin = getSkinById(skinId);
			if (!skin) {
				throw new Error('unknown skin');
			}
			if (skin.unitType !== unitType) {
				throw new Error('this skin does not belong to that unit type');
			}
			if (!ownedSkins.includes(skinId)) {
				throw new Error('you do not own this skin');
			}
		}

		if (skinId === null) {
			// firestore's { merge: true } does not remove a nested map key just
			// because that key is absent from the object we send so We must send
			// an explicit delete sentinel for the exact equippedSkins entry.
			// FieldPath is used so unitType is treated as one literal map key
			// even if its id ever contains characters meaningful to Firestore
			// field-path parsing
			tx.update(
				playerRef,
				new admin.firestore.FieldPath('equippedSkins', unitType),
				admin.firestore.FieldValue.delete()
			);
		} else {
			const equippedSkins = Object.assign({}, data.equippedSkins || {});
			equippedSkins[unitType] = skinId;
			tx.set(playerRef, { equippedSkins }, { merge: true });
		}
	});
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

// converts a raw modd.io/indie.fun "Platform Data" export (the JSON a player
// gets from that game's "View Save Data" button on their own account page)
// into the { attributes, variables } shape this engine already reads/writes
// under players/{uid}.data.player - see getPersistentData/loadPersistentData
// in engine/core/TaroEntity.js. Only the `.player` block is migrated - the
// `.unit` block (health, speed, inventory) is intentionally dropped, since
// that's session state that isn't meant to be persisted long-term anyway.
//
// IMPORTANT: this is the one place in the app where a player's own raw JSON
// gets treated as trusted persisted data, so it can't just be passed
// through. Two separate problems get fixed here, not one:
//
// 1. obviously, someone could just hand-edit "value" to whatever they want
// 2. less obviously: loadPersistentData() in TaroEntity.js applies whatever
//    "min"/"max" the saved data claims BEFORE clamping "value" to that same
//    min/max - so a pasted {"min":0,"max":999999999,"value":999999999}
//    would sail straight through that clamp too, since the clamp is being
//    checked against attacker-supplied bounds so rebuilding min/max here from
//    the game's own trusted schema (instead of copying whatever the pasted
//    JSON claims) closes that off regardless of what the export contains
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

// lb
const LEADERBOARD_ATTRIBUTE_IDS = {
	wins: 'fKYSjs9Zw4', // Wins
	coins: 'KAohfBnN6V', // Coins
};
const LEADERBOARD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // one week
const LEADERBOARD_ENTRY_LIMIT = 50;

// usernames that should never show up on the public leaderboard - dev/test
// accounts, admin accounts used for debugging, that kind of thing. Matched
// case-insensitively so "TestAccount12345" and "testaccount12345" are both
// caught by one entry. Add to this list as needed; it only affects the
// leaderboard display, not the accounts themselves - they keep their real
// Wins/Coins, they just don't get ranked publicly.
const LEADERBOARD_EXCLUDED_USERNAMES = new Set(
  ['testaccount12345',' testaccount12378', 'testaccount1', 'testaccount2', 'testaccount3', 'testaccount4', 'testaccount5'].map((name) => name.toLowerCase())
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

	// firestore's orderBy on a nested field automatically excludes any
	// document that doesn't have that field at all, so accounts that have
	// never earned a Win/Coin simply won't appear in that particular
	// leaderboard - which is the behavior we want here anyway
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
	buySkin,
	equipSkinForUnitType,
	backupPlayerData,
	importModdData,
	wipePlayerData,
	getLeaderboard,
};
