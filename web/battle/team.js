// The day's team: six random level 100 Pokémon, the same for everyone with
// the same seed. Ported from the FireRed version's generator
// (pokefirered/src/dailyred_team.c in earlier versions of this repository),
// using Pokémon Showdown's Gen 3 data instead of the ROM's.
//
// Rules:
//   - 6 different species out of the 386 Gen 1-3 Pokémon, whose base stat
//     totals add up to at least TEAM_RULES.MIN_TEAM_BASE_STAT_TOTAL. 1 team in
//     LEGENDARY_TEAM_ODDS includes exactly one legendary; the rest have none.
//   - Level 100 with a random personality (so random gender, ability and the
//     normal 1/8192 shiny chance), random IVs from TEAM_RULES.MIN_TEAM_IV to 31, EVs
//     focused on its two best stats (see focusedEVs) and a nature that suits
//     how it attacks, close to RED's perfect IVs and hand-picked spreads.
//   - A real moveset (see pickMoves), drawn from what the species can learn in
//     Gen 3 by level-up, TM/HM or move tutor: its best attacks of its own types,
//     attacks of other types for coverage, and sometimes one support move
//     (sleep, paralysis, a stat boost, healing). The FireRed version picked 4
//     moves at random, which mostly left the player no way to beat RED.
//   - One held item. Version 2 of these rules (teams from No. 14, see
//     teamVersion in web/daily.js): the species' own item from the
//     researched table in held-items.js, always the same for it, and a Choice
//     Band holder only gets attacks. Version 1 (up to No. 13): picked at random from BATTLE_ITEMS
//     plus the type-boosting items for the types of its own attacking moves.
//
// The Showdown data (`dex`, Dex.forGen(3) from @pkmn/sim) is passed in, so
// this file (and held-items.js, its one import) runs in the browser worker
// and in Node tests.

import { HELD_ITEMS } from './held-items.js';

export const LEVEL = 100;
const MAX_STAT_EVS = 252;
const MAX_TOTAL_EVS = 510;
const MAX_SPECIES_ATTEMPTS = 1000;
const MAX_TEAM_ATTEMPTS = 1000;

// How strong the six are. MIN_TEAM_BASE_STAT_TOTAL is the least the six's
// base stat totals may add up to: RED's team adds up to 2954, a fully random
// team averages about 2430. IVs are random from MIN_TEAM_IV to 31 (RED's are
// all 31). Raise either to make the game easier.
export const TEAM_RULES = { MIN_TEAM_BASE_STAT_TOTAL: 2900, MIN_TEAM_IV: 28 };

// Legendaries average a base stat total of 613 against 393 for everything
// else, so the minimum above would put one in most teams. Instead 1 team in
// LEGENDARY_TEAM_ODDS gets exactly one, and the rest none.
const LEGENDARY_TEAM_ODDS = 8;

const LEGENDARIES = [
  'articuno', 'zapdos', 'moltres', 'mewtwo', 'mew',
  'raikou', 'entei', 'suicune', 'lugia', 'hooh', 'celebi',
  'regirock', 'regice', 'registeel', 'latias', 'latios',
  'kyogre', 'groudon', 'rayquaza', 'jirachi', 'deoxys',
];

// FireRed's Deoxys is its Attack Forme.
const FORME_FOR = { deoxys: 'deoxysattack' };

// Held items that help any Pokémon in a single battle.
const BATTLE_ITEMS = [
  'leftovers', 'shellbell', 'choiceband', 'quickclaw', 'kingsrock', 'scopelens',
  'brightpowder', 'focusband', 'whiteherb', 'mentalherb', 'lumberry', 'sitrusberry',
  'chestoberry', 'liechiberry', 'salacberry', 'petayaberry',
];

// The item that boosts moves of each type by 10%.
const TYPE_BOOST_ITEMS = {
  Normal: 'silkscarf', Fighting: 'blackbelt', Flying: 'sharpbeak', Poison: 'poisonbarb',
  Ground: 'softsand', Rock: 'hardstone', Bug: 'silverpowder', Ghost: 'spelltag',
  Steel: 'metalcoat', Fire: 'charcoal', Water: 'mysticwater', Grass: 'miracleseed',
  Electric: 'magnet', Psychic: 'twistedspoon', Ice: 'nevermeltice', Dragon: 'dragonfang',
  Dark: 'blackglasses',
};

