// Tests for the Cup's double-elimination bracket (cup-bracket.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBracket, record, playable, champion, standings, seedOrder, bracketSize, matchOrder, BYE } from '../cup-bracket.mjs';

const ids = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

// Plays the whole bracket out, `pick(match)` choosing each winner. Returns
// how many battles were played.
function playOut(bracket, pick) {
  let battles = 0;
  for (let guard = 0; guard < 100 && !champion(bracket); guard++) {
    const [m] = playable(bracket);
    if (!m) break;
    record(bracket, m.id, pick(m));
    battles++;
  }
  return battles;
}

test('seeding: 1 v 8, 4 v 5, 2 v 7, 3 v 6; the bracket is 4, 8 or 16', () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.deepEqual([4, 5, 8, 9, 16].map(bracketSize), [4, 8, 8, 16, 16]);
});

test('8 players: 14 or 15 battles, 7 rounds of 3 days, every player out after two losses but the champion', () => {
  const bracket = newBracket(ids(8));
  assert.equal(bracket.slots, 7);
  assert.equal(playable(bracket).length, 4, 'four first-round matches');
  assert.deepEqual(playable(bracket)[0].players, ['p1', 'p8']);
  const slots = Object.fromEntries(matchOrder(bracket).map((m) => [m.id, m.slot]));
  assert.deepEqual([slots['W1-1'], slots['W2-1'], slots['L1-1'], slots['W3-1'], slots['L2-1'], slots['L3-1'], slots['L4-1'], slots.F1, slots.F2], [1, 2, 2, 3, 3, 4, 5, 6, 7]);
  assert.equal(matchOrder(bracket).find((m) => m.id === 'L4-1').label, 'Losers final');
  assert.equal(matchOrder(bracket).find((m) => m.id === 'W2-1').label, 'Winners semifinal');

  // The better seed always wins: no reset.
  const better = (m) => (Number(m.players[0].slice(1)) < Number(m.players[1].slice(1)) ? m.players[0] : m.players[1]);
  assert.equal(playOut(bracket, better), 14);
  assert.equal(champion(bracket), 'p1');
  assert.equal(bracket.matches.F2.how, 'not needed');
  const table = standings(bracket);
  assert.deepEqual(table.get('p1'), { wins: 4, losses: 0, status: 'champion' });
  assert.equal([...table.values()].filter((r) => r.status === 'out').length, 7);
  assert.ok([...table.entries()].filter(([id]) => id !== 'p1').every(([, r]) => r.losses === 2 || r.status === 'out'));
});

test('the losers\' champion wins the grand final: a reset decides it', () => {
  const bracket = newBracket(ids(4));
  // p1 wins the winners' side; p2 comes through the losers' side.
  record(bracket, 'W1-1', 'p1');
  record(bracket, 'W1-2', 'p2');
  record(bracket, 'W2-1', 'p1');
  record(bracket, 'L1-1', 'p3');
  record(bracket, 'L2-1', 'p2');
  assert.deepEqual(bracket.matches.F1.players, ['p1', 'p2']);
  const reset = record(bracket, 'F1', 'p2');
  assert.deepEqual(reset.map((m) => m.id), ['F2']);
  assert.equal(champion(bracket), null, 'one loss each: not over yet');
  record(bracket, 'F2', 'p2');
  assert.equal(champion(bracket), 'p2');
  assert.deepEqual(standings(bracket).get('p1'), { wins: 2, losses: 2, status: 'out' });
});

test('byes: 5 players in a bracket of 8, the top seeds go through, and nobody plays a bye', () => {
  const bracket = newBracket(ids(5));
  assert.deepEqual(playable(bracket).filter((m) => m.slot === 1).map((m) => m.players), [['p4', 'p5']], 'only 4 v 5 plays in round 1');
  assert.deepEqual(bracket.matches['W2-2'].players, ['p2', 'p3'], 'both had byes: they can play their round 2 match early');
  assert.ok(playable(bracket).includes(bracket.matches['W2-2']));
  assert.deepEqual(['W1-1', 'W1-3', 'W1-4'].map((id) => [bracket.matches[id].winner, bracket.matches[id].how]), [['p1', 'bye'], ['p2', 'bye'], ['p3', 'bye']]);
  assert.equal(bracket.matches['L1-2'].winner, BYE, 'two byes meet: nobody comes out');
  let battles = 0;
  for (let guard = 0; guard < 50 && !champion(bracket); guard++) {
    const [m] = playable(bracket);
    for (const p of m.players) assert.notEqual(p, BYE);
    record(bracket, m.id, m.players[1]); // upsets all the way
    battles++;
  }
  assert.ok(champion(bracket));
  assert.ok(battles >= 8 && battles <= 9, `${battles} battles for 5 players`);
  for (const [, row] of standings(bracket)) assert.ok(row.status === 'champion' || row.losses === 2);
});

test('16 players: 9 rounds, the last one ending by the 28th', () => {
  const bracket = newBracket(ids(16));
  assert.equal(bracket.slots, 9);
  assert.equal(playable(bracket).length, 8);
  let n = 0;
  const battles = playOut(bracket, (m) => m.players[(n++) % 2]);
  assert.ok(champion(bracket));
  assert.ok(battles === 30 || battles === 31, `${battles}`);
});
