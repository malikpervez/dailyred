// The daily game and the player's stats, saved in this browser (localStorage).
//
// Everyone gets the same team on the same calendar day (in their own time
// zone, like Wordle), and each browser gets one battle with RED per day.

const STORAGE_KEY = 'dailyred-stats';

// A date in the player's time zone, e.g. "2026-10-11".
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00`); // midday, so DST changes can't skip a day
  d.setDate(d.getDate() + days);
  return today(d);
}

// The first day of Daily Red, for the "No." in the header and in Discord.
export const FIRST_DAY = '2026-11-01';

export function dayNumber(date) {
  return Math.round((new Date(`${date}T12:00:00Z`) - new Date(`${FIRST_DAY}T12:00:00Z`)) / 86400000) + 1;
}

// The day's team seed: a hash (FNV-1a) of the date, never 0.
export function dailySeed(date) {
  let hash = 0x811c9dc5;
  for (const ch of `dailyred:${date}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

export function msUntilTomorrow(now = new Date()) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight - now;
}

// --- Stats ------------------------------------------------------------------
//   wins, losses     all-time
//   winStreak        daily wins in a row
//   bestWinStreak    the longest winStreak so far
//   dayStreak        days played in a row
//   lastPlayed       date of the last finished battle, lastResult 'won'/'lost'
//   pending          date of a battle that started but hasn't finished

export const EMPTY = { wins: 0, losses: 0, winStreak: 0, bestWinStreak: 0, dayStreak: 0, lastPlayed: null, lastResult: null, pending: null };

// Where stats are kept: this browser's localStorage, unless useStatsStorage()
// swaps in something else (the Discord Activity keeps them on its server, and
// the server itself reuses the rules below with no storage at all).
let storage = {
  read: () => JSON.parse(localStorage.getItem(STORAGE_KEY)),
  write: (stats) => localStorage.setItem(STORAGE_KEY, JSON.stringify(stats)),
};

export function useStatsStorage(next) {
  storage = next;
  memoryCopy = null;
}

let memoryCopy = null; // used when localStorage is blocked

export function loadStats() {
  try {
    const saved = storage.read();
    return { ...EMPTY, ...saved };
  } catch {
    return { ...EMPTY, ...memoryCopy };
  }
}

function save(stats) {
  memoryCopy = { ...stats };
  try {
    storage.write(stats);
  } catch {
    // Storage blocked (e.g. some private modes): stats last until the page closes.
  }
}

// Today's result ('won' / 'lost'), or null if today's battle isn't done.
export function resultFor(stats, date) {
  return stats.lastPlayed === date ? stats.lastResult : null;
}

// Streaks as they stand on `date`: missing a day breaks them.
export function currentStreaks(stats, date) {
  const alive = stats.lastPlayed === date || stats.lastPlayed === addDays(date, -1);
  return { winStreak: alive ? stats.winStreak : 0, dayStreak: alive ? stats.dayStreak : 0 };
}

// From the moment RED's battle starts the day counts as played, so leaving
// mid-battle counts as a loss (see settleAbandonedGame).
export function markBattleStarted(stats, date) {
  if (stats.pending === date || resultFor(stats, date)) return;
  stats.pending = date;
  save(stats);
}

export function recordResult(stats, date, won) {
  if (stats.lastPlayed === date) return;
  const consecutive = stats.lastPlayed === addDays(date, -1);
  stats.dayStreak = consecutive ? stats.dayStreak + 1 : 1;
  if (won) {
    stats.wins++;
    stats.winStreak = consecutive && stats.lastResult === 'won' ? stats.winStreak + 1 : 1;
    stats.bestWinStreak = Math.max(stats.bestWinStreak || 0, stats.winStreak);
  } else {
    stats.losses++;
    stats.winStreak = 0;
  }
  stats.lastPlayed = date;
  stats.lastResult = won ? 'won' : 'lost';
  stats.pending = null;
  save(stats);
}

// A battle that started but never finished (tab closed, page reloaded) is a loss.
export function settleAbandonedGame(stats) {
  if (stats.pending && stats.pending !== stats.lastPlayed) {
    recordResult(stats, stats.pending, false);
  } else if (stats.pending) {
    stats.pending = null;
    save(stats);
  }
  return stats;
}