// The item a species always holds (team rules version 2): the same every
// day, from the researched table in held-items.js. A Choice Band holder only
// gets attacks (see pickMoves).
export function heldItemFor(dex, speciesId) {
  const species = dex.species.get(speciesId);
  return HELD_ITEMS[species.id] ?? HELD_ITEMS[dex.species.get(species.baseSpecies).id] ?? 'leftovers';
}

// In Gen 3 a move's type decides whether it's physical or special.
const PHYSICAL_TYPES = new Set(['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel']);
export const isPhysicalType = (type) => PHYSICAL_TYPES.has(type);

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
// When two stats have the same base value, the one listed first gets the EVs.
const EV_STAT_PRIORITY = ['atk', 'spa', 'spe', 'hp', 'def', 'spd'];

// The Gen 3 games' random number generator, with its own state so a seed
// always gives the same team.
export function createRng(seed) {
  let state = seed >>> 0;
  const next16 = () => {
    state = (Math.imul(state, 1103515245) + 24691) >>> 0;
    return state >>> 16;
  };
  return {
    next16,
    next32: () => (next16() | (next16() << 16)) >>> 0,
    below: (n) => next16() % n,
  };
}

const baseStatTotal = (species) => STATS.reduce((sum, s) => sum + species.baseStats[s], 0);

// Moves that deal damage but whose power isn't a number the type items or the
// attacking stats affect (Seismic Toss, Hidden Power, Return, Counter...).
const hasFixedPower = (move) => move.category !== 'Status' && move.basePower <= 1;

function speciesList(dex) {
  return dex.species.all()
    .filter((s) => s.exists && s.num >= 1 && s.num <= 386 && !s.forme)
    .sort((a, b) => a.num - b.num)
    .map((s) => s.id);
}

function pickSpecies(dex, rng, ids, taken) {
  for (let i = 0; i < MAX_SPECIES_ATTEMPTS; i++) {
    const id = ids[rng.below(ids.length)];
    if (!LEGENDARIES.includes(id) && !taken.includes(id)) return id;
  }
  return ids.find((id) => !LEGENDARIES.includes(id) && !taken.includes(id));
}

function pickTeamSpecies(dex, rng) {
  const ids = speciesList(dex);
  const species = [];
  let first = 0;
  if (rng.below(LEGENDARY_TEAM_ODDS) === 0) species[first++] = LEGENDARIES[rng.below(LEGENDARIES.length)];

  let best = null;
  let bestTotal = 0;
  for (let attempt = 0; attempt < MAX_TEAM_ATTEMPTS; attempt++) {
    let total = 0;
    for (let i = 0; i < 6; i++) {
      if (i >= first) species[i] = pickSpecies(dex, rng, ids, species.slice(0, i));
      total += baseStatTotal(dex.species.get(species[i]));
    }
    if (total >= TEAM_RULES.MIN_TEAM_BASE_STAT_TOTAL) {
      best = null;
      break;
    }
    if (total > bestTotal) {
      bestTotal = total;
      best = species.slice();
    }
  }
  const team = best ?? species;
  // The legendary (if any) goes in a random slot rather than the lead.
  const slot = rng.below(6);
  [team[0], team[slot]] = [team[slot], team[0]];
  return team.map((id) => FORME_FOR[id] ?? id);
}

// Every move the species can learn in Gen 3 by level-up, TM/HM or tutor.
export function learnableMoves(dex, speciesId) {
  const species = dex.species.get(speciesId);
  // Formes (Deoxys-Attack) share the base species' learnset.
  const learnset = dex.species.getLearnsetData(species.id)?.learnset;
  const data = learnset && Object.keys(learnset).length
    ? learnset
    : dex.species.getLearnsetData(dex.toID(species.baseSpecies))?.learnset ?? {};
  return Object.keys(data)
    .filter((id) => data[id].some((src) => /^3[LMT]/.test(src)))
    .filter((id) => dex.moves.get(id).exists)
    .sort();
}

