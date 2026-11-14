// One trainer vs the same N daily teams (greedy bot on the player's side).
import { Dex, BattleStreams, Teams } from '@pkmn/sim';
import * as calc from '@smogon/calc';
import { generateTeam } from '../web/battle/team.js';
import { chooseFor, DIFFICULTY } from '../web/battle/ai.js';
import { RED_TEAM } from '../web/battle/red.js';
import { dailySeed, addDays } from '../web/daily.js';
import { TRAINERS } from '../../trainers/teams.mjs';
const dex = Dex.forGen(3);
const [who, n] = [process.argv[2], Number(process.argv[3] || 300)];
if (process.argv[4]) DIFFICULTY.MISTAKE_CHANCE = Number(process.argv[4]); // RED's side only
const foe = who === 'red' ? RED_TEAM : TRAINERS[who].team;
function play(team) {
  return new Promise((resolve, reject) => {
    const stream = new BattleStreams.BattleStream();
    const streams = BattleStreams.getPlayerStreams(stream);
    let done = false;
    const run = async (id, s) => {
      for await (const chunk of s) {
        if (chunk.startsWith('|error|')) { reject(new Error(chunk)); return; }
        const end = chunk.match(/^\|(win\|.*|tie)$/m);
        if (end && !done && id === 'p1') {
          done = true;
          const b = stream.battle;
          resolve({ won: end[1] === 'win|You', left: b.p1.pokemon.filter((p) => !p.fainted).length, redLeft: b.p2.pokemon.filter((p) => !p.fainted).length, turns: b.turn });
        }
        if (!chunk.startsWith('|request|')) continue;
        const req = JSON.parse(chunk.slice(9));
        if (!req.wait) s.write(chooseFor(id, calc, dex, stream.battle, req));
      }
    };
    run('p1', streams.p1).catch(reject);
    run('p2', streams.p2).catch(reject);
    streams.omniscient.write(`>start {"formatid":"gen3customgame"}\n>player p1 {"name":"You","team":"${Teams.pack(team)}"}\n>player p2 {"name":"Foe","team":"${Teams.pack(foe)}"}`);
  });
}
const results = [];
for (let k = 0; k < n; k++) {
  const team = generateTeam(dex, dailySeed(addDays('2026-11-14', k)), 2);
  results.push(await play(team));
}
const wins = results.filter((r) => r.won).length;
const avg = (f) => (results.reduce((a, r) => a + f(r), 0) / n).toFixed(1);
console.log(JSON.stringify({ who, n, mistakes: DIFFICULTY.MISTAKE_CHANCE, wins, rate: +(wins / n * 100).toFixed(1), koAvg: +avg((r) => 6 - r.redLeft), turns: +avg((r) => r.turns), won: results.map((r) => r.won) }));
