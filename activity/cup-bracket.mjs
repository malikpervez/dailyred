// The Cup's double-elimination bracket: plain data (saved with the month's
// Cup, see cup-month.mjs) and the rules that move it on.
//
// The bracket is the next power of two up from the number of players (4, 8
// or 16), seeded 1 vs 16, 8 vs 9 and so on; missing players are byes, so the
// top seeds get a free first round. Losing once drops you to the losers'
// bracket; losing twice puts you out. The winners' champion meets the
// losers' champion in the grand final, and if the losers' side wins that,
// there's a reset: one more battle, winner takes the Cup.
//
// A match: { id, part: 'W' | 'L' | 'F', round, slot, label, from: [src, src],
// players: [a, b], winner, loser, how, battleId, details }. A player is an id,
// BYE (nobody), or null (not known yet). `from` says where each player comes
// from: { seed: n }, { match, take: 'winner' | 'loser' }, or { reset: 'F1' }.
// `slot`: which of the Cup's rounds (3 days each) it's due in.

export const BYE = 'bye';

export function bracketSize(players) {
  let size = 4;
  while (size < players) size *= 2;
  return size;
}

// Seed numbers (from 1) in bracket order: 1 v 8, 4 v 5, 2 v 7, 3 v 6.
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

// A new bracket for `players` (ids, best seed first).
export function newBracket(players) {
  const size = bracketSize(players.length);
  const k = Math.log2(size);
  const seeds = Array.from({ length: size }, (_, i) => players[i] ?? BYE);
  const matches = {};
  const add = (id, part, round, slot, label, from) => {
    matches[id] = { id, part, round, slot, label, from, players: [null, null], winner: null, loser: null, how: null, battleId: null, details: null };
  };
  const winnersLabel = (r) => (r === k ? 'Winners final' : r === k - 1 && k >= 3 ? 'Winners semifinal' : `Winners round ${r}`);
  const losersLabel = (j) => (j === 2 * (k - 1) ? 'Losers final' : `Losers round ${j}`);

  // Winners: round r in slot r.
  const order = seedOrder(size);
  for (let i = 0; i < size / 2; i++) {
    add(`W1-${i + 1}`, 'W', 1, 1, winnersLabel(1), [{ seed: order[2 * i] - 1 }, { seed: order[2 * i + 1] - 1 }]);
  }
  for (let r = 2; r <= k; r++) {
    for (let i = 0; i < size / 2 ** r; i++) {
      add(`W${r}-${i + 1}`, 'W', r, r, winnersLabel(r), [{ match: `W${r - 1}-${2 * i + 1}`, take: 'winner' }, { match: `W${r - 1}-${2 * i + 2}`, take: 'winner' }]);
    }
  }
  // Losers: round j in slot j + 1. Odd rounds pair up the losers' side;
  // even ones bring in the losers of the next winners' round (in reverse, so
  // nobody meets the player who just beat them straight away).
  for (let i = 0; i < size / 4; i++) {
    add(`L1-${i + 1}`, 'L', 1, 2, losersLabel(1), [{ match: `W1-${2 * i + 1}`, take: 'loser' }, { match: `W1-${2 * i + 2}`, take: 'loser' }]);
  }
  for (let m = 1; m <= k - 1; m++) {
    const count = size / 2 ** (m + 1);
    for (let i = 0; i < count; i++) {
      add(`L${2 * m}-${i + 1}`, 'L', 2 * m, 2 * m + 1, losersLabel(2 * m), [
        { match: `L${2 * m - 1}-${i + 1}`, take: 'winner' }, { match: `W${m + 1}-${count - i}`, take: 'loser' },
      ]);
    }
    if (m < k - 1) {
      for (let i = 0; i < count / 2; i++) {
        add(`L${2 * m + 1}-${i + 1}`, 'L', 2 * m + 1, 2 * m + 2, losersLabel(2 * m + 1), [
          { match: `L${2 * m}-${2 * i + 1}`, take: 'winner' }, { match: `L${2 * m}-${2 * i + 2}`, take: 'winner' },
        ]);
      }
    }
  }
  // The grand final, and its reset if the losers' champion wins it.
  add('F1', 'F', 1, 2 * k, 'Grand final', [{ match: `W${k}-1`, take: 'winner' }, { match: `L${2 * (k - 1)}-1`, take: 'winner' }]);
  add('F2', 'F', 2, 2 * k + 1, 'Grand final reset', [{ reset: 'F1' }, { reset: 'F1' }]);
  const bracket = { size, slots: 2 * k + 1, seeds, matches };
  resolve(bracket);
  return bracket;
}

