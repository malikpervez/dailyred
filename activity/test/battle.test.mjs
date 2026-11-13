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

test('every item a team can hold, and RED\'s, has a plain description', async () => {
  const { itemHelp } = await import('../../web/battle/items.js');
  const dex = Dex.forGen(3);
  const items = new Set(RED_TEAM.map((s) => s.item));
  for (let seed = 1; seed <= 400; seed++) for (const set of generateTeam(dex, seed)) items.add(set.item);
  for (const name of items) {
    const item = dex.items.get(name);
    const help = itemHelp(item);
    assert.ok(help, `${name} has a description`);
    assert.notEqual(help, item.shortDesc, `${name}: our own words, not Showdown's ("${item.shortDesc}")`);
  }
  assert.match(itemHelp(dex.items.get('choiceband')), /locked into the first move it uses\. Switch it out/);
});

// Runs the bundled battle engine (web/vendor/battle-worker.js, `npm run build`)
// as the page does, and plays it with a simple player.
async function runWorker({ seed, answerShift, maxMessages = 20000 }) {
  const { readFileSync, existsSync } = await import('node:fs');
  const vm = await import('node:vm');
  const file = new URL('../../web/vendor/battle-worker.js', import.meta.url);
  if (!existsSync(file)) return null;
  const inbox = [];
  let wake = null;
  const context = vm.createContext({
    postMessage: (message) => { inbox.push(structuredClone(message)); wake?.(); },
    console, setTimeout, clearTimeout, setImmediate, queueMicrotask, TextEncoder, TextDecoder, structuredClone,
  });
  vm.runInContext(readFileSync(file, 'utf8'), context);
  const send = (data) => context.onmessage({ data });
  const next = async () => {
    while (!inbox.length) await new Promise((ok) => { wake = ok; });
    return inbox.shift();
  };
  const log = [];
  send({ type: 'start', seed, order: [0, 1, 2, 3, 4, 5], name: 'Tester' });
  for (let i = 0; i < maxMessages; i++) {
    const message = await next();
    if (message.type === 'error') throw new Error(message.message);
    if (message.type === 'end') return { log, won: message.won };
    if (message.type === 'events') log.push(...message.events.filter((e) => e.text).map((e) => e.text));
    if (message.type !== 'request') continue;
    const req = message.request;
    if (req.kind === 'shift') {
      log.push({ shift: req });
      send({ type: 'choose', choice: answerShift(req) });
    } else if (req.kind === 'switch') {
      send({ type: 'choose', choice: `switch ${req.party.find((p) => !p.active && p.status !== 'fnt').slot}` });
    } else if (req.kind === 'move') {
      log.push({ move: req.species });
      const usable = req.moves.filter((m) => !m.disabled);
      const best = usable.find((m) => m.effect === 'super') ?? usable.find((m) => m.power) ?? usable[0];
      send({ type: 'choose', choice: `move ${best.slot}` });
    }
  }
  throw new Error('the battle never ended');
}

test('Shift: after RED loses a Pokémon you may switch for free before his next one comes out', async () => {
  let checked = 0;
  for (let seed = 1; seed <= 40 && checked < 3; seed++) {
    let picked = null;
    const result = await runWorker({
      seed,
      answerShift: (req) => {
        if (picked) return 'stay'; // switch at the first chance only
        const mon = req.party.find((p) => !p.active && p.status !== 'fnt');
        picked = { name: mon.species, from: req.party.find((p) => p.active).species, next: req.next };
        return `switch ${mon.slot}`;
      },
    });
    if (result === null) return; // battle engine not built here
    const at = result.log.findIndex((entry) => entry.shift);
    if (at < 0 || !picked) continue;
    const after = result.log.slice(at + 1);
    const nextMove = after.findIndex((entry) => entry.move);
    const between = after.slice(0, nextMove).filter((t) => typeof t === 'string');
    assert.equal(after[nextMove].move, picked.name, `${picked.name} is out and choosing a move`);
    assert.ok(between.some((t) => t.includes(picked.name)), `the log shows ${picked.name} coming in: ${between.join(' / ')}`);
    assert.ok(between.some((t) => t.includes(picked.next)), `and RED's ${picked.next}`);
    assert.ok(!between.some((t) => / used /.test(t)), `no attacks before you choose again: ${between.join(' / ')}`);
    checked++;
  }
  assert.ok(checked >= 1, 'at least one battle offered a Shift');
});

test('Shift: saying no keeps your Pokémon in', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const result = await runWorker({ seed, answerShift: () => 'stay' });
    if (result === null) return;
    const at = result.log.findIndex((entry) => entry.shift);
    if (at < 0) continue;
    const { shift } = result.log[at];
    const nextMove = result.log.slice(at + 1).find((entry) => entry.move);
    if (!nextMove) continue; // the battle ended first
    assert.equal(nextMove.move, shift.party.find((p) => p.active).species);
    return;
  }
  assert.fail('no battle offered a Shift');
});
