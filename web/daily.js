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

// Which version of the team rules (web/battle/team.js) a day's team uses.
// Changes start on a later day, so a day already being played keeps the same
// team for everyone. Practice teams (no date) use the newest.
//   1: up to No. 13 (Nov 13, 2026): random held items
//   2: from No. 14: each Pokémon's own fixed item
export function teamVersion(date) {
  if (!date) return 2;
  return date < '2026-11-14' ? 1 : 2;
}

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

// Streaks run within a calendar month: on the 1st everyone starts over (the
// Discord bot announces the Pokémon Master of the Month that morning). The
// best win streak is kept for all time.
export const sameMonth = (a, b) => Boolean(a && b) && a.slice(0, 7) === b.slice(0, 7);

// Today's result ('won' / 'lost'), or null if today's battle isn't done.
export function resultFor(stats, date) {
  return stats.lastPlayed === date ? stats.lastResult : null;
}

// Streaks as they stand on `date`: missing a day breaks them, and they start
// over at the start of each month.
export function currentStreaks(stats, date) {
  const alive = (stats.lastPlayed === date || stats.lastPlayed === addDays(date, -1)) && sameMonth(stats.lastPlayed, date);
  return { winStreak: alive ? stats.winStreak : 0, dayStreak: alive ? stats.dayStreak : 0 };
}

// From the moment the official battle starts the day counts as played. It
// can be continued after a crash or a closed page that same day (its
// progress is saved: app.js); one left unfinished past midnight is a loss
// (settleAbandonedGame).
export function markBattleStarted(stats, date) {
  if (stats.pending === date || resultFor(stats, date)) return;
  stats.pending = date;
  save(stats);
}

// The parts of the stats a result changes: kept from before it, so a server
// admin can clear it (/dailyred-redo, undoResult).
const RESULT_FIELDS = ['wins', 'losses', 'winStreak', 'bestWinStreak', 'dayStreak', 'lastPlayed', 'lastResult'];

export function recordResult(stats, date, won) {
  if (stats.lastPlayed === date) return;
  stats.before = { date, stats: Object.fromEntries(RESULT_FIELDS.map((k) => [k, stats[k] ?? EMPTY[k]])) };
  const consecutive = stats.lastPlayed === addDays(date, -1) && sameMonth(stats.lastPlayed, date);
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

// Clears the result of `date` (the player's latest), back to how the stats
// were before it: from the copy recordResult keeps, or for a result recorded
// before it kept one, rebuilt from `history` (the player's other results,
// [{ date, won }]). For a battle lost to a crash. Returns false if `date`
// isn't their latest result.
export function undoResult(stats, date, history = []) {
  if (!date || stats.lastPlayed !== date) return false;
  if (stats.before?.date === date) {
    Object.assign(stats, stats.before.stats);
  } else {
    if (stats.lastResult === 'won') stats.wins = Math.max(0, stats.wins - 1);
    else stats.losses = Math.max(0, stats.losses - 1);
    const earlier = history.filter((r) => r.date < date).sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = earlier.at(-1);
    stats.lastPlayed = last?.date ?? null;
    stats.lastResult = last ? (last.won ? 'won' : 'lost') : null;
    // The streaks as they stood after `last`: days in a row within its month.
    let dayStreak = 0;
    let winStreak = 0;
    let wins = true;
    for (let i = earlier.length - 1; i >= 0; i--) {
      const next = earlier[i + 1];
      if (next && !(earlier[i].date === addDays(next.date, -1) && sameMonth(earlier[i].date, next.date))) break;
      dayStreak++;
      if (wins && earlier[i].won) winStreak++;
      else wins = false;
    }
    stats.dayStreak = dayStreak;
    stats.winStreak = winStreak;
  }
  stats.pending = null;
  delete stats.before;
  return true; // the server saves it
}

// A battle that started but never finished is a loss once its day is over.
// `today`: the player's date; today's unfinished battle can still be
// continued, so it's left alone (without `today`, any unfinished battle is
// settled).
export function settleAbandonedGame(stats, today = null) {
  if (stats.pending && stats.pending !== stats.lastPlayed) {
    if (today && stats.pending >= today) return stats;
    recordResult(stats, stats.pending, false);
  } else if (stats.pending) {
    stats.pending = null;
    save(stats);
  }
  return stats;
}
