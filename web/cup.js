// The Daily Red Cup's page. cup.html?g=<server>: the week's Cup (sign-ups,
// the draft: cup-hub.js). cup.html?b=<battle id>: a battle. The battle runs on
// the server (activity/cup.mjs); this page shows it with Daily Red's battle
// screen (battle/view.js) through the battle engine's remote mode, sends your
// choices and keeps listening. Close it any time: the battle waits for you
// (and after a day without a move, RED's AI makes it for you).
import { startRemote, feedRemote } from './battle/engine.js';
import { createBattleView } from './battle/view.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const battleId = new URLSearchParams(location.search).get('b') ?? '';

const prefs = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* not remembered */ } },
};
let speed = prefs.get('dailyred-speed') === 'fast' ? 'fast' : 'normal';
let animations = prefs.get('dailyred-anims') !== 'off';

let meta = null; // GET /api/cup/battles/<id>: { me, players, team, ended, winner }
let lastRequest = null; // the menus on screen, for its rqid
let finished = false;

const foeName = () => (meta?.me === 'p2' ? meta.players.p1.name : meta?.players.p2.name ?? '');
const setStatus = (text) => { $('cup-status').textContent = text; };

async function call(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { 'X-Daily-Red': '1', ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

function fail(heading, text, { signIn = false } = {}) {
  $('error-heading').textContent = heading;
  $('error-text').textContent = text;
  $('error-signin').hidden = !signIn;
  $('error-signin').href = `auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  app.dataset.state = 'error';
}

const view = createBattleView($('battle-root'), {
  onChoose: (choice) => send(choice),
  onRun: () => askToRun(),
  getSpeed: () => speed,
  getAnimations: () => animations,
  waitText: () => `Waiting for ${foeName()}…`,
});

async function send(choice) {
  setStatus(`Waiting for ${foeName()}`);
  try {
    await call('POST', `api/cup/battles/${battleId}/choose`, { choice, rqid: lastRequest?.rqid });
  } catch (err) {
    if (err.status === 409) return; // that turn was over; the stream brings the new one
    setStatus('Your turn');
    if (lastRequest) view.request({ ...lastRequest, notice: err.message });
  }
}

function askToRun() {
  const dialog = $('run-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'run' && !finished) send('forfeit');
  }, { once: true });
}

function end(won, tie) {
  if (finished) return;
  finished = true;
  const { me, players } = meta;
  const text = me === 'spectator'
    ? (tie ? 'A draw!' : `${won ? players.p1.name : players.p2.name} won!`)
    : won ? `You beat ${foeName()}!` : tie ? 'A draw!' : `${foeName()} won this time.`;
  setStatus('Battle over');
  view.end(text, () => {
    $('done-title').textContent = text;
    $('done-note').textContent = 'The bracket updates by itself.';
    $('battle-done').hidden = false;
  });
}

// The battle's events, from the start (or where the connection dropped).
// Until the server says "live", it's catching up: shown at once, no animations.
function listen() {
  let live = false;
  const source = new EventSource(`api/cup/battles/${battleId}/events`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data);
    if (event.kind === 'live') {
      live = true;
      if (!finished && !lastRequest) setStatus(meta.me === 'spectator' ? 'Watching' : `Waiting for ${foeName()}`);
      return;
    }
    feedRemote(event, !live);
  };
  // EventSource reconnects by itself, picking up from the last event it got.
  source.onerror = () => {
    live = false;
    if (!finished) setStatus('Reconnecting…');
  };
}

async function start() {
  if (!battleId) {
    // No battle: the Cup's own page (sign-ups, the draft).
    const { startHub } = await import('./cup-hub.js');
    startHub();
    return;
  }
  if (!/^[A-Za-z0-9_-]{4,20}$/.test(battleId)) {
    fail('No battle here', "Open your match from the Cup's bracket or the bot's link.");
    return;
  }
  try {
    meta = await call('GET', `api/cup/battles/${battleId}`);
  } catch (err) {
    if (err.status === 401) fail('Sign in to battle', 'Cup battles are between Discord players.', { signIn: true });
    else fail(err.status === 404 ? 'No battle here' : 'Something went wrong', err.message);
    return;
  }
  const mine = meta.me === 'spectator' ? meta.players.p1.name : meta.players[meta.me].name;
  document.title = `Daily Red Cup: ${meta.players.p1.name} vs ${meta.players.p2.name}`;
  $('cup-label').textContent = `${meta.players.p1.name} vs ${meta.players.p2.name}`;
  view.reset({ name: mine, foe: foeName() });
  startRemote({ me: meta.me, team: meta.team, foeName: foeName() }, {
    onEvents: (events, instant) => {
      const turn = events.findLast((e) => e.turn)?.turn;
      if (turn) $('turn-label').textContent = `Turn ${turn}`;
      if (instant) view.catchUp(events);
      else view.play(events);
    },
    onRequest: (request) => {
      if (request.kind === 'wait') return;
      lastRequest = request;
      setStatus('Your turn');
      view.request(request);
    },
    onEnd: (won, tie) => end(won, tie),
    onError: (err) => fail('Something went wrong', err.message),
  });
  app.dataset.state = 'battle';
  listen();
}

function renderSpeed() {
  for (const b of document.querySelectorAll('[data-speed]')) b.setAttribute('aria-pressed', String(b.dataset.speed === speed));
  for (const b of document.querySelectorAll('[data-anims]')) b.setAttribute('aria-pressed', String((b.dataset.anims === 'on') === animations));
}
for (const b of document.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => { speed = b.dataset.speed; prefs.set('dailyred-speed', speed); renderSpeed(); });
}
for (const b of document.querySelectorAll('[data-anims]')) {
  b.addEventListener('click', () => { animations = b.dataset.anims === 'on'; prefs.set('dailyred-anims', animations ? 'on' : 'off'); renderSpeed(); });
}

// For the automated tests.
window.dailyRedCup = { get meta() { return meta; }, setSpeed(next) { speed = next; renderSpeed(); } };

renderSpeed();
start();
