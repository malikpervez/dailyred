// The Daily Red Cup: one a month per Discord server. In New York time:
//
//   the 25th, 6 AM   sign-ups for next month's Cup open (up to MAX_PLAYERS;
//                    join on the Cup page or with the bot's Join button)
//   the 1st, 6 PM    sign-ups close. With fewer than MIN_PLAYERS there's no
//                    Cup that month. Otherwise the draft order is drawn and the
//                    pool revealed (six Pokémon per player, cup-draft.mjs), so
//                    everyone can look it over and rank a wish list.
//   the 1st, 8 PM    the live snake draft: PICK_SECONDS per pick, then the
//                    autopick. Players who can't be there turn on autodraft.
//
// Then the bracket, from the 2nd: a round every ROUND_DAYS days (not here yet).
//
// Stages: 'signup' -> 'pool' -> 'draft' -> 'drafted', or 'cancelled'. Each
// Cup is saved whole (store.saveCup) after every change, so a restart picks
// up where it was; tick() (every couple of seconds, server.mjs) moves the
// stages on and makes the autopicks.
//
//   GET  /api/cup?g=<server>          the month's Cup as this player sees it
//   GET  /api/cup/events?g=<server>   Server-Sent Events: the same, on every change
//   POST /api/cup/join|leave          { g }
//   POST /api/cup/wishlist            { g, list: [pool indexes] }
//   POST /api/cup/autodraft           { g, on }
//   POST /api/cup/pick                { g, index }
import { randomInt } from 'node:crypto';
import {
  newDraft, onClock, makePick, autoPick, setWishlist, isDone, pickNumber, teamOf, totalPicks,
  PICK_SECONDS, TEAM_SIZE, DraftError,
} from './cup-draft.mjs';

export const MAX_PLAYERS = 16;
export const MIN_PLAYERS = 4;
export const ROUND_DAYS = 3;
export const TIME_ZONE = 'America/New_York';
const HEARTBEAT_MS = 25 * 1000;

export class CupMonthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The date and time on the clock in `zone` at `ms`.
export function zonedParts(ms, zone = TIME_ZONE) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// The moment it's `time` on `date` on the clock in `zone`.
export function zonedTime(date, time, zone = TIME_ZONE) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (ms) => {
    const p = zonedParts(ms, zone);
    return zonedTimeUtc(p) - ms;
  };
  const first = wall - offset(wall);
  return wall - offset(first); // again, in case the first guess crossed a clock change
}
const zonedTimeUtc = ({ date, time }) => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm);
};

// 'YYYY-MM' months.
export const monthOf = (ms, zone = TIME_ZONE) => zonedParts(ms, zone).date.slice(0, 7);
export function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// When `month`'s Cup happens.
export function scheduleFor(month, zone = TIME_ZONE) {
  return {
    signupsOpen: zonedTime(`${previousMonth(month)}-25`, '06:00', zone),
    signupsClose: zonedTime(`${month}-01`, '18:00', zone),
    draft: zonedTime(`${month}-01`, '20:00', zone),
    bracket: zonedTime(`${month}-02`, '00:00', zone), // round 1
  };
}

