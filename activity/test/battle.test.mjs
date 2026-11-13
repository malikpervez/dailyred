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
  for (let seed = 1; seed <= 400; seed++) for (const version of [1, 2]) for (const set of generateTeam(dex, seed, version)) items.add(set.item);
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
// `onMove(req)` may answer a move request first (e.g. with an item); null
// leaves it to the simple player.
async function runWorker({ seed, answerShift = () => 'stay', onMove = () => null, maxMessages = 20000 }) {
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
      log.push({ move: req.species, req });
      const choice = onMove(req);
      if (choice) {
        log.push({ chose: choice });
        send({ type: 'choose', choice });
        continue;
      }
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

test('from No. 14 every Pokémon always holds its own item; a Choice Band holder only gets attacks', async () => {
  const { heldItemFor } = await import('../../web/battle/team.js');
  const { dailySeed, teamVersion } = await import('../../web/daily.js');
  const dex = Dex.forGen(3);
  // No. 13 was played with the old random items: it stays exactly the same.
  assert.equal(teamVersion('2026-11-13'), 1);
  const no13 = generateTeam(dex, dailySeed('2026-11-13'), teamVersion('2026-11-13'));
  assert.deepEqual([no13[1].species, no13[1].item, no13[1].moves.at(-1)], ['Sceptile', 'Choice Band', 'Toxic']);
  assert.equal(teamVersion('2026-11-14'), 2);
  assert.equal(teamVersion(null), 2, 'practice teams use the newest rules');

  const seen = new Map();
  for (let seed = 1; seed <= 1500; seed++) {
    for (const set of generateTeam(dex, seed * 7919, 2)) {
      assert.equal(set.item, dex.items.get(heldItemFor(dex, set.species)).name);
      if (seen.has(set.species)) assert.equal(set.item, seen.get(set.species), `${set.species} always holds the same item`);
      seen.set(set.species, set.item);
      if (set.item === 'Choice Band') {
        assert.ok(set.moves.every((m) => dex.moves.get(m).category !== 'Status'), `${set.species}: ${set.moves.join(', ')}`);
      }
    }
  }
  const item = (name) => dex.items.get(heldItemFor(dex, name)).name;
  assert.deepEqual(['Charmander', 'Charmeleon', 'Charizard', 'Dragonite', 'Pikachu', 'Raichu', 'Marowak', 'Latios', 'Gyarados', 'Gengar', 'Blissey', 'Deoxys-Attack'].map(item),
    ['Charcoal', 'Charcoal', 'Charcoal', 'Dragon Fang', 'Light Ball', 'Magnet', 'Thick Club', 'Soul Dew', 'Choice Band', 'Petaya Berry', 'Leftovers', 'Twisted Spoon']);

  // The boosted type is always among the day's attacks.
  for (let seed = 1; seed <= 1500; seed++) {
    for (const set of generateTeam(dex, seed * 7919, 2)) {
      const boost = /^Holder's (\w+)-type attacks have 1\.1× power\.$/.exec(dex.items.get(set.item).shortDesc ?? '')?.[1];
      if (boost) assert.ok(set.moves.some((m) => dex.moves.get(m).type === boost && dex.moves.get(m).category !== 'Status'), `${set.species} (${set.item}): ${set.moves.join(', ')}`);
    }
  }
});

test("the held-item table covers every Pokémon, with real items, few Choice Bands and Leftovers, families matching", async () => {
  const { HELD_ITEMS } = await import('../../web/battle/held-items.js');
  const dex = Dex.forGen(3);
  const pool = dex.species.all().filter((s) => s.exists && s.num >= 1 && s.num <= 386 && !s.forme);
  assert.equal(pool.length, 386);
  for (const s of pool) assert.ok(dex.items.get(HELD_ITEMS[s.id]).exists, `${s.name}: ${HELD_ITEMS[s.id]}`);
  const count = (id) => pool.filter((s) => HELD_ITEMS[s.id] === id).length;
  assert.ok(count('choiceband') <= 20, `${count('choiceband')} Choice Bands`);
  assert.ok(count('leftovers') <= 40, `${count('leftovers')} Leftovers`);
  // Evolution lines with the same typing hold the same item, unless an early
  // form can't use its type's item (Cleffa, Marill, Feebas...: Leftovers or a
  // berry). The data's Gen 4 evolutions, like Rhyperior, aren't in Daily Red.
  const evos = (s) => (s.evos ?? []).map((e) => dex.species.get(e)).filter((e) => e.num <= 386);
  const SIGNATURE = new Set(['lightball', 'thickclub', 'souldew', 'deepseatooth', 'stick', 'metalpowder']);
  const typeItem = (id) => /^Holder's \w+-type attacks/.test(dex.items.get(id).shortDesc ?? '');
  for (const s of pool) {
    for (const e of evos(s)) {
      if (e.types.join() !== s.types.join() || SIGNATURE.has(HELD_ITEMS[e.id]) || SIGNATURE.has(HELD_ITEMS[s.id])) continue;
      if (typeItem(HELD_ITEMS[s.id])) assert.equal(HELD_ITEMS[s.id], HELD_ITEMS[e.id], `${s.name} and ${e.name}`);
    }
  }
  assert.ok(count('choiceband') + count('leftovers') + count('petayaberry') < 60, 'mostly type items');
});

test('the bag: an item takes your turn, goes first, and works like in the games', async () => {
  const seen = { xattack: 0, fullrestore: 0, revive: 0, refused: 0, limit: 0 };
  for (let seed = 1; seed <= 30 && !(seen.revive && seen.fullrestore && seen.xattack && seen.limit); seed++) {
    let used = 0;
    let tried = { noEffect: false, overLimit: false };
    const result = await runWorker({
      seed,
      onMove(req) {
        const active = req.party.find((p) => p.active);
        const fainted = req.party.find((p) => p.status === 'fnt');
        if (req.notice) {
          // The refusals come back as the same request with a notice.
          if (/won't have any effect/.test(req.notice)) seen.refused++;
          if (/Only 4 items/.test(req.notice)) seen.limit++;
          return null;
        }
        if (!tried.noEffect && active.hp === active.maxhp) {
          tried.noEffect = true;
          return `item hyperpotion ${active.slot}`; // full HP: no effect, turn not used
        }
        if (used >= 4) {
          if (tried.overLimit) return null;
          tried.overLimit = true;
          assert.equal(req.canBag, false, 'the bag closes after 4 items');
          return `item fullrestore ${active.slot}`;
        }
        if (used === 0 && req.canBag) { used++; return `item xattack ${active.slot}`; }
        if (fainted && req.canBag) { used++; return `item revive ${fainted.slot}`; }
        if (active.hp < active.maxhp / 2 && req.canBag) { used++; return `item fullrestore ${active.slot}`; }
        return null;
      },
    });
    if (result === null) return; // battle engine not built here
    const lines = result.log.filter((e) => typeof e === 'string');
    for (let i = 0; i < result.log.length; i++) {
      const choice = result.log[i].chose;
      if (!choice) continue;
      const [, item, slot] = choice.split(' ');
      const req = result.log[i - 1].req;
      const mon = req.party[Number(slot) - 1];
      const after = result.log.slice(i + 1);
      const end = after.findIndex((e) => e.move || e.chose || e.shift);
      const turn = (end < 0 ? after : after.slice(0, end)).filter((e) => typeof e === 'string');
      if (req.notice || !req.canBag) continue;
      if (turn[0] === undefined) continue; // refused (the next entry is the request again)
      assert.equal(turn[0], `Tester used ${{ xattack: 'X Attack', fullrestore: 'Full Restore', revive: 'Revive', hyperpotion: 'Hyper Potion' }[item]}!`, `the item goes first: ${turn.join(' / ')}`);
      assert.ok(!turn.some((t) => t.startsWith(`${req.species} used `)), `${req.species} doesn't attack that turn: ${turn.join(' / ')}`);
      assert.ok(!turn.some((t) => /fast asleep|is frozen solid|flinched|tightening its focus/.test(t)), turn.join(' / '));
      if (item === 'xattack') { assert.equal(turn[1], `${req.species}'s Attack rose!`); seen.xattack++; }
      if (item === 'fullrestore') { assert.equal(turn[1], `${mon.species} had its HP restored.`); seen.fullrestore++; }
      if (item === 'revive') {
        assert.equal(turn[1], `${mon.species} was revived!`);
        // Back with half its HP, and it can be sent out again.
        const later = result.log.slice(i + 1).find((e) => e.req)?.req.party[Number(slot) - 1];
        if (later) {
          assert.notEqual(later.status, 'fnt');
          assert.ok(later.hp > 0 && later.hp <= Math.ceil(later.maxhp / 2), `${later.hp}/${later.maxhp}`);
        }
        seen.revive++;
      }
    }
    assert.ok(lines.length > 10);
  }
  assert.ok(seen.xattack && seen.fullrestore && seen.revive, JSON.stringify(seen));
  assert.ok(seen.refused, 'a Hyper Potion on full HP is refused');
  assert.ok(seen.limit, 'a 5th item is refused');
});
