// Tests for the monthly Cup (cup-month.mjs): sign-ups, the pool, the live draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCupMonth, scheduleFor, zonedTime, nextMonth, previousMonth, MAX_PLAYERS } from '../cup-month.mjs';
import { openStore } from '../store.mjs';
import { createCup } from '../cup.mjs';

const quiet = { log() {}, warn() {} };
const loadEngine = () => import('../cup-engine.mjs');
const user = (n) => ({ id: `u${n}`, name: `Player ${n}`, avatarUrl: null });

function setup(start = '2026-11-25T10:00:00Z', store = openStore(':memory:')) {
  let time = Date.parse(start);
  const changes = [];
  let seed = 7;
  const random = (max) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % max; };
  const make = () => createCupMonth({ store, loadEngine, now: () => time, random, onChange: (cup, what) => changes.push(what), log: quiet });
  return {
    store, changes, make, cups: make(),
    at: (iso) => { time = Date.parse(iso); },
    wait: (seconds) => { time += seconds * 1000; },
  };
}

test('each month in New York: sign-ups from the 25th, closed the 1st at 6 PM, the draft at 8 PM, the bracket from the 2nd', () => {
  assert.deepEqual(scheduleFor('2026-12'), {
    signupsOpen: Date.parse('2026-11-25T11:00:00Z'), signupsClose: Date.parse('2026-12-01T23:00:00Z'),
    draft: Date.parse('2026-12-02T01:00:00Z'), bracket: Date.parse('2026-12-02T05:00:00Z'),
  });
  assert.deepEqual([nextMonth('2026-12'), previousMonth('2027-01'), nextMonth('2027-01')], ['2027-01', '2026-12', '2027-02']);
  assert.equal(scheduleFor('2027-01').signupsOpen, Date.parse('2026-12-25T11:00:00Z'), 'over the new year');
  assert.equal(scheduleFor('2027-04').signupsOpen, Date.parse('2027-03-25T10:00:00Z'), 'summer time');
  assert.equal(zonedTime('2026-11-02', '06:00'), Date.parse('2026-11-02T11:00:00Z'), 'the day after the clocks go back');
});

test('sign-ups: from the 25th at 6 AM, up to 16 players, closed the 1st at 6 PM', async () => {
  const { cups, at, changes } = setup('2026-11-25T10:30:00Z'); // 5:30 AM in New York
  const before = cups.view('g1', user(1));
  assert.deepEqual([before.month, before.stage, before.next.month], ['2026-11', 'cancelled', '2026-12'], "November's Cup never happened here");
  assert.throws(() => cups.join('g1', user(1)), /closed\. The next one opens on the 25th/);

  at('2026-11-25T11:00:00Z');
  for (let n = 1; n <= MAX_PLAYERS; n++) cups.join('g1', user(n));
  cups.join('g1', user(1)); // twice is once
  assert.throws(() => cups.join('g1', user(17)), /full \(16 players\)/);
  cups.leave('g1', user(16));
  cups.join('g1', user(17));
  const seen = cups.view('g1', user(17));
  assert.deepEqual([seen.month, seen.stage, seen.players.length, seen.me.joined, seen.pool], ['2026-12', 'signup', 16, true, null]);
  assert.deepEqual(changes.slice(0, 2), ['opened', 'joined']);

  at('2026-12-01T23:00:05Z');
  assert.throws(() => cups.join('g1', user(18)), /closed/, 'closed at 6 PM even before the tick');
  assert.throws(() => cups.leave('g1', user(1)), /closed/);
});

