// Tests for the daily rules shared by the page and the server (web/daily.js).
//   cd activity && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY, currentStreaks, dayNumber, recordResult, useStatsStorage } from '../../web/daily.js';

useStatsStorage({ read: () => null, write: () => {} });

test('streaks start over at the start of each month; the best streak stays', () => {
  const stats = { ...EMPTY };
  for (const date of ['2026-11-28', '2026-11-29', '2026-11-30']) recordResult(stats, date, true);
  assert.deepEqual([stats.winStreak, stats.dayStreak, stats.bestWinStreak], [3, 3, 3]);
  assert.equal(currentStreaks(stats, '2026-11-30').winStreak, 3);

  // On the 1st, before playing: the November streaks are over.
  assert.deepEqual(currentStreaks(stats, '2026-12-01'), { winStreak: 0, dayStreak: 0 });

  // Playing on the 1st starts new streaks at 1.
  recordResult(stats, '2026-12-01', true);
  assert.deepEqual([stats.winStreak, stats.dayStreak, stats.bestWinStreak], [1, 1, 3]);
  recordResult(stats, '2026-12-02', true);
  assert.deepEqual(currentStreaks(stats, '2026-12-02'), { winStreak: 2, dayStreak: 2 });
});

test('day numbers count from the first day', () => {
  assert.equal(dayNumber('2026-11-01'), 1);
  assert.equal(dayNumber('2026-11-12'), 12);
  assert.equal(dayNumber('2026-12-01'), 31);
});