// Attacks that look strong on paper but don't work in a straight battle
// (charging, recharging or self-KO moves, OHKO gambles, moves that need
// something else to work).
const AWKWARD_ATTACKS = new Set([
  'solarbeam', 'skyattack', 'razorwind', 'skullbash', 'hyperbeam', 'blastburn', 'hydrocannon',
  'frenzyplant', 'explosion', 'selfdestruct', 'focuspunch', 'dreameater', 'snore', 'fakeout',
  'frustration', 'bide', 'counter', 'mirrorcoat', 'endeavor', 'flail', 'reversal', 'lowkick',
  'fissure', 'guillotine', 'horndrill', 'sheercold', 'spitup', 'naturepower', 'secretpower',
  'present', 'magnitude', 'beatup', 'struggle', 'hiddenpower', 'uproar', 'rollout', 'iceball',
  'furycutter', 'triplekick', 'superfang', 'psywave', 'sonicboom', 'dragonrage', 'focusenergy',
  'fly', 'dig', 'dive', 'bounce',
]);

// Support moves worth a slot, with how much they're worth.
const SUPPORT_MOVES = {
  spore: 10, sleeppowder: 8, hypnosis: 5, lovelykiss: 6, sing: 3, grasswhistle: 3,
  thunderwave: 7, stunspore: 6, glare: 7, toxic: 6, willowisp: 6,
  swordsdance: 8, dragondance: 9, bulkup: 7, calmmind: 8, curse: 5, agility: 4,
  recover: 8, softboiled: 8, milkdrink: 8, slackoff: 8, moonlight: 6, morningsun: 6, synthesis: 6,
  leechseed: 5, substitute: 3, reflect: 3, lightscreen: 3,
};
const PHYSICAL_SETUP = new Set(['swordsdance', 'dragondance', 'bulkup', 'curse']);
const SPECIAL_SETUP = new Set(['calmmind']);
// Fixed damage (100 at level 100): useful for weak attackers.
const FIXED_DAMAGE = new Set(['seismictoss', 'nightshade']);

// How hard a damaging move hits for this species, roughly: power x accuracy x
// same-type bonus x its attacking stat for that move's type.
function attackValue(dex, species, move) {
  const physical = isPhysicalType(move.type);
  const stat = physical ? species.baseStats.atk : species.baseStats.spa;
  if (FIXED_DAMAGE.has(move.id)) return 95;
  let power = move.basePower;
  if (move.multihit) power *= Array.isArray(move.multihit) ? 3 : move.multihit;
  if (move.id === 'return') power = 102;
  const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
  const stab = species.types.includes(move.type) ? 1.5 : 1;
  const priority = move.priority > 0 ? 0.85 : 1;
  const recoil = move.recoil ? 0.85 : 1;
  return (power * accuracy * stab * priority * recoil * stat) / 100;
}

// Picks one of the first few candidates, the best ones likelier.
function pickWeighted(rng, candidates, top = 3) {
  const pool = candidates.slice(0, top);
  if (!pool.length) return null;
  const weights = pool.map((_, i) => top - i);
  let roll = rng.below(weights.reduce((a, b) => a + b, 0));
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll < 0) return pool[i];
  }
  return pool[0];
}