test('the 1st at 6 PM: the order is drawn and the pool revealed; 8 PM: the draft, with the clock, autopicks and autodraft', async () => {
  const { cups, at, wait, make, store, changes } = setup('2026-11-27T12:00:00Z');
  for (let n = 1; n <= 6; n++) cups.join('g1', user(n));
  at('2026-12-01T23:00:01Z');
  await cups.tick();
  let seen = cups.view('g1', user(1));
  assert.equal(seen.stage, 'pool');
  assert.equal(seen.pool.length, 36, 'six per player');
  assert.deepEqual(seen.players.map((p) => p.id).sort(), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  const order = seen.players.map((p) => p.id);
  assert.notDeepEqual(order, ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'], 'drawn at random');
  assert.ok(seen.pool[0].species && seen.pool[0].moves.length && seen.pool[0].bst);
  assert.throws(() => cups.pick('g1', user(1), 0), /starts at 8 PM/);
  assert.throws(() => cups.wishlist('g1', user(7), [1]), /not in this Cup/);

  // A wish list is private.
  const [first, second] = order;
  const best = seen.pool.map((p, i) => [p.bst, i]).sort((a, b) => b[0] - a[0])[0][1];
  const wanted = best === 5 ? 6 : 5;
  cups.wishlist('g1', { id: first }, [wanted, 2]);
  assert.deepEqual(cups.view('g1', { id: first }).me.wishlist, [wanted, 2]);
  assert.deepEqual(cups.view('g1', { id: second }).me.wishlist, []);

  at('2026-12-02T01:00:00Z');
  await cups.tick();
  seen = cups.view('g1', user(1));
  assert.deepEqual([seen.stage, seen.onClock, seen.deadline, seen.pick], ['draft', first, Date.parse('2026-12-02T01:01:30Z'), { round: 1, pick: 1, overall: 1 }]);
  assert.throws(() => cups.pick('g1', { id: second }, 0), /not your pick/);

  // The first player's time runs out: their wish list picks for them.
  wait(89);
  await cups.tick();
  assert.equal(cups.view('g1', user(1)).picks.length, 0);
  wait(2);
  await cups.tick();
  seen = cups.view('g1', user(1));
  assert.deepEqual(seen.picks, [{ player: first, pool: wanted, auto: true }]);
  assert.equal(seen.onClock, second);

  // The second picks in time, and can't take what's gone.
  assert.throws(() => cups.pick('g1', { id: second }, wanted), /already taken/);
  cups.pick('g1', { id: second }, best);
  assert.deepEqual(cups.view('g1', user(1)).picks.at(-1), { player: second, pool: best, auto: false });

  // The server restarts mid-draft: it carries on.
  const again = make();
  assert.equal(again.view('g1', user(1)).picks.length, 2);

  // Everyone turns on autodraft: the rest goes at once.
  for (const id of order) again.autodraft('g1', { id }, true);
  seen = again.view('g1', user(1));
  assert.equal(seen.stage, 'drafted');
  assert.equal(seen.picks.length, 36);
  assert.equal(new Set(seen.picks.map((p) => p.pool)).size, 36, 'the whole pool, each once');
  const cup = store.getCup(seen.id);
  for (const id of order) assert.equal(again.teamOf(cup, id).length, 6);
  assert.ok(changes.includes('closed') && changes.includes('started') && changes.includes('drafted'));
});

test('fewer than 4 sign-ups: no Cup that month', async () => {
  const { cups, at } = setup('2026-11-30T12:00:00Z');
  for (let n = 1; n <= 3; n++) cups.join('g1', user(n));
  at('2026-12-01T23:00:01Z');
  await cups.tick();
  assert.deepEqual([cups.view('g1', user(1)).stage, cups.view('g1', user(1)).reason], ['cancelled', 'too-few']);
});

test('the bracket: drawn when the draft ends, open from the 2nd, matches battled, timed out or tossed, a champion', async () => {
  const store = openStore(':memory:');
  let time = Date.parse('2026-11-28T12:00:00Z');
  const changes = [];
  let seed = 11;
  const random = (max) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % max; };
  let month = null;
  const battles = createCup({ store, loadEngine, now: () => time, onFinished: (id, r) => month.battleEnded(id, r), log: quiet });
  month = createCupMonth({ store, battles, loadEngine, now: () => time, random, onChange: (cup, what, details) => changes.push([what, details]), log: quiet });
  const at = (iso) => { time = Date.parse(iso); };
  const tick = () => month.tick();
  const what = () => changes.map(([w]) => w);

  for (let n = 1; n <= 4; n++) month.join('g1', user(n));
  at('2026-12-01T23:00:00Z');
  await tick();
  at('2026-12-02T01:00:00Z');
  await tick();
  for (let n = 1; n <= 4; n++) month.autodraft('g1', user(n), true);
  let seen = month.view('g1', user(1));
  assert.equal(seen.stage, 'drafted');
  assert.equal(seen.bracket.slots.length, 5, '4 players: 5 rounds of 3 days at most');
  assert.equal(seen.bracket.slots[0].ends, Date.parse('2026-12-05T05:00:00Z'), 'round 1: the 2nd to the 4th');
  assert.equal(seen.me.team.length, 6);
  await assert.rejects(month.play('g1', user(1)), /starts on the 2nd/);

  // Leads: yours, for your battles from now on.
  month.setLead('g1', user(1), 2);
  const cup = store.getCup(seen.id);
  assert.equal(month.teamFor(cup, 'u1')[0], month.teamOf(cup, 'u1')[2]);
  assert.throws(() => month.setLead('g1', user(1), 6), /No such/);

  at('2026-12-02T05:00:00Z'); // midnight in New York
  await tick();
  assert.equal(what().at(-1), 'bracket');
  assert.equal(changes.at(-1)[1].ready.length, 2, 'two first-round matches');
  const [m1, m2] = changes.at(-1)[1].ready;
  const [a, b] = m1.players;
  const [c, d] = m2.players;

  // a and b both press Battle at once: one battle between them.
  const [id1, again] = await Promise.all([month.play('g1', { id: a }), month.play('g1', { id: b })]);
  assert.equal(id1, again);
  seen = month.view('g1', { id: a });
  assert.deepEqual([seen.bracket.mine.label, seen.bracket.mine.opponent, seen.bracket.mine.battleId], ['Winners round 1', b, id1]);
  // A draw: they play it again.
  month.battleEnded(id1, { winner: '', context: { cupId: seen.id, match: m1.id } });
  assert.equal(what().at(-1), 'draw');
  assert.equal(month.view('g1', { id: a }).bracket.mine.battleId, null);
  const replay = await month.play('g1', { id: a });
  assert.notEqual(replay, id1);
  await battles.choose(replay, { id: b }, { choice: 'forfeit' });
  seen = month.view('g1', { id: a });
  assert.deepEqual([what().at(-1), seen.bracket.matches.find((m) => m.id === m1.id).winner, seen.bracket.matches.find((m) => m.id === m1.id).how], ['result', a, 'gave up']);
  assert.deepEqual(seen.bracket.next, { id: 'W2-1', label: 'Winners final', waitingOn: m2.id }, 'a waits for the other match');

  // c starts theirs and moves; d never does. A day before the end, a reminder;
  // at the end, d is holding it up and loses.
  const id2 = await month.play('g1', { id: c });
  await battles.choose(id2, { id: c }, { choice: 'move 1' });
  at('2026-12-04T05:01:00Z');
  await tick();
  assert.deepEqual([what().at(-1), changes.at(-1)[1].match.id], ['reminder', m2.id]);
  await tick();
  assert.equal(what().filter((w) => w === 'reminder').length, 1, 'once');
  at('2026-12-05T05:00:00Z');
  await tick();
  seen = month.view('g1', { id: c });
  const second = seen.bracket.matches.find((m) => m.id === m2.id);
  assert.deepEqual([second.winner, second.how], [c, 'timeout']);
  assert.deepEqual(changes.at(-1)[1].ready.map((m) => m.id).sort(), ['L1-1', 'W2-1']);

  // While the bracket's on, next month's sign-ups open alongside it.
  at('2026-12-25T11:00:00Z');
  seen = month.view('g1', { id: a });
  assert.deepEqual([seen.month, seen.stage, seen.signup.month, seen.signup.stage], ['2026-12', 'bracket', '2027-01', 'signup']);
  at('2026-12-05T06:00:00Z');

  // Nobody plays the losers' match: a coin toss when its round ends.
  const ended = (id) => month.view('g1', { id: a }).bracket.matches.find((m) => m.id === id);
  await battles.choose(await month.play('g1', { id: a }), { id: c }, { choice: 'forfeit' }); // a wins the winners' final
  at('2026-12-08T05:00:00Z');
  await tick();
  assert.equal(ended('L1-1').how, 'no-show');
  assert.ok([b, d].includes(ended('L1-1').winner));

  // The rest by forfeits: the losers' final, then the grand final.
  for (let guard = 0; guard < 6 && month.view('g1', { id: a }).stage !== 'done'; guard++) {
    const mine = (id) => month.view('g1', { id }).bracket.mine;
    const players = [a, b, c, d].filter((p) => mine(p));
    const [first] = players;
    const battle = await month.play('g1', { id: first });
    await battles.choose(battle, { id: mine(first).opponent }, { choice: 'forfeit' });
  }
  seen = month.view('g1', { id: a });
  assert.equal(seen.stage, 'done');
  assert.ok(seen.champion);
  assert.equal(what().at(-1), 'champion');
  assert.equal(seen.bracket.standings[seen.champion].status, 'champion');
  assert.deepEqual(seen.reigning, { month: '2026-12', id: seen.champion, name: `Player ${seen.champion.slice(1)}` });
});