export function createCupMonth({
  store,
  loadEngine = () => import('./dist/cup-engine.mjs'),
  now = () => Date.now(),
  timeZone = TIME_ZONE,
  random = randomInt, // (max) -> 0..max-1
  onChange = () => {}, // (cup, what): for the bot's posts
  log = console,
}) {
  let engine = null;
  const listeners = new Map(); // cup id -> Set of { userId, send }

  // The month whose Cup is up now: this month's, until sign-ups for the
  // next one open on the 25th.
  const cupMonth = () => {
    const month = monthOf(now(), timeZone);
    return now() >= scheduleFor(nextMonth(month), timeZone).signupsOpen ? nextMonth(month) : month;
  };
  const idFor = (guildId, month) => `${guildId}:${month}`;

  function save(cup, what) {
    store.saveCup(cup);
    for (const listener of listeners.get(cup.id) ?? []) listener.send(view(cup, listener.userId));
    try {
      onChange(cup, what);
    } catch (err) {
      log.warn(`Cup: after ${what}: ${err.message}`);
    }
  }

  // The server's Cup for the month that's up (cupMonth()), made when its
  // sign-ups open.
  function current(guildId) {
    const month = cupMonth();
    const saved = store.getCup(idFor(guildId, month));
    if (saved) return saved;
    const times = scheduleFor(month, timeZone);
    if (now() < times.signupsOpen) return null;
    const cup = { id: idFor(guildId, month), guildId, month, stage: 'signup', players: [], autodraft: {}, draft: null, clock: null };
    if (now() >= times.signupsClose) {
      cup.stage = 'cancelled'; // nobody signed up in time
      cup.reason = 'nobody';
      store.saveCup(cup);
      return cup;
    }
    save(cup, 'opened');
    return cup;
  }

  // What the page shows.
  const latest = (guildId) => current(guildId) ?? store.latestCup(guildId);

  // --- Sign-ups -----------------------------------------------------------------------

  // Until 6 PM (even if tick() hasn't closed them yet).
  const signupsOpen = (cup) => cup?.stage === 'signup' && now() < scheduleFor(cup.month, timeZone).signupsClose;

  function join(guildId, user) {
    const cup = current(guildId);
    if (!cup) throw new CupMonthError(409, 'Sign-ups open on the 25th at 6 AM ET.');
    if (!signupsOpen(cup)) throw new CupMonthError(409, 'Sign-ups for this Cup are closed. The next one opens on the 25th.');
    if (cup.players.some((p) => p.id === user.id)) return cup;
    if (cup.players.length >= MAX_PLAYERS) throw new CupMonthError(409, `This Cup is full (${MAX_PLAYERS} players).`);
    cup.players.push({ id: user.id, name: String(user.name ?? 'Trainer').slice(0, 40), avatarUrl: user.avatarUrl ?? null });
    save(cup, 'joined');
    return cup;
  }

  function leave(guildId, user) {
    const cup = current(guildId);
    if (!signupsOpen(cup)) throw new CupMonthError(409, "Sign-ups are closed: you're in this Cup.");
    const before = cup.players.length;
    cup.players = cup.players.filter((p) => p.id !== user.id);
    if (cup.players.length !== before) save(cup, 'left');
    return cup;
  }

  // --- The draft -----------------------------------------------------------------------

  async function getEngine() {
    engine ??= await loadEngine();
    return engine;
  }

  // 6 PM: the order (drawn at random) and the pool.
  async function closeSignups(id) {
    const { draftPool } = await getEngine();
    const cup = store.getCup(id); // as it is now, after the wait
    if (cup?.stage !== 'signup') return;
    if (cup.players.length < MIN_PLAYERS) {
      cup.stage = 'cancelled';
      cup.reason = 'too-few';
      save(cup, 'cancelled');
      return;
    }
    const order = cup.players.map((p) => p.id);
    for (let i = order.length - 1; i > 0; i--) {
      const j = random(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    cup.players = order.map((id) => cup.players.find((p) => p.id === id));
    cup.poolSeed = random(2 ** 31);
    cup.draft = newDraft(order, draftPool(cup.poolSeed, order.length * TEAM_SIZE));
    cup.stage = 'pool';
    save(cup, 'closed');
  }

  // Autopicks for whoever's out of time or on autodraft, then the next
  // pick's clock. Returns whether anything changed.
  function advance(cup) {
    let changed = false;
    while (cup.stage === 'draft' && !isDone(cup.draft)) {
      const player = onClock(cup.draft);
      const late = now() >= cup.clock + PICK_SECONDS * 1000;
      if (!late && !cup.autodraft[player]) break;
      autoPick(cup.draft, now());
      cup.clock = now();
      changed = true;
    }
    if (cup.stage === 'draft' && isDone(cup.draft)) {
      cup.stage = 'drafted';
      cup.clock = null;
      changed = true;
    }
    return changed;
  }

  function pick(guildId, user, index) {
    const cup = current(guildId);
    if (cup?.stage !== 'draft') throw new CupMonthError(409, cup?.stage === 'pool' ? 'The draft starts at 8 PM ET.' : "The draft isn't on.");
    try {
      makePick(cup.draft, user.id, index, { at: now() });
    } catch (err) {
      if (err instanceof DraftError) throw new CupMonthError(409, err.message);
      throw err;
    }
    cup.clock = now();
    advance(cup);
    save(cup, cup.stage === 'drafted' ? 'drafted' : 'picked');
    return cup;
  }

  function inDraft(guildId, user) {
    const cup = current(guildId);
    if (!cup?.draft || !['pool', 'draft'].includes(cup.stage)) throw new CupMonthError(409, "The pool isn't out yet: it's revealed when sign-ups close.");
    if (!cup.draft.order.includes(user.id)) throw new CupMonthError(403, "You're not in this Cup.");
    return cup;
  }

  function wishlist(guildId, user, list) {
    const cup = inDraft(guildId, user);
    try {
      setWishlist(cup.draft, user.id, list);
    } catch (err) {
      throw new CupMonthError(400, err.message);
    }
    store.saveCup(cup); // private: nobody else's page changes
    return cup;
  }

  function autodraft(guildId, user, on) {
    const cup = inDraft(guildId, user);
    cup.autodraft[user.id] = Boolean(on);
    const picked = advance(cup);
    save(cup, cup.stage === 'drafted' ? 'drafted' : picked ? 'picked' : 'autodraft');
    return cup;
  }

  // Every couple of seconds: the schedule and the pick clock.
  async function tick() {
    for (const { id } of store.activeCups()) {
      const cup = store.getCup(id);
      const times = scheduleFor(cup.month, timeZone);
      if (cup.stage === 'signup' && now() >= times.signupsClose) {
        await closeSignups(id);
      } else if (cup.stage === 'pool' && now() >= times.draft) {
        cup.stage = 'draft';
        cup.clock = now();
        advance(cup);
        save(cup, 'started');
      } else if (cup.stage === 'draft' && advance(cup)) {
        save(cup, cup.stage === 'drafted' ? 'drafted' : 'picked');
      }
    }
  }

  // --- What the page sees -----------------------------------------------------------------

  function view(cup, userId) {
    if (!cup) {
      const month = cupMonth();
      return { stage: 'none', month, times: scheduleFor(month, timeZone), next: { month: nextMonth(month), ...scheduleFor(nextMonth(month), timeZone) }, max: MAX_PLAYERS, min: MIN_PLAYERS, now: now(), roundDays: ROUND_DAYS };
    }
    const { draft } = cup;
    const joined = cup.players.some((p) => p.id === userId);
    const drafting = draft && !isDone(draft);
    return {
      id: cup.id,
      month: cup.month,
      stage: cup.stage,
      reason: cup.reason ?? null,
      times: scheduleFor(cup.month, timeZone),
      next: { month: nextMonth(cup.month), ...scheduleFor(nextMonth(cup.month), timeZone) }, // the next Cup's sign-ups
      roundDays: ROUND_DAYS,
      now: now(), // the server's clock, for the countdowns
      max: MAX_PLAYERS,
      min: MIN_PLAYERS,
      players: cup.players.map((p) => ({ ...p, autodraft: Boolean(cup.autodraft[p.id]) })),
      me: {
        id: userId,
        joined,
        wishlist: draft?.wishlists[userId] ?? [],
        autodraft: Boolean(cup.autodraft[userId]),
      },
      pool: draft ? draft.pool.map((p) => ({ ...p.info, bst: p.bst })) : null,
      picks: draft ? draft.picks.map(({ player, pool, auto }) => ({ player, pool, auto })) : [],
      totalPicks: draft ? totalPicks(draft) : 0,
      onClock: cup.stage === 'draft' && drafting ? onClock(draft) : null,
      pick: cup.stage === 'draft' && drafting ? pickNumber(draft) : null,
      deadline: cup.stage === 'draft' && drafting ? cup.clock + PICK_SECONDS * 1000 : null,
      pickSeconds: PICK_SECONDS,
    };
  }

  // GET /api/cup/events: the Cup as this player sees it, now and on every change.
  function events(req, res, guildId, user) {
    const cup = latest(guildId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send(view(cup, user.id));
    const id = cup?.id ?? idFor(guildId, cupMonth());
    const listener = { userId: user.id, send };
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(listener);
    const beat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      listeners.get(id)?.delete(listener);
      if (!listeners.get(id)?.size) listeners.delete(id);
    });
  }

  return {
    current,
    latest,
    join,
    leave,
    pick,
    wishlist,
    autodraft,
    tick,
    events,
    view: (guildId, user) => view(latest(guildId), user.id),
    teamOf: (cup, playerId) => (cup.draft ? teamOf(cup.draft, playerId) : []),
  };
}
