// Tests for the money and items rules (web/economy.js):
//   cd activity && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ECONOMY_START, CARRY_LIMIT, WEEKLY_BAG, ITEMS, NO_EFFECT, prizeFor, weekOf, walletFor, bagOf, earn, buy, useItem, usedIn, economyOpen,
  itemProblem, EconomyError,
} from '../../web/economy.js';

test('prize money: wins pay more for Pokémon left, losses for RED Pokémon knocked out, running away nothing', () => {
  assert.equal(prizeFor({ won: true, monsLeft: 3 }), 1210);
  assert.equal(prizeFor({ won: false, redLeft: 2 }), 670);
  assert.equal(prizeFor({ won: false, redLeft: 6 }), 270);
  assert.equal(prizeFor({ won: false, gaveUp: true, redLeft: 4 }), 0);
});

test('weeks start on Monday; it all starts on Monday, Nov 16', () => {
  assert.equal(ECONOMY_START, '2026-11-16');
  assert.equal(weekOf('2026-11-16'), '2026-11-16');
  assert.equal(weekOf('2026-11-22'), '2026-11-16'); // Sunday
  assert.equal(weekOf('2026-11-23'), '2026-11-23');
  assert.equal(weekOf('2026-12-01'), '2026-11-30');
  assert.ok(!economyOpen('2026-11-15'));
  assert.ok(economyOpen('2026-11-16'));
  const w = walletFor(null, '2026-11-15');
  assert.equal(earn(w, '2026-11-15', { won: true, monsLeft: 6 }), 0, 'no prize money before it starts');
});

test('a week: the free bag, buying, using up to the limit, free items first', () => {
  const w = walletFor(null, '2026-11-16');
  assert.deepEqual(bagOf(w), {
    fullrestore: { free: 3, bought: 0, total: 3 }, revive: { free: 2, bought: 0, total: 2 }, maxrevive: { free: 1, bought: 0, total: 1 },
  });
  assert.throws(() => buy(w, 'fullheal'), EconomyError, 'no money yet');
  earn(w, '2026-11-16', { won: false, redLeft: 3 });
  assert.equal(w.cash, 570);
  earn(w, '2026-11-17', { won: true, monsLeft: 2 });
  buy(w, 'revive');
  assert.deepEqual([w.cash, w.spent, w.earned], [570 + 1140 - 1500, 1500, 1710]);
  assert.equal(bagOf(w).revive.total, 3);

  for (let i = 0; i < 3; i++) useItem(w, '2026-11-18', 'revive');
  assert.deepEqual([w.freeUsed.revive, w.bought.revive], [2, 0], 'the free ones first');
  useItem(w, '2026-11-18', 'fullrestore');
  assert.equal(usedIn(w, '2026-11-18'), CARRY_LIMIT);
  assert.throws(() => useItem(w, '2026-11-18', 'fullrestore'), /Only 4 items per battle/);
  useItem(w, '2026-11-19', 'fullrestore'); // the next day's battle
  assert.throws(() => useItem(w, '2026-11-19', 'revive'), /No Revive left/);
  assert.throws(() => useItem(w, '2026-11-19', 'pokeball'), /no such item/);
});

test('Monday refills the free bag (no stacking); the 1st empties the wallet and bought items', () => {
  let w = walletFor(null, '2026-11-27');
  w.cash = 5000;
  buy(w, 'xspeed', 2);
  useItem(w, '2026-11-27', 'maxrevive');
  w = walletFor(w, '2026-11-29'); // same week
  assert.equal(bagOf(w).maxrevive, undefined);
  w = walletFor(w, '2026-11-30'); // Monday: refilled to 1, not 2
  assert.equal(bagOf(w).maxrevive.total, WEEKLY_BAG.maxrevive);
  assert.deepEqual([w.cash, w.bought.xspeed], [4300, 2], 'money stays within the month');
  w = walletFor(w, '2026-12-01'); // the 1st
  assert.deepEqual([w.cash, w.earned, w.spent, w.bought], [0, 0, 0, {}]);
  assert.equal(bagOf(w).maxrevive.total, 1, 'the free bag is still this week\'s');
});

test('a device a day behind sees the same wallet; junk in a saved wallet is ignored', () => {
  const w = walletFor(null, '2026-12-01');
  w.cash = 900;
  useItem(w, '2026-12-01', 'revive');
  const behind = walletFor(w, '2026-11-30'); // still November there
  assert.deepEqual([behind.month, behind.cash, behind.freeUsed.revive], ['2026-12', 900, 1]);
  const junk = walletFor({ month: '2026-12', cash: '1e9x', bought: { revive: 2, constructor: 5, hyperpotion: -3, fullheal: 'two' } }, '2026-12-02');
  assert.deepEqual([junk.cash, junk.bought], [0, { revive: 2 }]);
  for (const name of ['constructor', '__proto__', 'toString', 42, null]) {
    assert.throws(() => buy({ ...w, cash: 1e6 }, name), /no such item/);
    assert.throws(() => useItem(walletFor(null, '2026-12-01'), '2026-12-01', name), /no such item/);
    assert.notEqual(itemProblem(name, { hp: 1, maxhp: 2 }), '');
  }
});

test('items only work where they would in the games', () => {
  const ok = { hp: 100, maxhp: 300, status: '', active: true, boosts: {} };
  const full = { ...ok, hp: 300 };
  const down = { ...ok, hp: 0, status: 'fnt', active: false };
  assert.equal(itemProblem('hyperpotion', ok), '');
  assert.equal(itemProblem('hyperpotion', full), NO_EFFECT);
  assert.equal(itemProblem('maxpotion', down), NO_EFFECT, 'no Potions on the fainted');
  assert.equal(itemProblem('fullrestore', { ...full, status: 'par' }), '', 'Full Restore also cures');
  assert.equal(itemProblem('fullrestore', { ...full, confused: true }), '');
  assert.equal(itemProblem('fullheal', full), NO_EFFECT);
  assert.equal(itemProblem('fullheal', { ...full, status: 'slp', active: false }), '');
  assert.equal(itemProblem('revive', ok), NO_EFFECT);
  assert.equal(itemProblem('maxrevive', down), '');
  assert.equal(itemProblem('xattack', ok), '');
  assert.equal(itemProblem('xattack', { ...ok, boosts: { atk: 6 } }), NO_EFFECT);
  assert.match(itemProblem('xspeed', { ...ok, active: false }), /in battle/);
});

test('the store sells FireRed items at FireRed prices', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(ITEMS).map(([k, v]) => [k, v.price])), {
    fullrestore: 3000, maxpotion: 2500, hyperpotion: 1200, fullheal: 600, revive: 1500, maxrevive: 4000,
    xattack: 500, xdefend: 550, xspeed: 350, xspecial: 350,
  });
});
