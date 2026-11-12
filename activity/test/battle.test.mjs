// Tests for the battle engine's rules (web/battle/): the daily team, RED's
// team and RED's AI, run on Pokémon Showdown's simulator in Node.
//   cd activity && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dex, BattleStreams, Teams, TeamValidator } from '@pkmn/sim';
import * as calc from '@smogon/calc';
import { generateTeam, statsFor, learnableMoves, TEAM_RULES } from '../../web/battle/team.js';
import { RED_TEAM } from '../../web/battle/red.js';
import { chooseFor } from '../../web/battle/ai.js';

const dex = Dex.forGen(3);
const total = (set) => Object.values(dex.species.get(set.species).baseStats).reduce((a, b) => a + b, 0);

test('the same seed always gives the same team', () => {
  assert.deepEqual(generateTeam(dex, 20261112), generateTeam(dex, 20261112));
  assert.notDeepEqual(generateTeam(dex, 20261112), generateTeam(dex, 20261113));
});

test('teams follow the rules', () => {
  const validator = new TeamValidator('gen3customgame');
  for (let seed = 1; seed <= 300; seed++) {
    const team = generateTeam(dex, seed);
    assert.equal(team.length, 6);
    assert.equal(new Set(team.map((s) => s.species)).size, 6, `seed ${seed}: repeated species`);
    assert.ok(team.reduce((sum, s) => sum + total(s), 0) >= TEAM_RULES.MIN_TEAM_BASE_STAT_TOTAL, `seed ${seed}: too weak`);
    for (const set of team) {
      assert.equal(set.level, 100);
      assert.ok(set.moves.length >= 1 && set.moves.length <= 4, `${set.species}: ${set.moves}`);
      assert.equal(new Set(set.moves).size, set.moves.length, `${set.species}: repeated move`);
      assert.ok(dex.items.get(set.item).exists, `${set.species}: ${set.item}`);
      assert.ok(Object.values(set.evs).reduce((a, b) => a + b, 0) <= 510);
      for (const iv of Object.values(set.ivs)) assert.ok(iv >= TEAM_RULES.MIN_TEAM_IV && iv <= 31);
      const learnable = new Set(learnableMoves(dex, set.species));
      for (const move of set.moves) assert.ok(learnable.has(dex.toID(move)), `${set.species} can't learn ${move}`);
    }
    assert.equal(validator.validateTeam(team), null, `seed ${seed}`);
  }
});

test('Pokémon that can attack get at least two attacks', () => {
  for (let seed = 1; seed <= 200; seed++) {
    for (const set of generateTeam(dex, seed)) {
      const attacks = learnableMoves(dex, set.species).filter((id) => dex.moves.get(id).basePower >= 60);
      if (attacks.length < 4) continue;
      const chosen = set.moves.filter((m) => dex.moves.get(m).category !== 'Status');
      assert.ok(chosen.length >= 2, `seed ${seed} ${set.species}: ${set.moves}`);
    }
  }
});

test("RED's team is legal Gen 3 and level 100 with perfect IVs", () => {
  assert.equal(RED_TEAM.length, 6);
  assert.equal(new TeamValidator('gen3customgame').validateTeam(RED_TEAM), null);
  assert.deepEqual(RED_TEAM.map((s) => s.species), ['Pikachu', 'Espeon', 'Snorlax', 'Venusaur', 'Charizard', 'Blastoise']);
  for (const set of RED_TEAM) assert.deepEqual(Object.values(set.ivs), [31, 31, 31, 31, 31, 31]);
  assert.equal(statsFor(dex, RED_TEAM[2]).hp, 524); // Snorlax: 252 HP EVs
});

// Plays a whole battle with chooseFor() on both sides; resolves to the winner.
function playOut(seed) {
  return new Promise((resolve, reject) => {
    const stream = new BattleStreams.BattleStream();
    const streams = BattleStreams.getPlayerStreams(stream);
    const timer = setTimeout(() => reject(new Error(`seed ${seed}: battle stalled`)), 20000);
    const play = async (id, s) => {
      for await (const chunk of s) {
        if (chunk.startsWith('|error|')) reject(new Error(`seed ${seed} ${id}: ${chunk}`));
        const end = chunk.match(/^\|(win\|.*|tie)$/m);
        if (end && id === 'p1') {
          clearTimeout(timer);
          resolve(end[1] === 'tie' ? '' : end[1].slice(4));
        }
        if (!chunk.startsWith('|request|')) continue;
        const request = JSON.parse(chunk.slice(9));
        if (!request.wait) s.write(chooseFor(id, calc, dex, stream.battle, request));
      }
    };
    play('p1', streams.p1).catch(reject);
    play('p2', streams.p2).catch(reject);
    const player = (name, team) => JSON.stringify({ name, team: Teams.pack(team) });
    streams.omniscient.write(`>start {"formatid":"gen3customgame"}\n>player p1 ${player('Player', generateTeam(dex, seed))}\n>player p2 ${player('RED', RED_TEAM)}`);
  });
}

test('battles with the AI on both sides always finish', async () => {
  const results = [];
  for (let seed = 1; seed <= 25; seed++) results.push(await playOut(seed * 104729));
  assert.equal(results.length, 25);
  for (const winner of results) assert.ok(['Player', 'RED', ''].includes(winner));
});
