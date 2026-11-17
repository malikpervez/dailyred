// Tests for the Cup's week (cup-week.mjs): sign-ups, the pool, the live draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCupWeek, scheduleFor, zonedTime, MAX_PLAYERS } from '../cup-week.mjs';
import { openStore } from '../store.mjs';

const quiet = { log() {}, warn() {} };
const loadEngine = () => import('../cup-engine.mjs');
const user = (n) => ({ id: `u${n}`, name: `Player ${n}`, avatarUrl: null });

function setup(start = '2026-11-23T10:00:00Z', store = openStore(':memory:')) {
  let time = Date.parse(start);
  const changes = [];
  let seed = 7;
  const random = (max) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % max; };
  const make = () => createCupWeek({ store, loadEngine, now: () => time, random, onChange: (cup, what) => changes.push(what), log: quiet });
  return {
    store, changes, make, week: make(),
    at: (iso) => { time = Date.parse(iso); },
    wait: (seconds) => { time += seconds * 1000; },
  };
}

test('Monday in New York: sign-ups 6 AM to 6 PM, the draft at 8 PM, through clock changes', () => {
  assert.deepEqual(scheduleFor('2026-11-23'), {
    signupsOpen: Date.parse('2026-11-23T11:00:00Z'), signupsClose: Date.parse('2026-11-23T23:00:00Z'), draft: Date.parse('2026-11-24T01:00:00Z'),
  });
  assert.equal(zonedTime('2026-03-09', '06:00'), Date.parse('2026-03-09T10:00:00Z'), 'summer time');
  assert.equal(zonedTime('2026-11-02', '06:00'), Date.parse('2026-11-02T11:00:00Z'), 'the day after the clocks go back');
});

test('sign-ups: from 6 AM Monday, up to 8 players, closed at 6 PM', async () => {
  const { week, at, changes } = setup('2026-11-23T10:30:00Z'); // 5:30 AM in New York
  assert.equal(week.current('g1'), null);
  assert.throws(() => week.join('g1', user(1)), /Sign-ups open Monday at 6 AM ET/);
  assert.equal(week.view('g1', user(1)).stage, 'none');

  at('2026-11-23T11:00:00Z');
  for (let n = 1; n <= MAX_PLAYERS; n++) week.join('g1', user(n));
  week.join('g1', user(1)); // twice is once
  assert.throws(() => week.join('g1', user(9)), /full \(8 players\)/);
  week.leave('g1', user(8));
  week.join('g1', user(9));
  const seen = week.view('g1', user(9));
  assert.deepEqual([seen.stage, seen.players.length, seen.me.joined, seen.pool], ['signup', 8, true, null]);
  assert.deepEqual(changes.slice(0, 2), ['opened', 'joined']);

  at('2026-11-23T23:00:05Z');
  assert.throws(() => week.join('g1', user(10)), /closed/, 'closed at 6 PM even before the tick');
  assert.throws(() => week.leave('g1', user(1)), /closed/);
});

test('6 PM: the order is drawn and the pool revealed; 8 PM: the draft, with the clock, autopicks and autodraft', async () => {
  const { week, at, wait, make, store, changes } = setup('2026-11-23T12:00:00Z');
  for (let n = 1; n <= 6; n++) week.join('g1', user(n));
  at('2026-11-23T23:00:01Z');
  await week.tick();
  let seen = week.view('g1', user(1));
  assert.equal(seen.stage, 'pool');
  assert.equal(seen.pool.length, 36, 'six per player');
  assert.deepEqual(seen.players.map((p) => p.id).sort(), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  const order = seen.players.map((p) => p.id);
  assert.notDeepEqual(order, ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'], 'drawn at random');
  assert.ok(seen.pool[0].species && seen.pool[0].moves.length && seen.pool[0].bst);
  assert.throws(() => week.pick('g1', user(1), 0), /starts at 8 PM/);
  assert.throws(() => week.wishlist('g1', user(7), [1]), /not in this week's Cup/);

  // A wish list is private.
  const [first, second] = order;
  const best = seen.pool.map((p, i) => [p.bst, i]).sort((a, b) => b[0] - a[0])[0][1];
  const wanted = best === 5 ? 6 : 5;
  week.wishlist('g1', { id: first }, [wanted, 2]);
  assert.deepEqual(week.view('g1', { id: first }).me.wishlist, [wanted, 2]);
  assert.deepEqual(week.view('g1', { id: second }).me.wishlist, []);

  at('2026-11-24T01:00:00Z');
  await week.tick();
  seen = week.view('g1', user(1));
  assert.deepEqual([seen.stage, seen.onClock, seen.deadline, seen.pick], ['draft', first, Date.parse('2026-11-24T01:01:30Z'), { round: 1, pick: 1, overall: 1 }]);
  assert.throws(() => week.pick('g1', { id: second }, 0), /not your pick/);

  // The first player's time runs out: their wish list picks for them.
  wait(89);
  await week.tick();
  assert.equal(week.view('g1', user(1)).picks.length, 0);
  wait(2);
  await week.tick();
  seen = week.view('g1', user(1));
  assert.deepEqual(seen.picks, [{ player: first, pool: wanted, auto: true }]);
  assert.equal(seen.onClock, second);

  // The second picks in time, and can't take what's gone.
  assert.throws(() => week.pick('g1', { id: second }, wanted), /already taken/);
  week.pick('g1', { id: second }, best);
  assert.deepEqual(week.view('g1', user(1)).picks.at(-1), { player: second, pool: best, auto: false });

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

test('fewer than 4 sign-ups: no Cup that week', async () => {
  const { week, at } = setup('2026-11-23T12:00:00Z');
  for (let n = 1; n <= 3; n++) week.join('g1', user(n));
  at('2026-11-23T23:00:01Z');
  await week.tick();
  assert.deepEqual([week.view('g1', user(1)).stage, week.view('g1', user(1)).reason], ['cancelled', 'too-few']);
});
