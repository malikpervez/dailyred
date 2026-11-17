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
//   the 2nd          the double-elimination bracket (cup-bracket.mjs), seeded
//                    at random: a round every ROUND_DAYS days. A match is one
//                    battle (cup.mjs), played whenever both players are on, and
//                    can be played early once both are known. At the round's
//                    end, a battle still going is lost by whoever's holding it
//                    up (cup.mjs timeOut()); a match nobody started goes to
//                    one of them at random. The champion: stage 'done'.
//
// Stages: 'signup' -> 'pool' -> 'draft' -> 'drafted' -> 'bracket' -> 'done',
// or 'cancelled'. Each Cup is saved whole (store.saveCup) after every change,
// so a restart picks up where it was; tick() (every couple of seconds,
// server.mjs) moves the stages on, makes the autopicks and ends late matches.
//
//   GET  /api/cup?g=<server>          the month's Cup as this player sees it
//   GET  /api/cup/events?g=<server>   Server-Sent Events: the same, on every change
//   POST /api/cup/join|leave          { g }
//   POST /api/cup/wishlist            { g, list: [pool indexes] }
//   POST /api/cup/autodraft           { g, on }
//   POST /api/cup/pick                { g, index }
//   POST /api/cup/lead                { g, index }   your lead for your next battles (0-5)
//   POST /api/cup/play                { g } -> { battleId }   your match's battle (made if need be)
import { randomInt } from 'node:crypto';
import {
  newDraft, onClock, makePick, autoPick, setWishlist, isDone, pickNumber, teamOf, totalPicks,
  PICK_SECONDS, TEAM_SIZE, DraftError,
} from './cup-draft.mjs';
import { newBracket, record, playable, champion, standings, matchOrder, BYE } from './cup-bracket.mjs';

export const MAX_PLAYERS = 16;
export const MIN_PLAYERS = 4;
export const ROUND_DAYS = 3;
export const TIME_ZONE = 'America/New_York';
const HEARTBEAT_MS = 25 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

const plusDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// When round `slot` (from 1) of `month`'s bracket ends: midnight after its
// ROUND_DAYS days, counting from the 2nd.
export const slotEnd = (month, slot, zone = TIME_ZONE) => zonedTime(plusDays(`${month}-02`, ROUND_DAYS * slot), '00:00', zone);

