// End-to-end test of a Cup's start in headless Chrome: four players sign up
// on the Cup page from the 25th, the pool comes out on the 1st at 6 PM, and
// the live draft runs at 8 PM (activity/cup-month.mjs), each player in their own browser: picks show
// up on everyone's screen, a player who runs out of time gets their wish
// list's first choice, and one on autodraft picks straight away.
//
//   cd tests && npm install && node cup-draft.mjs      (CHROME_PATH=... if needed)
//
// Needs the built site, like site.mjs. Screenshots go to tests/output/.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { createApp } from '../activity/app.mjs';
import { createCupMonth } from '../activity/cup-month.mjs';
import { openStore } from '../activity/store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tests/output');
mkdirSync(OUT, { recursive: true });
const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/pw-browsers/chromium'].filter(Boolean).find((p) => existsSync(p));
const step = (name) => console.log(`- ${name}`);

const GUILD = '42';
const PLAYERS = {
  ash: { id: '101', username: 'ash', global_name: 'Ash' },
  misty: { id: '202', username: 'misty', global_name: 'Misty' },
  brock: { id: '303', username: 'brock', global_name: 'Brock' },
  gary: { id: '404', username: 'gary', global_name: 'Gary' },
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fakeDiscord = async (url, init = {}) => {
  if (url.endsWith('/oauth2/token')) return json({ access_token: `token-${new URLSearchParams(init.body).get('code')}`, expires_in: 604800 });
  const who = PLAYERS[String(init.headers?.Authorization).replace('Bearer token-', '')];
  if (url.endsWith('/users/@me/guilds')) return json([{ id: GUILD, name: 'Pallet Town' }]);
  if (url.endsWith('/users/@me')) return who ? json(who) : json({}, 401);
  return json({}, 404);
};

const store = openStore(':memory:');
store.savePlayer({ id: 'someone', name: 'Someone', avatarUrl: '', stats: {} });
store.joinRoom(`g:${GUILD}`, 'someone'); // a server with Daily Red
let time = Date.parse('2026-11-25T10:00:00Z'); // Nov 25, 5 AM in New York
const at = (iso) => { time = Date.parse(iso); };
const cupMonth = createCupMonth({ store, loadEngine: () => import('../activity/cup-engine.mjs'), now: () => time, log: { log() {}, warn() {} } });
const http = createServer(createApp({
  webRoot: join(ROOT, 'web'), store, clientId: '1234', clientSecret: 'secret', fetch: fakeDiscord, publicUrl: 'http://127.0.0.1:0', cupMonth,
}));
await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
const site = `http://127.0.0.1:${http.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function signedIn(name, width = 400) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (err) => page.errors.push(err.message));
  await page.route(`${site}/auth/login**`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const state = new URL(response.headers().location).searchParams.get('state');
    await route.fulfill({ status: 302, headers: { 'Set-Cookie': response.headers()['set-cookie'], Location: `${site}/auth/callback?code=${name}&state=${state}` } });
  });
  await page.goto(`${site}/cup.html?g=${GUILD}`);
  await page.waitForSelector('.app[data-state="error"], .app[data-state="hub"]');
  if (await page.isVisible('#error-signin')) {
    await page.click('#error-signin');
    await page.waitForURL(`${site}/cup.html?g=${GUILD}`);
    await page.waitForSelector('.app[data-state="hub"]', { timeout: 5000 }).catch(async (err) => {
      console.log(page.url(), await page.getAttribute('.app', 'data-state'), await page.textContent('#error'), page.errors);
      throw err;
    });
  }
  return page;
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `cup-${name}.png`), fullPage: true });
const cupOf = (page) => page.evaluate(() => window.dailyRedCupHub.cup);

try {
  step('before 6 AM on the 25th: no Cup this month, and a countdown to next month\'s sign-ups');
  const ash = await signedIn('ash');
  assert.equal(await ash.textContent('#cup-title'), 'No Cup in November');
  assert.equal(await ash.textContent('#cup-clock-label'), 'Sign-ups for December open in');
  assert.equal(await ash.textContent('#cup-clock-time'), '1h 00m');
  assert.equal(await ash.isVisible('#cup-join'), false);

  step('sign-ups: players join from the page, and everyone sees the list grow');
  at('2026-11-25T14:00:00Z'); // 9 AM
  await ash.reload();
  await ash.waitForSelector('#cup-join');
  assert.equal(await ash.textContent('#cup-title'), 'Sign-ups are open for December');
  assert.equal(await ash.textContent('#cup-clock-time'), '6d 9h');
  assert.equal(await ash.textContent('.masthead-meta'), 'December 2026');
  await ash.click('#cup-join');
  await ash.waitForSelector('.cup-in');
  const pages = { ash };
  for (const name of ['misty', 'brock', 'gary']) {
    pages[name] = await signedIn(name, name === 'misty' ? 1000 : 400);
    await pages[name].click('#cup-join');
    await pages[name].waitForSelector('.cup-in');
  }
  await ash.waitForFunction(() => document.querySelectorAll('.cup-player').length === 4);
  assert.equal(await ash.textContent('#cup-players-title'), 'Players (4 of 16)');
  await shot(ash, 'signups');

  step('the 1st at 6 PM: sign-ups close, the order is drawn and the pool comes out on everyone\'s page');
  at('2026-12-01T23:00:00Z');
  await cupMonth.tick();
  await ash.waitForFunction(() => document.querySelectorAll('.pool-mon').length === 24);
  assert.equal(await ash.textContent('#cup-title'), 'The pool is out');
  assert.match(await ash.textContent('#cup-clock-label'), /The draft starts in/);
  assert.equal(await ash.textContent('#cup-clock-time'), '2h 00m');
  const order = (await cupOf(ash)).players.map((p) => p.name.toLowerCase());

  step('the wish list: ☆ adds, the arrows reorder, the details show the moves');
  const tiles = await ash.$$eval('.pool-mon', (els) => els.map((e) => Number(e.dataset.index)));
  for (const index of tiles.slice(3, 6)) await ash.click(`.pool-mon[data-index="${index}"] .cup-wish-toggle`);
  await ash.waitForFunction(() => document.querySelectorAll('.cup-wish-row').length === 3);
  await ash.click('.cup-wish-row:nth-child(3) button[title="Higher"]');
  await ash.waitForFunction((want) => JSON.stringify(window.dailyRedCupHub.cup.me.wishlist) === want, JSON.stringify([tiles[3], tiles[5], tiles[4]]));
  await ash.click(`.pool-mon[data-index="${tiles[0]}"] .pool-open`);
  await ash.waitForSelector('#mon-dialog[open] .mon-move');
  await shot(ash, 'pool-details');
  await ash.click('#mon-dialog-close');
  const wish = (await cupOf(ash)).me.wishlist;
  assert.deepEqual(wish, [tiles[3], tiles[5], tiles[4]]);
  assert.deepEqual((await cupOf(pages.misty)).me.wishlist, [], "only Ash sees Ash's list");
  await shot(ash, 'pool');

  step('Gary turns on autodraft');
  await pages.gary.check('#cup-autodraft');
  await ash.waitForFunction(() => window.dailyRedCupHub.cup.players.find((p) => p.name === 'Gary').autodraft);

  step('8 PM: the draft. Picks show up everywhere; autodraft picks straight away');
  at('2026-12-02T01:00:00Z');
  await cupMonth.tick();
  await ash.waitForFunction(() => window.dailyRedCupHub.cup.stage === 'draft');
  let missed = false;
  let screenshots = 0;
  for (let guard = 0; guard < 40; guard++) {
    const state = await cupOf(ash);
    if (state.stage === 'drafted') break;
    const picker = state.players.find((p) => p.id === state.onClock).name.toLowerCase();
    const page = pages[picker];
    const before = state.picks.length;
    if (picker === 'ash' && !missed) {
      // Ash isn't looking: his 90 seconds run out, and his wish list picks.
      missed = true;
      await ash.waitForSelector('#cup-hub[data-my-turn="true"]');
      assert.equal(await ash.textContent('#cup-title'), 'Your pick!');
      time += 91 * 1000;
      await cupMonth.tick();
      await ash.waitForFunction((n) => window.dailyRedCupHub.cup.picks.length > n, before);
      const pick = (await cupOf(ash)).picks[before];
      assert.deepEqual([pick.auto, pick.pool], [true, wish.find((i) => !state.picks.some((p) => p.pool === i))]);
      continue;
    }
    await page.waitForSelector('#cup-hub[data-my-turn="true"] .cup-draft');
    if (screenshots++ === 0) await shot(page, 'your-pick');
    if (picker === 'misty' && screenshots < 4) await shot(page, 'draft-wide');
    time += 5000;
    await page.click('.pool-mon:not(.is-taken) .cup-draft');
    await ash.waitForFunction((n) => window.dailyRedCupHub.cup.picks.length > n, before);
  }
  assert.ok(missed, 'Ash missed a pick');

  step('the teams are set: six each, the whole pool drafted, on every page');
  for (const page of Object.values(pages)) {
    await page.waitForFunction(() => window.dailyRedCupHub.cup.stage === 'drafted');
    assert.equal(await page.textContent('#cup-title'), 'The teams are set');
    assert.equal(await page.$$eval('.cup-player', (rows) => rows.every((r) => r.querySelectorAll('img.cup-slot').length === 6)), true);
  }
  const final = await cupOf(ash);
  assert.equal(new Set(final.picks.map((p) => p.pool)).size, 24);
  const garyPicks = final.picks.filter((p) => final.players.find((x) => x.id === p.player).name === 'Gary');
  assert.ok(garyPicks.every((p) => p.auto), "Gary's were all autodrafted");
  await shot(ash, 'drafted');
  console.log(`  (draft order: ${order.join(', ')})`);

  for (const [name, page] of Object.entries(pages)) assert.deepEqual(page.errors, [], `${name}'s page had errors`);
  console.log('All Cup draft tests passed.');
} finally {
  await browser.close();
  http.closeAllConnections();
  http.close();
}
