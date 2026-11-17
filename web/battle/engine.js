// The page's side of the battle engine (web/battle/worker.js, bundled into
// vendor/battle-worker.js). One worker is started on first use and reused.

const WORKER_URL = new URL('../vendor/battle-worker.js', import.meta.url);

let worker = null;
let handlers = {};
const teams = new Map(); // "seed:version:trainer" -> Promise of { team, foe }

function onMessage({ data }) {
  switch (data.type) {
    case 'team':
      teams.get(`${data.seed}:${data.version}:${data.trainer}`)?.resolve(data);
      break;
    case 'events':
      handlers.onEvents?.(data.events, Boolean(data.instant));
      break;
    case 'progress':
      handlers.onProgress?.(data.progress);
      break;
    case 'request':
      handlers.onRequest?.(data.request);
      break;
    case 'end':
      handlers.onEnd?.(data.won, data.tie);
      break;
    case 'error':
      handlers.onError?.(new Error(data.message));
      break;
    default:
      break;
  }
}

function getWorker() {
  if (!worker) {
    worker = new Worker(WORKER_URL);
    worker.onmessage = onMessage;
    worker.onerror = (event) => {
      event.preventDefault?.();
      const err = new Error("The battle engine didn't load. Check your connection and reload the page.");
      for (const pending of teams.values()) pending.reject(err);
      teams.clear();
      handlers.onError?.(err);
      worker = null;
    };
  }
  return worker;
}

// Today's team and the trainer's (`foe`), described for the page: species,
// types, item, ability, nature, stats and moves (see describe() in
// worker.js). `version`: the day's team rules (teamVersion in daily.js);
// `trainer`: the day's trainer (trainerOn in road.js).
export function loadTeams(seed, version, trainer) {
  const key = `${seed}:${version}:${trainer}`;
  if (!teams.has(key)) {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    teams.set(key, { promise, resolve, reject });
    getWorker().postMessage({ type: 'team', seed, version, trainer });
  }
  return teams.get(key).promise;
}

// Starts a battle with the seed's team in `order` (indexes into the team, the
// lead first) against `trainer`. `on` gets onEvents(events, instant),
// onRequest, onEnd(won, tie), onProgress(progress) and onError(err).
// `resume`: a battle's last progress, to pick it up where it stopped (its
// events so far come first, with instant set).
export function startBattle({ seed, version, order, name, trainer, resume = null }, on) {
  handlers = on;
  getWorker().postMessage({ type: 'start', seed, version, order, name, trainer, resume });
}

export const choose = (choice) => worker?.postMessage({ type: 'choose', choice });

// The Cup: a battle against another player, run by the server (cup.mjs).
// `me`: 'p1' or 'p2' ('spectator' to watch), `team`: your own sets, for the
// summary screens. Then feedRemote() each event from the server's stream;
// `instant` while catching up on a battle already under way.
export function startRemote({ me, team, foeName }, on) {
  handlers = on;
  getWorker().postMessage({ type: 'remote-start', me, team, foeName });
}
export const feedRemote = (event, instant = false) => worker?.postMessage({ type: 'remote-event', event, instant });
export const forfeit = () => worker?.postMessage({ type: 'forfeit' });

// Stops delivering the current battle's messages (leaving the battle screen).
export function detach() {
  handlers = {};
}
