// Tests for the activity server (app.mjs) with a fake Discord API:
//   cd activity && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createApp, avatarUrl } from '../app.mjs';
import { openStore } from '../store.mjs';

const TODAY = '2026-11-06';
const USERS = {
  'token-ash': { id: '80351110224678912', username: 'ash', global_name: 'Ash', avatar: 'abc123' },
  'token-gary': { id: '175928847299117063', username: 'gary', global_name: null, avatar: null },
};

let base;
let server;
let webRoot;
let clock = new Date(`${TODAY}T12:00:00Z`);
const calls = { me: 0, token: [] };

// Stands in for discord.com/api: the OAuth2 code exchange and /users/@me.
async function fakeDiscord(url, init = {}) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('/oauth2/token')) {
    const form = new URLSearchParams(init.body);
    calls.token.push(Object.fromEntries(form));
    if (form.get('client_secret') !== 'secret' || !form.get('code').startsWith('code-')) return json(400, { error: 'invalid_grant' });
    return json(200, { access_token: `token-${form.get('code').slice(5)}`, expires_in: 604800, scope: 'identify' });
  }
  if (url.endsWith('/users/@me')) {
    calls.me++;
    const user = USERS[init.headers.Authorization.replace('Bearer ', '')];
    return user ? json(200, user) : json(401, { message: '401: Unauthorized' });
  }
  return json(404, {});
}

before(async () => {
  webRoot = mkdtempSync(join(tmpdir(), 'dailyred-web-'));
  writeFileSync(join(webRoot, 'index.html'), `<!doctype html><title>Daily Red</title>${'<p>snow</p>'.repeat(200)}`);
  writeFileSync(join(webRoot, 'app.js'), 'console.log("hi");');
  writeFileSync(join(webRoot, '.secret'), 'nope');
  const handle = createApp({
    webRoot,
    store: openStore(':memory:'),
    clientId: '1234567890',
    clientSecret: 'secret',
    fetch: fakeDiscord,
    now: () => clock,
  });
  server = createServer(handle);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(webRoot, { recursive: true, force: true });
});

const get = (path, token, headers = {}) => fetch(base + path, { headers: { ...(token && { Authorization: `Bearer ${token}` }), ...headers } });
const post = (path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});
const battle = (token, body) => post('/api/battle', { room: 'g:42', ...body }, token);

test('serves the site, gzipped, with revalidation', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(await page.text(), /Daily Red/);

  const again = await get('/', null, { 'If-None-Match': page.headers.get('etag') });
  assert.equal(again.status, 304);

  // fetch() unpacks gzip itself, so ask with raw node:http-like headers via HEAD + manual check.
  const raw = await new Promise((ok) => {
    import('node:http').then(({ get: httpGet }) => httpGet(`${base}/index.html`, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => ok({ headers: res.headers, body: Buffer.concat(chunks) }));
    }));
  });
  assert.equal(raw.headers['content-encoding'], 'gzip');
  assert.match(gunzipSync(raw.body).toString(), /Daily Red/);
});

test('accepts the /.proxy prefix Discord can add', async () => {
  const res = await get('/.proxy/app.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal((await (await get('/.proxy/api/config')).json()).clientId, '1234567890');
});

test("doesn't serve dotfiles or anything outside web/", async () => {
  assert.equal((await get('/.secret')).status, 404);
  assert.equal((await get('/%2e%2e%2fpackage.json')).status, 403);
  assert.equal((await get('/nope.js')).status, 404);
  assert.equal((await get('/%E0%A4%A')).status, 400);
});

test('exchanges the OAuth2 code with the client secret', async () => {
  const ok = await post('/api/token', { code: 'code-ash' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).access_token, 'token-ash');
  assert.deepEqual(calls.token.at(-1), { client_id: '1234567890', client_secret: 'secret', grant_type: 'authorization_code', code: 'code-ash' });

  const refused = await post('/api/token', { code: 'stolen' });
  assert.equal(refused.status, 401);
  assert.equal((await refused.json()).error, 'Discord sign-in failed (invalid_grant)', "Discord's reason is passed on");
  assert.equal((await post('/api/token', {})).status, 400);
  assert.equal((await fetch(`${base}/api/token`, { method: 'POST', body: 'not json' })).status, 400);
});

test('the API needs a valid Discord token', async () => {
  assert.equal((await get('/api/me')).status, 401);
  assert.equal((await get('/api/me', 'token-nobody')).status, 401);
  const res = await get('/api/me', 'token-ash');
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.deepEqual(user, { id: USERS['token-ash'].id, name: 'Ash', avatarUrl: avatarUrl(USERS['token-ash']) });
});

test('a daily win: start, result, then locked for the day', async () => {
  const before = calls.me;
  let res = await get('/api/me?settle=1&room=g:42', 'token-ash');
  assert.deepEqual((await res.json()).stats, { wins: 0, losses: 0, winStreak: 0, bestWinStreak: 0, dayStreak: 0, lastPlayed: null, lastResult: null, pending: null });

  res = await battle('token-ash', { event: 'start', date: TODAY });
  assert.equal((await res.json()).stats.pending, TODAY);

  res = await battle('token-ash', { event: 'result', date: TODAY, won: true, monsLeft: 4, redLeft: 0, turns: 18 });
  let { stats } = await res.json();
  assert.deepEqual(stats, { wins: 1, losses: 0, winStreak: 1, bestWinStreak: 1, dayStreak: 1, lastPlayed: TODAY, lastResult: 'won', pending: null });

  // A second result for the same day changes nothing (one battle a day).
  res = await battle('token-ash', { event: 'result', date: TODAY, won: false });
  ({ stats } = await res.json());
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 0);

  // The token was only checked with Discord once (it's cached).
  assert.equal(calls.me - before, 0);
});

