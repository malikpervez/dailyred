// The teams on the Road to RED (web/road.js has the schedule and names).
// This file is the one place to edit them; RED's own team is in red.js.
//
// Level 100 like RED's: perfect IVs, full EV spreads, natures that suit each
// set, and each trainer's signature Pokémon with legal Gen 3 movesets (the
// tests check them). Only moves the AI plays well: attacks, sleep / paralysis
// / poison, Rest / Recover, Leech Seed (no Dragon Dance or Swords Dance,
// which it wouldn't use).
//
// `mistakes`: how often the trainer picks a random sensible move instead of
// the best one (ai.js; RED's is DIFFICULTY.MISTAKE_CHANCE, 10%). Blue, Lance
// and Wallace slip up more often, which keeps the road climbing to RED:
// Lance's and Wallace's teams are stronger than his.
import { RED_TEAM } from './red.js';
import { DIFFICULTY } from './ai.js';

const PERFECT = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
const evs = (hp, atk, def, spa, spd, spe) => ({ hp, atk, def, spa, spd, spe });
const team = (sets) => sets.map((set) => ({ name: set.species, level: 100, ivs: PERFECT, ...set }));

export const TRAINER_TEAMS = {
  blue: {
    mistakes: 0.4,
    team: team([
      { species: 'Pidgeot', item: 'Sharp Beak', ability: 'Keen Eye', nature: 'Jolly', gender: 'M', moves: ['Return', 'Aerial Ace', 'Steel Wing', 'Quick Attack'], evs: evs(4, 252, 0, 0, 0, 252) },
      { species: 'Alakazam', item: 'Twisted Spoon', ability: 'Synchronize', nature: 'Timid', gender: 'M', moves: ['Psychic', 'Fire Punch', 'Thunder Punch', 'Recover'], evs: evs(4, 0, 0, 252, 0, 252) },
      { species: 'Rhydon', item: 'Soft Sand', ability: 'Rock Head', nature: 'Adamant', gender: 'M', moves: ['Earthquake', 'Rock Slide', 'Megahorn', 'Double-Edge'], evs: evs(252, 252, 4, 0, 0, 0) },
      { species: 'Exeggutor', item: 'Miracle Seed', ability: 'Chlorophyll', nature: 'Modest', gender: 'M', moves: ['Giga Drain', 'Psychic', 'Sleep Powder', 'Leech Seed'], evs: evs(252, 0, 0, 252, 4, 0) },
      { species: 'Gyarados', item: 'Leftovers', ability: 'Intimidate', nature: 'Adamant', gender: 'M', moves: ['Return', 'Earthquake', 'Hydro Pump', 'Thunder Wave'], evs: evs(252, 252, 0, 0, 4, 0) },
      { species: 'Arcanine', item: 'Charcoal', ability: 'Intimidate', nature: 'Hasty', gender: 'M', moves: ['Flamethrower', 'Extreme Speed', 'Iron Tail', 'Crunch'], evs: evs(0, 128, 0, 128, 0, 252) },
    ]),
  },
  lance: {
    mistakes: 0.4,
    team: team([
      { species: 'Gyarados', item: 'Leftovers', ability: 'Intimidate', nature: 'Adamant', gender: 'M', shiny: true, moves: ['Return', 'Earthquake', 'Hydro Pump', 'Thunder Wave'], evs: evs(252, 252, 0, 0, 4, 0) },
      { species: 'Aerodactyl', item: 'Hard Stone', ability: 'Rock Head', nature: 'Jolly', gender: 'M', moves: ['Rock Slide', 'Earthquake', 'Double-Edge', 'Aerial Ace'], evs: evs(4, 252, 0, 0, 0, 252) },
      { species: 'Kingdra', item: 'Leftovers', ability: 'Swift Swim', nature: 'Modest', gender: 'M', moves: ['Surf', 'Ice Beam', 'Dragon Breath', 'Rest'], evs: evs(252, 0, 0, 252, 4, 0) },
      { species: 'Dragonair', item: 'Dragon Fang', ability: 'Shed Skin', nature: 'Modest', gender: 'M', moves: ['Dragon Breath', 'Thunderbolt', 'Ice Beam', 'Thunder Wave'], evs: evs(252, 0, 0, 252, 4, 0) },
      { species: 'Altaria', item: 'Leftovers', ability: 'Natural Cure', nature: 'Modest', gender: 'M', moves: ['Dragon Claw', 'Flamethrower', 'Earthquake', 'Rest'], evs: evs(252, 0, 0, 252, 4, 0) },
      { species: 'Dragonite', item: 'Leftovers', ability: 'Inner Focus', nature: 'Naive', gender: 'M', moves: ['Earthquake', 'Dragon Claw', 'Thunderbolt', 'Ice Beam'], evs: evs(0, 128, 0, 128, 0, 252) },
    ]),
  },
  steven: {
    mistakes: DIFFICULTY.MISTAKE_CHANCE,
    team: team([
      { species: 'Skarmory', item: 'Leftovers', ability: 'Keen Eye', nature: 'Impish', gender: 'M', moves: ['Drill Peck', 'Steel Wing', 'Toxic', 'Rest'], evs: evs(252, 4, 252, 0, 0, 0) },
      { species: 'Claydol', item: 'Leftovers', ability: 'Levitate', nature: 'Modest', moves: ['Earthquake', 'Psychic', 'Ice Beam', 'Shadow Ball'], evs: evs(252, 0, 0, 252, 4, 0) },
      { species: 'Aggron', item: 'Leftovers', ability: 'Rock Head', nature: 'Adamant', gender: 'M', moves: ['Double-Edge', 'Iron Tail', 'Rock Slide', 'Earthquake'], evs: evs(252, 252, 4, 0, 0, 0) },
      { species: 'Cradily', item: 'Leftovers', ability: 'Suction Cups', nature: 'Quiet', gender: 'M', moves: ['Giga Drain', 'Rock Slide', 'Earthquake', 'Recover'], evs: evs(252, 128, 0, 128, 0, 0) },
      { species: 'Armaldo', item: 'Hard Stone', ability: 'Battle Armor', nature: 'Adamant', gender: 'M', moves: ['Rock Slide', 'Earthquake', 'Aerial Ace', 'Brick Break'], evs: evs(252, 252, 4, 0, 0, 0) },
      { species: 'Metagross', item: 'Metal Coat', ability: 'Clear Body', nature: 'Adamant', moves: ['Meteor Mash', 'Earthquake', 'Shadow Ball', 'Brick Break'], evs: evs(252, 252, 4, 0, 0, 0) },
    ]),
  },
  wallace: {
    mistakes: 0.4,
    team: team([
      { species: 'Wailord', item: 'Leftovers', ability: 'Water Veil', nature: 'Modest', gender: 'M', moves: ['Water Spout', 'Surf', 'Ice Beam', 'Rest'], evs: evs(252, 0, 0, 252, 4, 0) },
      { species: 'Tentacruel', item: 'Mystic Water', ability: 'Clear Body', nature: 'Timid', gender: 'M', moves: ['Surf', 'Ice Beam', 'Giga Drain', 'Toxic'], evs: evs(4, 0, 0, 252, 0, 252) },
      { species: 'Ludicolo', item: 'Miracle Seed', ability: 'Swift Swim', nature: 'Modest', gender: 'M', moves: ['Surf', 'Giga Drain', 'Ice Beam', 'Leech Seed'], evs: evs(252, 0, 0, 252, 4, 0) },
      { species: 'Whiscash', item: 'Soft Sand', ability: 'Oblivious', nature: 'Adamant', gender: 'M', moves: ['Earthquake', 'Surf', 'Ice Beam', 'Rest'], evs: evs(252, 252, 4, 0, 0, 0) },
      { species: 'Gyarados', item: 'Leftovers', ability: 'Intimidate', nature: 'Adamant', gender: 'M', moves: ['Double-Edge', 'Earthquake', 'Hydro Pump', 'Thunder Wave'], evs: evs(252, 252, 0, 0, 4, 0) },
      { species: 'Milotic', item: 'Leftovers', ability: 'Marvel Scale', nature: 'Modest', gender: 'F', moves: ['Surf', 'Ice Beam', 'Recover', 'Toxic'], evs: evs(252, 0, 0, 252, 4, 0) },
    ]),
  },
  giovanni: {
    mistakes: DIFFICULTY.MISTAKE_CHANCE,
    team: team([
      { species: 'Persian', item: 'Silk Scarf', ability: 'Limber', nature: 'Jolly', gender: 'M', moves: ['Return', 'Shadow Ball', 'Iron Tail', 'Hypnosis'], evs: evs(4, 252, 0, 0, 0, 252) },
      { species: 'Dugtrio', item: 'Soft Sand', ability: 'Arena Trap', nature: 'Jolly', gender: 'M', moves: ['Earthquake', 'Rock Slide', 'Aerial Ace', 'Sludge Bomb'], evs: evs(4, 252, 0, 0, 0, 252) },
      { species: 'Kangaskhan', item: 'Leftovers', ability: 'Early Bird', nature: 'Adamant', moves: ['Return', 'Earthquake', 'Shadow Ball', 'Brick Break'], evs: evs(252, 252, 4, 0, 0, 0) },
      { species: 'Nidoqueen', item: 'Poison Barb', ability: 'Poison Point', nature: 'Adamant', moves: ['Earthquake', 'Sludge Bomb', 'Superpower', 'Ice Beam'], evs: evs(252, 252, 4, 0, 0, 0) },
      { species: 'Nidoking', item: 'Soft Sand', ability: 'Poison Point', nature: 'Naive', moves: ['Earthquake', 'Megahorn', 'Ice Beam', 'Thunderbolt'], evs: evs(0, 128, 0, 128, 0, 252) },
      { species: 'Rhydon', item: 'Leftovers', ability: 'Rock Head', nature: 'Adamant', gender: 'M', moves: ['Earthquake', 'Rock Slide', 'Megahorn', 'Double-Edge'], evs: evs(252, 252, 4, 0, 0, 0) },
    ]),
  },
  red: { mistakes: DIFFICULTY.MISTAKE_CHANCE, team: RED_TEAM },
};
