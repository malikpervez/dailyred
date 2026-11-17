// End-to-end test of a Cup battle in headless Chrome: two players, each
// signed in with Discord in their own browser, battle through the server
// (activity/cup.mjs). One closes the page and comes back; the server restarts
// mid-battle; they play on to the end.
//
//   cd tests && npm install && node cup.mjs      (CHROME_PATH=... if needed)
//
// Needs the built site, like site.mjs. Screenshots go to tests/output/.
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { createApp } from '../activity/app.mjs';
import { createCup } from '../activity/cup.mjs';
import { openStore } from '../activity/store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tests/output');
mkdirSync(OUT, { recursive: true });
const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/pw-browsers/chromium'].filter(Boolean).find((p) => existsSync(p));
const step = (name) => console.log(`- ${name}`);

// Discord, as far as signing in goes: a code per player.
const PLAYERS = { ash: { id: '101', username: 'ash', global_name: 'Ash' }, misty: { id: '202', username: 'misty', global_name: 'Misty' } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fakeDiscord = async (url, init = {}) => {
  if (url.endsWith('/oauth2/token')) return json({ access_token: `token-${new URLSearchParams(init.body).get('code')}`, expires_in: 604800 });
  const who = PLAYERS[String(init.headers?.Authorization).replace('Bearer token-', '')];
  if (url.endsWith('/users/@me/guilds')) return json([]);
  if (url.endsWith('/users/@me')) return who ? json(who) : json({}, 401);
  return json({}, 404);
};

const store = openStore(':memory:');
let port = 0;
let http = null;
let cup = null;
async function startServer() {
  cup = createCup({ store, loadEngine: () => import('../activity/cup-engine.mjs'), log: { warn() {} } });
  const site = `http://127.0.0.1:${port || 0}`;
  http = createServer(createApp({ webRoot: join(ROOT, 'web'), store, clientId: '1234', clientSecret: 'secret', fetch: fakeDiscord, publicUrl: site, cup }));
  await new Promise((ok) => http.listen(port, '127.0.0.1', ok));
  port = http.address().port;
}
async function stopServer() {
  http.closeAllConnections();
  await new Promise((ok) => http.close(ok));
}

await startServer();
const site = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

// A player's browser, signed in (our /auth/login runs for real; where it
// would go to Discord, the player "authorizes" and comes straight back).
async function signedIn(name) {
  const context = await browser.newContext({ viewport: { width: 400, height: 900 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (err) => page.errors.push(err.message));
  await page.route(`${site}/auth/login**`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const state = new URL(response.headers().location).searchParams.get('state');
    await route.fulfill({ status: 302, headers: { 'Set-Cookie': response.headers()['set-cookie'], Location: `${site}/auth/callback?code=${name}&state=${state}` } });
  });
  return page;
}

// Plays one step for `page` if it's that player's turn: the first move it
// can use, or the first Pokémon it can send out. True if it did something.
async function playStep(page) {
  const quick = { timeout: 1000 };
  if (await page.isVisible('.commands')) return page.click('.move:not(:disabled)', quick).then(() => true, () => false);
  if (await page.isVisible('.summary')) return page.click('.sum-shift:not(:disabled)', quick).then(() => true, () => false);
  if (await page.isVisible('.party')) return page.click('.party-mon:not(:disabled)', quick).then(() => true, () => false);
  return false;
}

const waitForTurn = (page, n) => page.waitForFunction((t) => (document.getElementById('turn-label').textContent.match(/\d+/)?.[0] ?? 0) >= t, n, { timeout: 30000 });
const myTurn = (page) => page.waitForFunction(() => document.getElementById('cup-status').textContent === 'Your turn', null, { timeout: 30000 });

try {
  const { Dex } = createRequire(join(ROOT, 'activity/package.json'))('@pkmn/sim');
  const { generateTeam } = await import('../web/battle/team.js');
  const dex = Dex.forGen(3);
  const id = await cup.create({
    seed: 'sodium,00000000000000000000000000000001',
    p1: { id: '101', name: 'Ash', team: generateTeam(dex, 11, 2) },
    p2: { id: '202', name: 'Misty', team: generateTeam(dex, 22, 2) },
  });
  const url = `${site}/cup.html?b=${id}`;

  step('signed out: the battle page asks you to sign in, and comes back to the battle after');
  const ash = await signedIn('ash');
  await ash.goto(url);
  await ash.waitForSelector('.app[data-state="error"]');
  assert.equal(await ash.textContent('#error-heading'), 'Sign in to battle');
  await ash.click('#error-signin');
  await ash.waitForURL(url);
  await ash.waitForSelector('.app[data-state="battle"]', { timeout: 30000 });
  await ash.evaluate(() => window.dailyRedCup.setSpeed('fast'));

  step('each player sees the other by name, and only their own side in full');
  const misty = await signedIn('misty');
  await misty.goto(`${site}/auth/login?next=${encodeURIComponent(`/cup.html?b=${id}`)}`);
  await misty.waitForURL(url);
  await misty.waitForSelector('.app[data-state="battle"]', { timeout: 30000 });
  await misty.evaluate(() => window.dailyRedCup.setSpeed('fast'));
  await Promise.all([myTurn(ash), myTurn(misty)]);
  assert.equal(await ash.textContent('.log-list li:first-child'), 'Misty wants to battle!');
  assert.equal(await misty.textContent('.log-list li:first-child'), 'Ash wants to battle!');
  assert.match(await misty.evaluate(() => getComputedStyle(document.querySelector('.infobox-foe .ib-name'), '::before').content), /Ash's/);
  assert.ok(await ash.isVisible('.infobox-you .hp-numbers'), 'your own exact HP');
  await misty.click('.infobox-foe');
  assert.equal(await misty.textContent('.sum-owner'), "Ash's ");
  assert.match(await misty.textContent('.sum-stats'), /ATK\?/, "the other player's stats aren't shown");
  await misty.click('.sum-buttons .action:has-text("BACK")');
  await ash.screenshot({ path: join(OUT, 'cup-ash.png') });
  await misty.screenshot({ path: join(OUT, 'cup-misty.png') });

  step("a move waits for the other player; then the turn plays out on both screens");
  await ash.click('.move:not(:disabled)');
  await ash.waitForFunction(() => document.getElementById('cup-status').textContent === 'Waiting for Misty');
  assert.equal(await ash.textContent('.message-text'), 'Waiting for Misty…');
  await misty.click('.move:not(:disabled)');
  await Promise.all([waitForTurn(ash, 2), waitForTurn(misty, 2)]);

  step('Misty closes the page; when she comes back, the battle is where she left it');
  await misty.close();
  const back = await signedIn('misty');
  await back.goto(`${site}/auth/login?next=${encodeURIComponent(`/cup.html?b=${id}`)}`);
  await back.waitForURL(url);
  await back.waitForSelector('.app[data-state="battle"]', { timeout: 30000 });
  await back.evaluate(() => window.dailyRedCup.setSpeed('fast'));
  await waitForTurn(back, 2);
  assert.match(await back.textContent('.log-list'), /Turn 2/, 'the log so far, without playing it all again');

  step('the server restarts mid-battle; both pages reconnect and play on');
  await stopServer();
  await startServer();
  let moves = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // long battles take a few minutes, even at fast text
  for (let i = 0; Date.now() < deadline && !(await ash.isVisible('#battle-done')); i++) {
    const did = (await playStep(ash)) | (await playStep(back));
    moves += did;
    if (!did) await ash.waitForTimeout(50);
    if (i === 3) await back.screenshot({ path: join(OUT, 'cup-reconnected.png') });
  }
  assert.ok(moves > 0);
  if (!(await ash.isVisible('#battle-done'))) { // to see why
    const info = await cup.meta(id, { id: '101' });
    console.log('STALLED', JSON.stringify({ waitingOn: info.waitingOn, ended: info.ended }), 'ash:', await ash.textContent('#cup-status'), await ash.textContent('#turn-label'),
      '| misty:', await back.textContent('#cup-status'), await back.textContent('#turn-label'));
    await ash.screenshot({ path: join(OUT, 'cup-stalled-ash.png') });
    await back.screenshot({ path: join(OUT, 'cup-stalled-misty.png') });
  }
  await Promise.all([ash.waitForSelector('#battle-done', { state: 'visible', timeout: 60000 }), back.waitForSelector('#battle-done', { state: 'visible', timeout: 60000 })]);
  const [a, m] = [await ash.textContent('#done-title'), await back.textContent('#done-title')];
  assert.ok((a === 'You beat Misty!' && m === 'Ash won this time.') || (a === 'Misty won this time.' && m === 'You beat Ash!'), `${a} / ${m}`);
  const saved = store.getCupBattle(id);
  assert.equal(saved.ended, true);
  assert.equal(saved.winner, a === 'You beat Misty!' ? 'p1' : 'p2', 'the server agrees');
  await ash.screenshot({ path: join(OUT, 'cup-done.png'), fullPage: true });
  assert.deepEqual([...ash.errors, ...back.errors], [], 'no page errors');
  console.log(`All Cup tests passed (${a}).`);
} finally {
  await browser.close();
  await stopServer();
}