test("the board lists the server's players, today's results first", async () => {
  // Gary has started but not finished.
  await get('/api/me?settle=1&room=g:42', 'token-gary');
  await battle('token-gary', { event: 'start', date: TODAY });

  const res = await get(`/api/board?room=g:42&date=${TODAY}`, 'token-gary');
  const { players } = await res.json();
  assert.deepEqual(players.map((p) => [p.name, p.today, p.winStreak, p.you]), [
    ['Ash', 'won', 1, false],
    ['gary', 'battling', 0, true],
  ]);
  assert.match(players[1].avatarUrl, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  // How Ash's battle went, for the board's squares and the leaderboard tabs.
  assert.deepEqual(players[0].result, { won: true, monsLeft: 4, redLeft: 0, turns: 18 });
  assert.deepEqual([players[0].bestWinStreak, players[0].played, players[0].winRate], [1, 1, 100]);
  assert.deepEqual([players[0].monthWins, players[0].monthLosses, players[1].monthWins], [1, 0, 0]);
  assert.equal(players[1].result, null);

  // Other servers have their own lists.
  const other = await (await get(`/api/board?room=g:43&date=${TODAY}`, 'token-gary')).json();
  assert.deepEqual(other.players, []);
  assert.equal((await get(`/api/board?room=nope&date=${TODAY}`, 'token-gary')).status, 400);
});

test('leaving mid-battle counts as a loss when the activity is opened again', async () => {
  const res = await get('/api/me?settle=1&room=g:42', 'token-gary');
  const { stats } = await res.json();
  assert.equal(stats.losses, 1);
  assert.equal(stats.lastResult, 'lost');
  assert.equal(stats.pending, null);
  // ...and the battle can't be finished afterwards.
  const late = await (await battle('token-gary', { event: 'result', date: TODAY, won: true })).json();
  assert.equal(late.stats.wins, 0);
});

test('streaks carry over to the next day, and dates must be plausible', async () => {
  clock = new Date('2026-11-07T12:00:00Z');
  await battle('token-ash', { event: 'start', date: '2026-11-07' });
  const { stats } = await (await battle('token-ash', { event: 'result', date: '2026-11-07', won: true })).json();
  assert.equal(stats.winStreak, 2);
  assert.equal(stats.dayStreak, 2);

  assert.equal((await battle('token-ash', { event: 'start', date: '2026-11-20' })).status, 400);
  assert.equal((await battle('token-ash', { event: 'start', date: 'tomorrow' })).status, 400);
  // Going back to a day before the last recorded one isn't allowed.
  assert.equal((await battle('token-ash', { event: 'result', date: '2026-11-06', won: true })).status, 409);
  assert.equal((await battle('token-ash', { event: 'dance', date: '2026-11-07' })).status, 400);
  assert.equal((await battle('token-ash', { event: 'result', date: '2026-11-07' })).status, 400);
});

test('a battle left unfinished on an earlier day is settled before a new one', async () => {
  clock = new Date('2026-11-08T12:00:00Z');
  await battle('token-ash', { event: 'start', date: '2026-11-08' });
  clock = new Date('2026-11-09T12:00:00Z');
  const { stats } = await (await battle('token-ash', { event: 'start', date: '2026-11-09' })).json();
  assert.equal(stats.losses, 1);
  assert.equal(stats.lastPlayed, '2026-11-08');
  assert.equal(stats.pending, '2026-11-09');
});