// A moveset for the species: its best attacks of its own types, then attacks
// that hit types the others don't, and (sometimes) one support move.
// `attacksOnly`: for a Choice Band holder, four attacks (physical ones, which
// the Band boosts, when it has enough) and no support move, so it can't be
// locked into one.
function pickMoves(dex, rng, speciesId, { attacksOnly = false } = {}) {
  const species = dex.species.get(speciesId);
  const all = learnableMoves(dex, speciesId).map((id) => dex.moves.get(id));
  let attacks = all
    .filter((m) => m.category !== 'Status' && !AWKWARD_ATTACKS.has(m.id))
    .filter((m) => m.basePower >= 50 || FIXED_DAMAGE.has(m.id) || m.multihit)
    .map((m) => ({ move: m, value: attackValue(dex, species, m) }))
    .sort((a, b) => b.value - a.value || a.move.id.localeCompare(b.move.id));
  if (attacksOnly) {
    const physical = attacks.filter((a) => isPhysicalType(a.move.type) && !FIXED_DAMAGE.has(a.move.id));
    if (physical.length >= 4) attacks = physical;
  }
  const support = all
    .filter((m) => SUPPORT_MOVES[m.id])
    .sort((a, b) => SUPPORT_MOVES[b.id] - SUPPORT_MOVES[a.id] || a.id.localeCompare(b.id));

  const chosen = [];
  const coveredTypes = new Set();
  const add = (move) => {
    chosen.push(move);
    if (move.category !== 'Status') coveredTypes.add(move.type);
  };

  // 1. Same-type attacks: the best of each of its types.
  for (const type of species.types) {
    const pick = pickWeighted(rng, attacks.filter((a) => a.move.type === type), 2);
    if (pick && chosen.length < 2) add(pick.move);
  }
  // 2. One support move, about 40% of the time (more for frail attackers' setup).
  const wantsSupport = !attacksOnly && support.length && rng.below(100) < 40;
  const supportSlots = wantsSupport ? 1 : 0;
  // 3. Coverage: attacks of new types, strongest first.
  while (chosen.length < 4 - supportSlots) {
    const fresh = attacks.filter((a) => !chosen.includes(a.move) && !coveredTypes.has(a.move.type));
    const pick = pickWeighted(rng, fresh.length ? fresh : attacks.filter((a) => !chosen.includes(a.move)), 3);
    if (!pick) break;
    add(pick.move);
  }
  if (wantsSupport) {
    const physical = chosen.filter((m) => m.category !== 'Status' && isPhysicalType(m.type)).length;
    const special = chosen.filter((m) => m.category !== 'Status' && !isPhysicalType(m.type)).length;
    const fits = support.filter((m) => !(PHYSICAL_SETUP.has(m.id) && physical < 2) && !(SPECIAL_SETUP.has(m.id) && special < 2));
    const pick = pickWeighted(rng, fits, 3);
    if (pick) add(pick);
  }
  // Short of four (few attacks to learn): fill with the best support moves.
  for (const move of attacksOnly ? [] : support) {
    if (chosen.length >= 4) break;
    if (!chosen.includes(move)) add(move);
  }
  // Still nothing (Smeargle, Unown, Ditto, Wobbuffet...): whatever it can learn.
  for (const move of all) {
    if (chosen.length >= 4) break;
    if (!chosen.includes(move)) add(move);
  }
  return chosen.map((m) => m.id);
}

// Natures that raise what it uses and lower what it doesn't.
const NATURES_FOR = {
  physical: ['Adamant', 'Jolly'],
  special: ['Modest', 'Timid'],
  mixed: ['Hasty', 'Naive', 'Lonely', 'Mild'],
  none: ['Bold', 'Calm', 'Impish', 'Careful'],
};

function pickNature(dex, rng, moveIds) {
  let physical = false;
  let special = false;
  for (const id of moveIds) {
    const move = dex.moves.get(id);
    if (move.category === 'Status' || hasFixedPower(move)) continue;
    if (isPhysicalType(move.type)) physical = true;
    else special = true;
  }
  const kind = physical && special ? 'mixed' : physical ? 'physical' : special ? 'special' : 'none';
  const options = NATURES_FOR[kind];
  return options[rng.below(options.length)];
}

function pickItem(dex, rng, moveIds) {
  const items = BATTLE_ITEMS.slice();
  for (const id of moveIds) {
    const move = dex.moves.get(id);
    if (move.category === 'Status' || hasFixedPower(move)) continue;
    const item = TYPE_BOOST_ITEMS[move.type];
    if (item && !items.includes(item)) items.push(item);
  }
  return items[rng.below(items.length)];
}