const isPlayer = (p) => p != null && p !== BYE;

// Fills in who plays whom from what's been decided, and settles byes and an
// unneeded reset. Returns the matches that just became playable.
export function resolve(bracket) {
  const ready = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const m of Object.values(bracket.matches)) {
      if (m.winner != null) continue;
      if (m.from[0].reset) {
        const final = bracket.matches[m.from[0].reset];
        if (final.winner == null || m.players[0] != null) continue;
        if (final.winner === final.players[0] || !isPlayer(final.players[1])) {
          Object.assign(m, { players: [BYE, BYE], winner: final.winner, loser: BYE, how: 'not needed' });
        } else {
          m.players = [...final.players];
          ready.push(m);
        }
        changed = true;
        continue;
      }
      for (let i = 0; i < 2; i++) {
        if (m.players[i] != null) continue;
        const src = m.from[i];
        const value = src.seed != null ? bracket.seeds[src.seed] : bracket.matches[src.match][src.take];
        if (value != null) {
          m.players[i] = value;
          changed = true;
        }
      }
      const [a, b] = m.players;
      if (a == null || b == null) continue;
      if (!isPlayer(a) || !isPlayer(b)) {
        Object.assign(m, { winner: isPlayer(a) ? a : b, loser: BYE, how: 'bye' });
        changed = true;
      } else if (!m.readied) {
        m.readied = true;
        ready.push(m);
      }
    }
  }
  return ready;
}

// Records a match's result and moves the bracket on. Returns the matches
// that became playable.
export function record(bracket, id, winner, how = 'battle', details = null) {
  const m = bracket.matches[id];
  if (!m || m.winner != null) throw new Error(`Match ${id} isn't on`);
  if (!m.players.includes(winner)) throw new Error(`${winner} isn't in match ${id}`);
  Object.assign(m, { winner, loser: m.players.find((p) => p !== winner), how, details });
  return resolve(bracket);
}

// The matches to play: both players known, not decided yet.
export const playable = (bracket) => Object.values(bracket.matches).filter((m) => m.winner == null && isPlayer(m.players[0]) && isPlayer(m.players[1]));

export function champion(bracket) {
  const reset = bracket.matches.F2;
  return reset.winner != null && isPlayer(reset.winner) ? reset.winner : null;
}

// Each player's wins and losses (byes don't count) and where they stand:
// 'winners', 'losers', 'out' or 'champion'.
export function standings(bracket) {
  const table = new Map();
  for (const id of bracket.seeds) if (isPlayer(id)) table.set(id, { wins: 0, losses: 0, status: 'winners' });
  for (const m of Object.values(bracket.matches)) {
    if (m.winner == null || !isPlayer(m.loser)) continue;
    table.get(m.winner).wins++;
    table.get(m.loser).losses++;
  }
  const top = champion(bracket);
  for (const [id, row] of table) {
    row.status = id === top ? 'champion' : row.losses >= 2 || (top && id !== top) ? 'out' : row.losses === 1 ? 'losers' : 'winners';
  }
  return table;
}

// The order to show matches in: by slot, winners before losers.
export const matchOrder = (bracket) => Object.values(bracket.matches)
  .sort((a, b) => a.slot - b.slot || 'WLF'.indexOf(a.part) - 'WLF'.indexOf(b.part) || a.round - b.round || a.id.localeCompare(b.id, 'en', { numeric: true }));
