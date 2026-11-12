// central badge definitions + the logic that decides whether a player has
// newly earned any of them, mirrors assets/data/badges.json
//
// badge conditions are evaluated here against the player's live attribute map
//
// game-side scripts set the small number of event flags (boss kills / zombie
// victory), while ordinary persistent attributes such as Wins and plant-owned
// flags can be checked directly

const fs = require('fs');
const path = require('path');

// same display copy
const BADGE_DISPLAY_BY_ID = (() => {
	try {
		const raw = fs.readFileSync(
			path.join(__dirname, '..', 'assets', 'data', 'badges.json'),
			'utf8'
		);
		const parsed = JSON.parse(raw);
		return (parsed.badges || []).reduce((acc, badge) => {
			acc[badge.id] = badge;
			return acc;
		}, {});
	} catch (err) {
		console.error('badges.js: failed to load assets/data/badges.json', err);
		return {};
	}
})();

function getBadgeDisplayInfo(badgeId) {
	return BADGE_DISPLAY_BY_ID[badgeId];
}

// attribute ids
const ATTR = {
	WINS: 'fKYSjs9Zw4',
	COINS: 'KAohfBnN6V',
	ZOMBIE_MODE_UNLOCKED: 'zM4hVwsPQ7',
	PLANT_BOSS_KILL: 'pBvKq7N2Lm',
	ZOMBIE_BOSS_KILL: 'zK9dP4wXcR',
	ZOMBIE_WIN: 'yM3tQ8sLhV',
	// set by the global "unit's attribute is 0" script when the Yeti Zombie
	// (ba607jTTAi) dies to a human player - and i can't believe I'm saying this but deliberately NOT the Fake Yeti
	// Zombie (3bEMMPjlgN), which must never count toward this badge
	YETI_KILL: 'VYbHrJy5Si',
	// already set in-game by Senator Zomboss's "dead" script, so this one
	// needed no game-side change - just the rule below
	CRAZY_MODE_WON: 'n1BUlF5Jqz',
	// same deal - set in-game by the Disco Zombie's embedded script
	// (unitTypes.xbM8Ft4vBX), so the badge only needed the rule below
	DISCO_MODE_WON: 'tngCfbbF9I',
	LAWN_OF_DOOM_WON: 'bLD2026Won',
};

// every "<plant>Owned?" boolean player attribute in the game
const OWNED_FLAG_IDS = [
	'uqtQLGEAGX', // gatlingOwned
	'6FrKxX6Ygo', // twinOwned
	'fsrhxCzzqD', // catOwned
	'JBknp1V5aL', // melonOwned
	'C44OGCREy5', // cobOwned
	'aauepP1xHO', // gloomOwned
	'8gkUs7TVc5', // superChompOwned
	'Owx5FrfwnP', // electroOwned
	'TbyWpHp58y', // fireOwned?
	'avftaCtZLb', // magnetOwned (Golden Magnet)
	'zO3WiVUa11', // imitaterOwned
	'87egOJ5hse', // spikerockOwned
	'1exjfklDVt', // podOwned?
	'dtsojqdxHt', // peanutOwned?
	'DmNvoAw11g', // reedOwned?
	'SavKmfObPs', // explodnutOwned?
];

function attrValue(attributes, attrId) {
	return attributes && attributes[attrId] && attributes[attrId].value;
}

// each badge's `check` receives the player's live attribute map (the same
// shape as playerDoc.data.player.attributes) and returns true once earned.
// `rewardCoins`, if present, is added to the player's Coins attribute
// exactly once, the moment the badge is granted.
const BADGE_DEFS = {
	'win-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 1,
		rewardGems: 15,
	},
	'win2-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 20,
		rewardCoins: 10000,
		rewardGems: 50,
	},
	'win3-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.WINS) || 0) >= 100,
		rewardCoins: 25000,
		rewardGems: 500,
	},
	'dave-badge': {
		check: (attrs) => OWNED_FLAG_IDS.some((id) => !!attrValue(attrs, id)),
		rewardGems: 20,
	},
	'coin-badge': {
		check: (attrs) => (attrValue(attrs, ATTR.COINS) || 0) >= 250000,
		rewardGems: 100,
	},
	'zm-badge': {
		check: (attrs) => !!attrValue(attrs, ATTR.ZOMBIE_MODE_UNLOCKED),
		rewardGems: 40,
	},
	'plant-dave-all-badge': {
		check: (attrs) => OWNED_FLAG_IDS.every((id) => Number(attrValue(attrs, id) || 0) >= 1),
		rewardGems: 75,
	},
	'plant-boss-badge': {
		check: (attrs) => !!attrValue(attrs, ATTR.PLANT_BOSS_KILL),
		rewardGems: 50,
	},
	'zm-boss-badge': {
		check: (attrs) => !!attrValue(attrs, ATTR.ZOMBIE_BOSS_KILL),
		rewardGems: 50,
	},
	'zm-win-badge': {
		check: (attrs) => !!attrValue(attrs, ATTR.ZOMBIE_WIN),
		rewardGems: 75,
	},
	'yeti-badge': {
		check: (attrs) => !!attrValue(attrs, ATTR.YETI_KILL),
		rewardGems: 75,
	},
	'crazy-badge': {
		check: (attrs) => !!attrValue(attrs, ATTR.CRAZY_MODE_WON),
		rewardGems: 100,
	},
	'disco-badge': {
		check: (attrs) => !!attrValue(attrs, ATTR.DISCO_MODE_WON),
		rewardGems: 100,
	},
	'h26-badge': {
		check: (attrs) => !!attrValue(attrs, ATTR.LAWN_OF_DOOM_WON),
		rewardGems: 250,
	},
};

// returns { badges: <updated badges map>, newlyAwarded: [ids], coinsEarned, gemsEarned }
// - never mutates the input. Call this every time you have a fresh
// attributes snapshot for a player (see savePersistedEntityData below).
function checkAndAwardBadges(existingBadges, attributes) {
	const badges = Object.assign({}, existingBadges);
	const newlyAwarded = [];
	let coinsEarned = 0;
	let gemsEarned = 0;

	for (const [badgeId, def] of Object.entries(BADGE_DEFS)) {
		if (badges[badgeId]) continue; // already have it, never re-grant
		if (def.check(attributes)) {
			// gemsPaid marks that this badge's Gems reward (if any) has already
			// been accounted for - checked by the one-time backfill script
			// (server/scripts/backfillGems.js) so it never double-pays a badge
			// that was earned normally after Gems already existed
			badges[badgeId] = { obtainedAt: Date.now(), gemsPaid: true };
			newlyAwarded.push(badgeId);
			coinsEarned += def.rewardCoins || 0;
			gemsEarned += def.rewardGems || 0;
		}
	}

	return { badges, newlyAwarded, coinsEarned, gemsEarned };
}

module.exports = { BADGE_DEFS, checkAndAwardBadges, getBadgeDisplayInfo };