// 252 EVs into each of the two highest base stats and the last 6 into HP (or
// the third-best stat if HP is one of the two). Attack and Sp. Atk only count
// if one of its attacks uses them.
export function focusedEVs(dex, speciesId, moveIds) {
  const base = dex.species.get(speciesId).baseStats;
  const usable = { hp: true, atk: false, def: true, spa: false, spd: true, spe: true };
  for (const id of moveIds) {
    const move = dex.moves.get(id);
    if (move.category === 'Status' || hasFixedPower(move)) continue;
    usable[isPhysicalType(move.type) ? 'atk' : 'spa'] = true;
  }
  const order = EV_STAT_PRIORITY.filter((s) => usable[s]);
  order.sort((a, b) => base[b] - base[a]); // stable: ties keep the priority order
  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  evs[order[0]] = MAX_STAT_EVS;
  evs[order[1]] = MAX_STAT_EVS;
  evs[order[0] !== 'hp' && order[1] !== 'hp' ? 'hp' : order[2]] = MAX_TOTAL_EVS - 2 * MAX_STAT_EVS;
  return evs;
}

// Gen 3 decides gender from the personality's low byte: female below the
// species' ratio byte (31 for 12.5% female, 63, 127, 191; always female or
// male at the ends).
function genderFor(species, personality) {
  if (species.gender) return species.gender;
  const female = species.genderRatio.F;
  if (female >= 1) return 'F';
  if (female <= 0) return 'M';
  return (personality & 0xFF) < Math.round(female * 256) - 1 ? 'F' : 'M';
}

// A Showdown team set (name, species, item, ability, moves, nature, gender,
// evs, ivs, level, shiny).
function makeSet(dex, rng, speciesId, trainerId, version) {
  const species = dex.species.get(speciesId);
  const personality = rng.next32();
  const fixedItem = version >= 2 ? heldItemFor(dex, speciesId) : null;
  const moves = pickMoves(dex, rng, speciesId, { attacksOnly: fixedItem === 'choiceband' });
  const ivs = {};
  for (const s of STATS) ivs[s] = TEAM_RULES.MIN_TEAM_IV + rng.below(31 - TEAM_RULES.MIN_TEAM_IV + 1);
  const item = fixedItem ?? pickItem(dex, rng, moves);
  const nature = pickNature(dex, rng, moves);
  const abilities = Object.values(species.abilities).filter(Boolean);
  const shinyValue = (trainerId >>> 16) ^ (trainerId & 0xFFFF) ^ (personality >>> 16) ^ (personality & 0xFFFF);
  return {
    name: species.baseSpecies,
    species: species.name,
    item: dex.items.get(item).name,
    ability: abilities[abilities.length > 1 ? personality & 1 : 0],
    moves: moves.map((id) => dex.moves.get(id).name),
    nature,
    gender: genderFor(species, personality),
    evs: focusedEVs(dex, speciesId, moves),
    ivs,
    level: LEVEL,
    shiny: shinyValue < 8,
  };
}

// The newest version of these rules (see the top of this file).
export const TEAM_VERSION = 2;

// Six Showdown sets for this seed, the lead first. `version` picks the rules
// the day's team was made with (teamVersion in web/daily.js), so a change
// never alters a day that's already been played.
export function generateTeam(dex, seed, version = TEAM_VERSION) {
  const rng = createRng(seed);
  const trainerId = rng.next32();
  return pickTeamSpecies(dex, rng).map((id) => makeSet(dex, rng, id, trainerId, version));
}

// Level 100 stats for a set, as the battle will have them.
export function statsFor(dex, set) {
  const species = dex.species.get(set.species);
  const nature = dex.natures.get(set.nature);
  const stats = {};
  for (const s of STATS) {
    const core = Math.floor(((2 * species.baseStats[s] + set.ivs[s] + Math.floor(set.evs[s] / 4)) * set.level) / 100);
    if (s === 'hp') {
      stats.hp = species.id === 'shedinja' ? 1 : core + set.level + 10;
    } else {
      const mod = nature.plus === s ? 1.1 : nature.minus === s ? 0.9 : 1;
      stats[s] = Math.floor((core + 5) * mod);
    }
  }
  return stats;
}
