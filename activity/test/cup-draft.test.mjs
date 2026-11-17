// Tests for the Cup's draft rules (cup-draft.mjs) and its pool (team.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newDraft, seatFor, onClock, makePick, autoChoice, autoPick, setWishlist, teamOf, isDone, pickNumber, available, DraftError,
} from '../cup-draft.mjs';
import { draftPool } from '../cup-engine.mjs';

const fakePool = (bsts) => bsts.map((bst, i) => ({ set: { species: `Mon${i}` }, bst }));

test('the order snakes: 1-2-3, 3-2-1, 1-2-3...', () => {
  assert.deepEqual(Array.from({ length: 9 }, (_, n) => seatFor(n, 3)), [0, 1, 2, 2, 1, 0, 0, 1, 2]);
  const draft = newDraft(['a', 'b'], fakePool(Array(12).fill(400)));
  const seen = [];
  while (!isDone(draft)) {
    seen.push(onClock(draft));
    makePick(draft, onClock(draft), available(draft)[0]);
  }
  assert.equal(seen.join(''), 'abbaabbaabba');
  assert.equal(onClock(draft), null);
  assert.equal(available(draft).length, 0, 'everything in the pool ends up on a team');
  assert.equal(teamOf(draft, 'a').length, 6);
});

test('picks: only yours, only once, only from the pool', () => {
  const draft = newDraft(['a', 'b'], fakePool(Array(12).fill(400)));
  assert.throws(() => makePick(draft, 'b', 0), /not your pick/);
  assert.throws(() => makePick(draft, 'a', 12), /No such/);
  assert.throws(() => makePick(draft, 'a', '1'), /No such/);
  makePick(draft, 'a', 3);
  assert.throws(() => makePick(draft, 'b', 3), (err) => err instanceof DraftError && /Mon3 is already taken/.test(err.message));
  assert.deepEqual(pickNumber(draft), { round: 1, pick: 2, overall: 2 });
});

test('autopick: the wish list first, then the best Pokémon left', () => {
  const draft = newDraft(['a', 'b'], fakePool([300, 600, 450, 600, 200, 500, 310, 320, 330, 340, 350, 360]));
  assert.equal(autoChoice(draft, 'a'), 1, 'best base stat total (first of a tie)');
  setWishlist(draft, 'a', [4, 1, 4]);
  assert.deepEqual(draft.wishlists.a, [4, 1]);
  assert.equal(autoPick(draft).set.species, 'Mon4');
  makePick(draft, 'b', 1);
  assert.equal(autoChoice(draft, 'b'), 3);
  makePick(draft, 'b', 3);
  assert.equal(autoChoice(draft, 'a'), 5, 'the wished ones are gone');
  assert.equal(draft.picks[0].auto, true);
  assert.throws(() => setWishlist(draft, 'c', [1]), /not in this draft/);
  assert.throws(() => setWishlist(draft, 'a', [99]), /Bad wish list/);
});

test('the pool: different species from all 386, level 100 sets, the same for a seed', () => {
  const pool = draftPool(20261123, 48);
  assert.equal(pool.length, 48);
  assert.equal(new Set(pool.map((p) => p.set.species)).size, 48);
  assert.deepEqual(draftPool(20261123, 48).map((p) => p.set), pool.map((p) => p.set));
  for (const { set, info, bst } of pool) {
    assert.equal(set.level, 100);
    assert.ok(set.moves.length >= 1 && set.moves.length <= 4); // Ditto, Unown...: what they can learn
    assert.ok(bst > 150 && bst < 700);
    assert.equal(info.species, set.species);
    assert.equal(info.moves.length, set.moves.length);
    assert.ok(info.stats.hp > 0);
  }
  const spread = draftPool(1, 386).map((p) => p.bst);
  assert.ok(Math.min(...spread) < 250 && Math.max(...spread) > 670, 'junk and legends alike');
});
