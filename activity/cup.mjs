// The Cup's battles on the server: two players, each in their own browser,
// for as long as it takes. The battle waits for whoever has to choose; they
// can close the page and come back. After AUTOPILOT_MS without a choice,
// RED's AI makes it for them so the bracket keeps moving.
//
//   GET  /api/cup/battles/<id>          { me, players, ended, winner, team }
//   GET  /api/cup/battles/<id>/events   Server-Sent Events: everything this
//                                       player (or a spectator) is allowed to
//                                       see, from the start or Last-Event-ID
//   POST /api/cup/battles/<id>/choose   { choice: 'move 2' | 'switch 3' | 'forfeit', rqid }
//
// Each battle is kept in SQLite as its inputs (cup-engine.mjs), saved after
// every choice, and opened again on demand after a restart.
import { randomBytes } from 'node:crypto';

export const AUTOPILOT_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;

export class CupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// `loadEngine`: the bundled engine (activity/dist/cup-engine.mjs; tests use
// the source). `onFinished(id, { winner, players })`: for the bracket.
export function createCup({
  store,
  loadEngine = () => import('./dist/cup-engine.mjs'),
  now = () => Date.now(),
  autopilotAfter = AUTOPILOT_MS,
  onFinished = () => {},
  log = console,
}) {
  let engine = null;
  const live = new Map(); // id -> { battle, row, listeners: { p1, p2, spectator: Set<res> } }

  async function getEngine() {
    engine ??= await loadEngine();
    return engine;
  }

  function save(entry) {
    const { battle, row } = entry;
    store.saveCupBattle({
      id: row.id, p1Id: row.p1Id, p2Id: row.p2Id, state: battle.state, asked: row.asked,
      winner: battle.ended ? battle.winner : null, ended: battle.ended,
    });
  }

  function send(res, event, n) {
    res.write(`${n != null ? `id: ${n}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
  }

  // Opens a battle from its saved inputs (or the one already open).
  async function open(id) {
    if (live.has(id)) return live.get(id);
    const row = store.getCupBattle(id);
    if (!row) return null;
    const { openBattle } = await getEngine();
    if (live.has(id)) return live.get(id); // opened meanwhile
    const entry = { row, listeners: { p1: new Set(), p2: new Set(), spectator: new Set() } };
    entry.battle = openBattle(row.state, (view, event, n) => {
      if (event.kind === 'request' && !event.request.wait && view !== 'spectator') entry.row.asked[view] = now();
      for (const res of entry.listeners[view]) send(res, event, n);
    });
    live.set(id, entry);
    return entry;
  }

  // A new battle between two players: { id, name, team } each (team: the
  // Showdown sets, lead first). Resolves to its id.
  async function create({ p1, p2, seed }) {
    const { openBattle } = await getEngine();
    const id = randomBytes(6).toString('base64url');
    const battle = openBattle({ seed, p1: { name: p1.name, team: p1.team }, p2: { name: p2.name, team: p2.team } });
    const row = { id, p1Id: p1.id, p2Id: p2.id, asked: { p1: now(), p2: now() } };
    store.saveCupBattle({ id, p1Id: p1.id, p2Id: p2.id, state: battle.state, asked: row.asked });
    live.delete(id);
    return id;
  }

  const sideOf = (row, user) => (user.id === row.p1Id ? 'p1' : user.id === row.p2Id ? 'p2' : 'spectator');

  async function meta(id, user) {
    const entry = await open(id);
    if (!entry) throw new CupError(404, 'No such battle');
    const { battle, row } = entry;
    const me = sideOf(row, user);
    return {
      id,
      me,
      players: { p1: { id: row.p1Id, name: battle.state.p1.name }, p2: { id: row.p2Id, name: battle.state.p2.name } },
      team: me === 'spectator' ? null : battle.state[me].team, // your own sets (moves, natures) for the summary screens
      ended: battle.ended,
      winner: battle.winner,
      waitingOn: battle.waitingOn(),
    };
  }

  // GET .../events: what this viewer may see, as Server-Sent Events.
  async function events(req, res, id, user, since) {
    const entry = await open(id);
    if (!entry) throw new CupError(404, 'No such battle');
    const view = sideOf(entry.row, user);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const from = Math.max(0, Number(req.headers['last-event-id'] ?? since ?? 0) || 0);
    entry.battle.views[view].slice(from).forEach((event, i) => send(res, event, from + i + 1));
    send(res, { kind: 'live' }); // caught up: what follows happens as it happens
    entry.listeners[view].add(res);
    const beat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      entry.listeners[view].delete(res);
    });
  }

  function finish(id, entry) {
    if (!entry.battle.ended) return;
    const { state, winner } = entry.battle;
    try {
      onFinished(id, { winner, players: { p1: entry.row.p1Id, p2: entry.row.p2Id }, names: { p1: state.p1.name, p2: state.p2.name } });
    } catch (err) {
      log.warn(`Cup: after battle ${id} ended: ${err.message}`);
    }
  }

  // POST .../choose
  async function choose(id, user, { choice, rqid } = {}) {
    const entry = await open(id);
    if (!entry) throw new CupError(404, 'No such battle');
    const side = sideOf(entry.row, user);
    if (side === 'spectator') throw new CupError(403, "You're not in this battle");
    if (typeof choice !== 'string' || !choice) throw new CupError(400, 'Missing choice');
    const request = entry.battle.request(side);
    if (choice !== 'forfeit' && rqid != null && request?.rqid !== rqid) throw new CupError(409, 'That turn is over; here is the new one.');
    const error = entry.battle.choose(side, choice);
    if (error) throw new CupError(400, error);
    save(entry);
    finish(id, entry);
    return { ok: true, ended: entry.battle.ended, winner: entry.battle.winner };
  }

  // Every few minutes (server.mjs): RED's AI chooses for anyone who's kept
  // the other player waiting for `autopilotAfter`.
  async function tick() {
    for (const id of store.liveCupBattles()) {
      const entry = await open(id);
      if (!entry || entry.battle.ended) continue;
      let changed = false;
      for (const side of entry.battle.waitingOn()) {
        if (now() - (entry.row.asked[side] ?? 0) < autopilotAfter) continue;
        const error = entry.battle.autopilot(side);
        if (error) log.warn(`Cup: autopilot for ${side} in battle ${id}: ${error}`);
        else changed = true;
      }
      if (changed) {
        save(entry);
        finish(id, entry);
      }
    }
  }

  return { create, meta, events, choose, tick, open };
}
