// The Cup's draft: a snake draft from one shared pool. Every player gets six
// picks, and the pool holds six Pokémon per player, so everything in it ends
// up on someone's team: whoever isn't careful gets what's left.
//
// The order snakes: 1, 2, ... N, then N ... 2, 1, and so on for six rounds.
// When a pick's time runs out (or a player turned on autodraft), the pick is
// the first Pokémon still there on their wish list, or else the best one left
// (highest base stat total).
//
// A draft is plain data (saved as JSON with the rest of the week's Cup, see
// cup-week.mjs): { order: [player ids], pool: [{ set, info, bst }], picks:
// [{ player, pool: index, auto, at }], wishlists: { player id: [indexes] } }.

export const TEAM_SIZE = 6;
export const PICK_SECONDS = 90;

export class DraftError extends Error {}

export function newDraft(order, pool) {
  return { order: [...order], pool, picks: [], wishlists: {} };
}

// The seat (index in `order`) that makes pick number `n` (from 0).
export function seatFor(n, players) {
  const round = Math.floor(n / players);
  const position = n % players;
  return round % 2 === 0 ? position : players - 1 - position;
}

export const totalPicks = (draft) => Math.min(draft.order.length * TEAM_SIZE, draft.pool.length);
export const isDone = (draft) => draft.picks.length >= totalPicks(draft);

// Who's picking now (a player id), or null once the draft is done.
export const onClock = (draft) => (isDone(draft) ? null : draft.order[seatFor(draft.picks.length, draft.order.length)]);

// Round (1-6) and pick within it (1-N) of the pick being made now.
export function pickNumber(draft) {
  const n = draft.picks.length;
  return { round: Math.floor(n / draft.order.length) + 1, pick: (n % draft.order.length) + 1, overall: n + 1 };
}

const taken = (draft) => new Set(draft.picks.map((p) => p.pool));
export const available = (draft) => draft.pool.map((_, i) => i).filter((i) => !taken(draft).has(i));

export function makePick(draft, player, index, { auto = false, at = Date.now() } = {}) {
  if (isDone(draft)) throw new DraftError('The draft is over');
  if (onClock(draft) !== player) throw new DraftError("It's not your pick");
  if (!Number.isInteger(index) || index < 0 || index >= draft.pool.length) throw new DraftError('No such Pokémon');
  if (taken(draft).has(index)) throw new DraftError(`${draft.pool[index].set.species} is already taken`);
  draft.picks.push({ player, pool: index, auto, at });
  return draft.pool[index];
}

// What the autopick takes for `player`: their wish list first, then the
// best Pokémon left (ties: the first in the pool).
export function autoChoice(draft, player) {
  const left = new Set(available(draft));
  const wished = (draft.wishlists[player] ?? []).find((i) => left.has(i));
  if (wished != null) return wished;
  let best = null;
  for (const i of left) if (best == null || draft.pool[i].bst > draft.pool[best].bst) best = i;
  return best;
}

export function autoPick(draft, at = Date.now()) {
  const player = onClock(draft);
  if (player == null) return null;
  return makePick(draft, player, autoChoice(draft, player), { auto: true, at });
}

// A player's wish list: pool indexes, most wanted first. Kept private.
export function setWishlist(draft, player, list) {
  if (!draft.order.includes(player)) throw new DraftError("You're not in this draft");
  if (!Array.isArray(list) || list.length > draft.pool.length) throw new DraftError('Bad wish list');
  const clean = [];
  for (const i of list) {
    if (!Number.isInteger(i) || i < 0 || i >= draft.pool.length) throw new DraftError('Bad wish list');
    if (!clean.includes(i)) clean.push(i);
  }
  draft.wishlists[player] = clean;
  return clean;
}

// A player's team: their sets, in the order they were picked.
export const teamOf = (draft, player) => draft.picks.filter((p) => p.player === player).map((p) => draft.pool[p.pool].set);
