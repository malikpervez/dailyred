// A Pokémon's set as the game's summary screens show it: its moves (type,
// power, accuracy, PP, what they do), item, ability, nature and level 100
// stats. Used by the battle engine (worker.js) and by the Cup's draft
// (activity/cup-engine.mjs), with Showdown's Gen 3 data passed in.
import { statsFor, isPhysicalType } from './team.js';
import { itemHelp } from './items.js';

export function describeMove(dex, name, set) {
  const move = dex.moves.get(name);
  const type = move.id === 'hiddenpower' ? hiddenPowerType(set.ivs) : move.type;
  return {
    name: move.name,
    type,
    category: move.category === 'Status' ? 'Status' : isPhysicalType(type) ? 'Physical' : 'Special',
    power: move.basePower || null,
    accuracy: move.accuracy === true ? null : move.accuracy,
    pp: Math.floor(move.pp * 8 / 5), // 3 PP Ups, like the FireRed version's teams
    desc: move.shortDesc,
  };
}

// Gen 3 Hidden Power type from the IVs.
export function hiddenPowerType(ivs) {
  const types = ['Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
    'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];
  const bit = (s, n) => (ivs[s] >> n) & 1;
  const index = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'].reduce((sum, s, i) => sum + (bit(s, 0) << i), 0);
  return types[Math.floor((index * 15) / 63)];
}

export function describeSet(dex, set) {
  const species = dex.species.get(set.species);
  return {
    species: species.name,
    num: species.num,
    types: species.types,
    item: set.item,
    ability: set.ability,
    abilityDesc: dex.abilities.get(set.ability).shortDesc,
    itemDesc: itemHelp(dex.items.get(set.item)),
    nature: set.nature,
    gender: set.gender || species.gender || '',
    shiny: Boolean(set.shiny),
    level: set.level,
    stats: statsFor(dex, set),
    baseStats: species.baseStats,
    moves: set.moves.map((m) => describeMove(dex, m, set)),
  };
}
