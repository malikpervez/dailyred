// The day's six for the server (the bot's card shows them), from the same
// generator and data as the battle engine in the browser
// (web/battle/worker.js uses Dex.forGen(3) too). build-battle.mjs bundles
// this into activity/dist/team-of-day.mjs, so the server image needs no npm
// packages.
import { Dex } from '@pkmn/sim';
import { generateTeam } from '../web/battle/team.js';

const dex = Dex.forGen(3);

// The species of the team for `seed` (dailySeed(date) in web/daily.js) and
// rules `version` (teamVersion(date)), in the day's order.
export const teamSpecies = (seed, version) => generateTeam(dex, seed, version).map((set) => set.species);

// The same team as { species, num, shiny }, for today's card picture.
export const teamMembers = (seed, version) => generateTeam(dex, seed, version)
  .map((set) => ({ species: set.species, num: dex.species.get(set.species).num, shiny: Boolean(set.shiny) }));
