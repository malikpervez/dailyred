// RED's team. This file is the one place to edit it.
//
// Species and order follow Red's Mt. Silver team from HeartGold/SoulSilver.
// Movesets are adapted to moves that exist in Gen 3, and every Pokémon is
// level 100 with perfect IVs and a full EV spread (the same team the FireRed
// version used, with natures that suit each set).

const PERFECT = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const evs = (hp, atk, def, spa, spd, spe) => ({ hp, atk, def, spa, spd, spe });

export const RED_TEAM = [
  {
    species: 'Pikachu', item: 'Light Ball', ability: 'Static', nature: 'Hasty', gender: 'M',
    moves: ['Volt Tackle', 'Thunderbolt', 'Iron Tail', 'Quick Attack'],
    evs: evs(0, 124, 0, 132, 0, 252),
  },
  {
    species: 'Espeon', item: 'Twisted Spoon', ability: 'Synchronize', nature: 'Timid', gender: 'M',
    moves: ['Psychic', 'Shadow Ball', 'Calm Mind', 'Morning Sun'],
    evs: evs(4, 0, 0, 252, 0, 252),
  },
  {
    species: 'Snorlax', item: 'Leftovers', ability: 'Thick Fat', nature: 'Adamant', gender: 'M',
    moves: ['Body Slam', 'Earthquake', 'Shadow Ball', 'Rest'],
    evs: evs(252, 252, 4, 0, 0, 0),
  },
  {
    species: 'Venusaur', item: 'Miracle Seed', ability: 'Overgrow', nature: 'Modest', gender: 'M',
    moves: ['Giga Drain', 'Sludge Bomb', 'Sleep Powder', 'Leech Seed'],
    evs: evs(252, 0, 0, 252, 0, 4),
  },
  {
    species: 'Charizard', item: 'Charcoal', ability: 'Blaze', nature: 'Timid', gender: 'M',
    moves: ['Flamethrower', 'Dragon Claw', 'Earthquake', 'Aerial Ace'],
    evs: evs(0, 4, 0, 252, 0, 252),
  },
  {
    species: 'Blastoise', item: 'Mystic Water', ability: 'Torrent', nature: 'Modest', gender: 'M',
    moves: ['Surf', 'Ice Beam', 'Earthquake', 'Hydro Cannon'],
    evs: evs(252, 0, 0, 252, 0, 4),
  },
].map((set) => ({ name: set.species, level: 100, ivs: PERFECT, ...set }));