export function createCupMonth({
  store,
  battles = null, // cup.mjs: the matches' battles
  loadEngine = () => import('./dist/cup-engine.mjs'),
  now = () => Date.now(),
  timeZone = TIME_ZONE,
  random = randomInt, // (max) -> 0..max-1
  onChange = () => {}, // (cup, what, details): for the bot's posts
  log = console,
}) {
  let engine = null;
  const listeners = new Map(); // guild id -> Set of { userId, send }
  const creating = new Map(); // match -> promise of its battle id

  // The month whose Cup is up now: this month's, until sign-ups for the
  // next one open on the 25th.
  const cupMonth = () => {
    const month = monthOf(now(), timeZone);
    return now() >= scheduleFor(nextMonth(month), timeZone).signupsOpen ? nextMonth(month) : month;
  };
  const idFor = (guildId, month) => `${guildId}:${month}`;
  const shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = random(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  function save(cup, what, details = {}) {
    store.saveCup(cup);
    for (const listener of listeners.get(cup.guildId) ?? []) listener.send(pageView(cup.guildId, listener.userId));
    try {
      onChange(cup, what, details);
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

  // This calendar month's Cup, whose bracket may still be on after next
  // month's sign-ups open.
  const thisMonths = (guildId) => store.getCup(idFor(guildId, monthOf(now(), timeZone)));

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
    const order = shuffle(cup.players.map((p) => p.id));
    cup.players = order.map((id) => cup.players.find((p) => p.id === id));
    cup.poolSeed = random(2 ** 31);
    cup.draft = newDraft(order, draftPool(cup.poolSeed, order.length * TEAM_SIZE));
    cup.stage = 'pool';
    save(cup, 'closed');
  }

  // Autopicks for whoever's out of time or on autodraft, then the next
  // pick's clock. When the last pick's made, the bracket is drawn (seeded at
  // random). Returns whether anything changed.
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
      cup.bracket = newBracket(shuffle(cup.draft.order));
      cup.leads = {};
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

  // --- The bracket ----------------------------------------------------------------------

  // A player's team for a battle: their six as drafted, their lead first.
  function teamFor(cup, playerId) {
    const team = teamOf(cup.draft, playerId);
    const lead = Math.min(cup.leads?.[playerId] ?? 0, team.length - 1);
    return [team[lead], ...team.filter((_, i) => i !== lead)];
  }

  // The match a player has to play now (both players known), if any.
  const myMatch = (cup, playerId) => playable(cup.bracket).filter((m) => m.players.includes(playerId)).sort((a, b) => a.slot - b.slot)[0] ?? null;

  function bracketCup(guildId, stages = ['bracket']) {
    const cup = thisMonths(guildId);
    if (!cup?.bracket || !stages.includes(cup.stage)) {
      throw new CupMonthError(409, cup?.stage === 'drafted' ? 'The bracket starts on the 2nd at midnight ET.' : "There's no Cup bracket on right now.");
    }
    return cup;
  }

  // POST /api/cup/lead: the Pokémon you send out first, from now on.
  function setLead(guildId, user, index) {
    const cup = bracketCup(guildId, ['drafted', 'bracket']);
    const team = teamOf(cup.draft, user.id);
    if (!team.length) throw new CupMonthError(403, "You're not in this Cup.");
    if (!Number.isInteger(index) || index < 0 || index >= team.length) throw new CupMonthError(400, 'No such Pokémon');
    cup.leads = { ...cup.leads, [user.id]: index };
    store.saveCup(cup); // only your page shows it
    return cup;
  }

  // POST /api/cup/play: your match's battle, made the first time either
  // player asks (with both leads as they are then).
  async function play(guildId, user) {
    const cup = bracketCup(guildId);
    const m = myMatch(cup, user.id);
    if (!m) throw new CupMonthError(409, "You don't have a match to play right now.");
    if (m.battleId) return m.battleId;
    if (now() >= slotEnd(cup.month, m.slot, timeZone)) throw new CupMonthError(409, "Time's up for this match.");
    if (!battles) throw new CupMonthError(503, "Battles aren't running on this server.");
    const key = `${cup.id}:${m.id}`;
    if (!creating.has(key)) {
      const name = (id) => cup.players.find((p) => p.id === id)?.name ?? 'Trainer';
      const [a, b] = m.players;
      creating.set(key, battles.create({
        p1: { id: a, name: name(a), team: teamFor(cup, a) },
        p2: { id: b, name: name(b), team: teamFor(cup, b) },
        context: { cupId: cup.id, guildId, match: m.id, label: m.label },
      }).then((battleId) => {
        const fresh = store.getCup(cup.id); // as it is now, after the wait
        const match = fresh.bracket.matches[m.id];
        if (!match.battleId && match.winner == null) {
          match.battleId = battleId;
          save(fresh, 'match-started', { match });
        }
        return match.battleId;
      }).finally(() => creating.delete(key)));
    }
    return creating.get(key);
  }

  function finishMatch(cup, matchId, winner, how, details = null) {
    const ready = record(cup.bracket, matchId, winner, how, details);
    const top = champion(cup.bracket);
    if (top) {
      cup.stage = 'done';
      cup.champion = top;
    }
    save(cup, top ? 'champion' : 'result', { match: cup.bracket.matches[matchId], ready });
  }

  // cup.mjs: a match's battle is over (or timed out).
  function battleEnded(battleId, result) {
    const context = result?.context;
    if (!context?.cupId) return;
    const cup = store.getCup(context.cupId);
    const m = cup?.bracket?.matches[context.match];
    if (!m || m.winner != null || m.battleId !== battleId) return;
    if (!result.winner) {
      // A draw (both last Pokémon down at once): play it again.
      m.battleId = null;
      m.draws = (m.draws ?? 0) + 1;
      save(cup, 'draw', { match: m });
      return;
    }
    const side = result.winner;
    finishMatch(cup, m.id, result.players[side], result.how, { turns: result.turns, left: result.left?.[side] ?? null, battleId });
  }

  // Matches past their round's end; reminders a day before.
  async function bracketTick(id) {
    const ids = playable(store.getCup(id).bracket).map((m) => m.id);
    for (const matchId of ids) {
      let cup = store.getCup(id);
      let m = cup.bracket.matches[matchId];
      if (m.winner != null) continue;
      const deadline = slotEnd(cup.month, m.slot, timeZone);
      if (now() >= deadline) {
        if (m.battleId && battles) {
          await battles.timeOut(m.battleId, () => random(1000) / 1000); // battleEnded() records it
          cup = store.getCup(id);
          m = cup.bracket.matches[matchId];
        }
        // Nobody started it (or its battle is gone): a coin toss.
        if (m.winner == null) finishMatch(cup, matchId, m.players[random(2)], 'no-show');
      } else if (!m.reminded && now() >= deadline - DAY_MS) {
        m.reminded = true;
        save(cup, 'reminder', { match: m });
      }
    }
  }

  // Every couple of seconds: the schedule, the pick clock, the bracket.
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
        save(cup, cup.stage === 'drafted' ? 'drafted' : 'started');
      } else if (cup.stage === 'draft' && advance(cup)) {
        save(cup, cup.stage === 'drafted' ? 'drafted' : 'picked');
      } else if (cup.stage === 'drafted' && cup.bracket && now() >= times.bracket) {
        cup.stage = 'bracket';
        save(cup, 'bracket', { ready: playable(cup.bracket) });
      } else if (cup.stage === 'bracket') {
        await bracketTick(id);
      }
    }
  }

  // --- What the page sees -----------------------------------------------------------------

  function bracketView(cup, userId) {
    const { bracket } = cup;
    const table = standings(bracket);
    const mine = myMatch(cup, userId);
    // Where you go next, while your opponent isn't known yet.
    const waiting = !mine && Object.values(bracket.matches)
      .filter((m) => m.winner == null && m.players.includes(userId))
      .sort((a, b) => a.slot - b.slot)[0];
    const feeder = waiting && waiting.from.map((src) => src.match).find((id, i) => id && waiting.players[i] == null);
    return {
      slots: Array.from({ length: bracket.slots }, (_, i) => ({ slot: i + 1, ends: slotEnd(cup.month, i + 1, timeZone) })),
      matches: matchOrder(bracket).map((m) => ({
        id: m.id, label: m.label, part: m.part, slot: m.slot, from: m.from, players: m.players, winner: m.winner, loser: m.loser,
        how: m.how, details: m.details, battleId: m.battleId, draws: m.draws ?? 0, deadline: slotEnd(cup.month, m.slot, timeZone),
      })),
      standings: Object.fromEntries(table),
      mine: mine && {
        id: mine.id, label: mine.label, opponent: mine.players.find((p) => p !== userId), battleId: mine.battleId,
        deadline: slotEnd(cup.month, mine.slot, timeZone), draws: mine.draws ?? 0,
      },
      next: waiting ? { id: waiting.id, label: waiting.label, waitingOn: feeder ?? null } : null,
    };
  }

  function view(cup, userId) {
    if (!cup) {
      const month = cupMonth();
      return { stage: 'none', month, times: scheduleFor(month, timeZone), next: { month: nextMonth(month), ...scheduleFor(nextMonth(month), timeZone) }, max: MAX_PLAYERS, min: MIN_PLAYERS, now: now(), roundDays: ROUND_DAYS };
    }
    const { draft } = cup;
    const joined = cup.players.some((p) => p.id === userId);
    const drafting = draft && !isDone(draft);
    const teamIndexes = draft && joined ? draft.picks.filter((p) => p.player === userId).map((p) => p.pool) : [];
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
        team: teamIndexes, // pool indexes, in pick order
        lead: cup.leads?.[userId] ?? 0, // index into team
      },
      pool: draft ? draft.pool.map((p) => ({ ...p.info, bst: p.bst })) : null,
      picks: draft ? draft.picks.map(({ player, pool, auto }) => ({ player, pool, auto })) : [],
      totalPicks: draft ? totalPicks(draft) : 0,
      onClock: cup.stage === 'draft' && drafting ? onClock(draft) : null,
      pick: cup.stage === 'draft' && drafting ? pickNumber(draft) : null,
      deadline: cup.stage === 'draft' && drafting ? cup.clock + PICK_SECONDS * 1000 : null,
      pickSeconds: PICK_SECONDS,
      bracket: cup.bracket ? bracketView(cup, userId) : null,
      champion: cup.champion ?? null,
    };
  }

  // The page: the Cup that's up; while this month's bracket is still on after
  // next month's sign-ups open, that bracket, with the sign-ups alongside.
  // Plus the reigning champion.
  function pageView(guildId, userId) {
    const upcoming = current(guildId);
    const running = thisMonths(guildId);
    const main = running && running.id !== upcoming?.id && ['drafted', 'bracket'].includes(running.stage) ? running : upcoming ?? store.latestCup(guildId);
    const out = view(main, userId);
    if (upcoming && upcoming.id !== main?.id) out.signup = view(upcoming, userId);
    const last = store.lastChampion(guildId);
    out.reigning = last ? { month: last.month, id: last.champion, name: last.players.find((p) => p.id === last.champion)?.name ?? 'Trainer' } : null;
    return out;
  }

  // GET /api/cup/events: the Cup as this player sees it, now and on every change.
  function events(req, res, guildId, user) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    send(pageView(guildId, user.id));
    const listener = { userId: user.id, send };
    if (!listeners.has(guildId)) listeners.set(guildId, new Set());
    listeners.get(guildId).add(listener);
    const beat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      listeners.get(guildId)?.delete(listener);
      if (!listeners.get(guildId)?.size) listeners.delete(guildId);
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
    setLead,
    play,
    battleEnded,
    tick,
    events,
    view: (guildId, user) => pageView(guildId, user.id),
    teamOf: (cup, playerId) => (cup.draft ? teamOf(cup.draft, playerId) : []),
    teamFor,
  };
}

export { BYE };
