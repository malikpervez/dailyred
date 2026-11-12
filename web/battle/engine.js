// The page's side of the battle engine (web/battle/worker.js, bundled into
// vendor/battle-worker.js). One worker is started on first use and reused.

const WORKER_URL = new URL('../vendor/battle-worker.js', import.meta.url);

let worker = null;
let handlers = {};
const teams = new Map(); // seed -> Promise of { team, red }

function onMessage({ data }) {
  switch (data.type) {
    case 'team':
      teams.get(data.seed)?.resolve(data);
      break;
    case 'events':
      handlers.onEvents?.(data.events);
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

// Today's team and RED's, described for the page: species, types, item,
// ability, nature, stats and moves (see describe() in worker.js).
export function loadTeams(seed) {
  if (!teams.has(seed)) {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    teams.set(seed, { promise, resolve, reject });
    getWorker().postMessage({ type: 'team', seed });
  }
  return teams.get(seed).promise;
}

// Starts a battle with the seed's team in `order` (indexes into the team, the
// lead first). `on` gets onEvents, onRequest, onEnd(won, tie) and onError(err).
export function startBattle({ seed, order, name }, on) {
  handlers = on;
  getWorker().postMessage({ type: 'start', seed, order, name });
}

export const choose = (choice) => worker?.postMessage({ type: 'choose', choice });
export const forfeit = () => worker?.postMessage({ type: 'forfeit' });

// Stops delivering the current battle's messages (leaving the battle screen).
export function detach() {
  handlers = {};
}
