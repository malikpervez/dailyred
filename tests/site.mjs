// End-to-end test of the website in headless Chrome: today's page, the lead
// picker, an official battle played to the end (with move animations),
// practice runs, giving up, a
// battle left halfway (counts as a loss) and the next day's team.
//
//   cd tests && npm install && npm test        (CHROME_PATH=... if needed)
//   SITE_URL=http://<nas-ip>:8380 npm test     (test a running server instead)
//
// Needs the built site: scripts/fetch-vendor.sh, scripts/get-sprites.sh and
// `npm run build` in activity/. Screenshots go to tests/output/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { createApp } from '../activity/app.mjs';
import { openStore } from '../activity/store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tests/output');
mkdirSync(OUT, { recursive: true });

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/opt/pw-browsers/chromium',
].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.');
for (const file of ['web/vendor/battle-worker.js', 'web/sprites/front/25.png']) {
  if (!process.env.SITE_URL && !existsSync(join(ROOT, file))) throw new Error(`Missing ${file}: build the site first (see the top of this file).`);
}

function startServer() {
  if (process.env.SITE_URL) return Promise.resolve({ url: process.env.SITE_URL.replace(/\/$/, ''), close() {} });
  const server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => server.kill());
  return new Promise((ok, fail) => {
    server.stdout.once('data', (line) => ok({ url: String(line).match(/http:\/\/\S+/)[0], close: () => server.kill() }));
    server.once('exit', (code) => fail(new Error(`server exited with ${code}`)));
  });
}

const step = (name) => console.log(`- ${name}`);
const DAY1 = new Date('2026-11-12T10:00:00');
const DAY2 = new Date('2026-11-13T10:00:00');

let shiftSeen = false;

// Clicks through a battle until it ends: the first usable move each turn, the
// first healthy Pokémon when one faints. Returns the result text.
async function playToTheEnd(page) {
  for (let i = 0; i < 2000; i++) {
    if (await page.isVisible('#battle-done')) break;
    // The screen can move on between the check and the click (the next
    // message starts), so clicks give up quickly and the loop looks again.
    const quick = { timeout: 1500 };
    if (await page.isVisible('.confirm')) {
      // RED lost a Pokémon: "Will you change POKéMON?" (saved once, then NO).
      if (!shiftSeen) {
        shiftSeen = true;
        assert.match(await page.textContent('.confirm-text'), /^RED is about to send out [A-Z]+\. Will [A-Z]+ change POKéMON\?$/);
        await page.screenshot({ path: join(OUT, 'shift.png') });
      }
      await page.click('.confirm-no', quick).catch(() => {});
    } else if (await page.isVisible('.summary')) await page.click('.sum-shift:not(:disabled)', quick).catch(() => {});
    else if (await page.isVisible('.party')) await page.click('.party-mon:not(:disabled)', quick).catch(() => {});
    else if (await page.isVisible('.commands')) await page.click('.move:not(:disabled)', quick).catch(() => {});
    else await page.waitForTimeout(25);
  }
  await page.waitForSelector('#battle-done', { state: 'visible', timeout: 5000 });
  return page.textContent('#done-title');
}

const server = await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.clock.install({ time: DAY1 });
  await page.goto(server.url);
  await page.waitForSelector('.app[data-state="home"]', { timeout: 30000 });
  await page.evaluate(() => window.dailyRed.setSpeed('fast'));

  step("today's page shows six Pokémon, RED's team and his lead");
  assert.equal(await page.locator('#team-list .mon-card').count(), 6);
  assert.equal(await page.locator('#red-list .red-mon').count(), 6);
  assert.equal(await page.textContent('#red-lead-name'), 'Pikachu');
  // What each held item does, written out on every card.
  const items = await page.$$eval('#team-list .mon-item-desc', (els) => els.map((e) => e.textContent));
  assert.equal(items.length, 6);
  assert.ok(items.every((text) => /^[A-Z][^:]+: \S/.test(text)), items.join(' | '));
  assert.match(await page.textContent('#red-details .mon-card:first-child .mon-item-desc'), /^Light Ball: Doubles Pikachu's Sp\. Atk\.$/);
  const team = await page.evaluate(() => window.dailyRed.teams.team.map((m) => m.species));
  assert.equal(await page.textContent('#your-lead-name'), team[0]);
  assert.match(await page.textContent('#day-label'), /^No\. 12, Thu, Nov 12$/);
  await page.screenshot({ path: join(OUT, 'home.png'), fullPage: true });

  step('Set as lead changes the lead, and it survives a reload');
  await page.locator('#team-list .set-lead').nth(2).click(); // the 4th Pokémon (the lead has no button)
  assert.equal(await page.textContent('#your-lead-name'), team[3]);
  await page.reload();
  await page.waitForSelector('.app[data-state="home"]');
  assert.equal(await page.textContent('#your-lead-name'), team[3]);
  await page.evaluate(() => window.dailyRed.setSpeed('fast'));

  step("practice runs with today's team are locked until today's battle is done");
  assert.ok(await page.isHidden('#practice'));
  assert.equal(await page.textContent('#practice-locked'), "Practice runs with this team unlock after today's battle.");
  await page.evaluate(() => document.getElementById('practice').click()); // even if the button is forced
  assert.equal(await page.getAttribute('.app', 'data-state'), 'home');

  step('the official battle starts with the lead');
  await page.click('#play');
  await page.waitForSelector('.commands', { state: 'visible', timeout: 30000 });
  assert.equal((await page.evaluate(() => window.dailyRed.stats)).pending, '2026-11-12');
  assert.equal(await page.textContent('.infobox-you .ib-name'), team[3]);
  assert.ok(await page.isHidden('#practice-chip'));
  await page.screenshot({ path: join(OUT, 'battle.png') });
  assert.equal(await page.getAttribute('[data-anims="on"]', 'aria-pressed'), 'true', 'animations start on');

  step('moves show how they hit RED\'s Pokémon; POKéMON shows a summary with SHIFT');
  const effects = await page.$$eval('.move', (buttons) => buttons.map((b) => b.dataset.effect));
  assert.ok(effects.every((e) => ['', 'normal', 'super', 'weak', 'none'].includes(e)), String(effects));
  assert.ok(effects.some((e) => e !== ''), 'at least one attack is rated');
  await page.click('.action:has-text("POKéMON")');
  await page.locator('.party-mon').nth(1).click();
  assert.ok(await page.isVisible('.summary'));
  assert.equal(await page.textContent('.sum-name'), `${team[0]}${await page.textContent('.sum-gender')}Lv100`);
  assert.equal(await page.locator('.sum-move').count(), (await page.evaluate(() => window.dailyRed.teams.team[0].moves.length)));
  assert.ok((await page.textContent('.sum-facts')).includes('ITEM'));
  assert.ok(await page.isHidden('.sum-item-desc'), "the item's description is on the team page, not in battle");
  assert.equal(await page.textContent('.sum-shift'), 'SHIFT');
  await page.click('.sum-buttons .action:has-text("BACK")');
  assert.ok(await page.isVisible('.party'));
  await page.locator('.party-mon').nth(1).click();
  await page.click('.sum-shift');
  await page.waitForSelector('.commands', { state: 'visible', timeout: 30000 });
  assert.equal(await page.textContent('.infobox-you .ib-name'), team[0], 'SHIFT sent the Pokémon out');
  await page.click('.infobox-foe');
  assert.equal(await page.textContent('.sum-owner'), "RED's ");
  assert.ok(await page.isHidden('.sum-shift'));
  await page.click('.sum-buttons .action:has-text("BACK")');
  assert.ok(await page.isVisible('.commands'));
  await page.click('[data-anims="off"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('dailyred-anims')), 'off');
  await page.click('[data-anims="on"]');

  step('the official battle plays to the end and is recorded');
  const title = await playToTheEnd(page);
  const won = title === 'You beat RED!';
  assert.match(await page.textContent('#share-text'), /^Daily Red No\. 12\n(Beat RED with \d left|Lost to RED \(he had \d left\))\n[🟥⬛]{6}$/u);

  step('the result picture is drawn, with a Share image button');
  await page.waitForSelector('#share-image', { state: 'visible', timeout: 10000 });
  assert.ok(await page.isVisible('#share-result'));
  const picture = await page.evaluate(async () => {
    const img = document.getElementById('share-image');
    await img.decode();
    const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return { width: img.naturalWidth, height: img.naturalHeight, png: btoa(binary) };
  });
  assert.deepEqual([picture.width, picture.height], [1200, 720]);
  writeFileSync(join(OUT, 'share.png'), Buffer.from(picture.png, 'base64'));
  await page.screenshot({ path: join(OUT, 'result.png'), fullPage: true });
  await page.click('#back-home');
  let stats = await page.evaluate(() => window.dailyRed.stats);
  assert.deepEqual([stats.wins, stats.losses, stats.lastPlayed, stats.pending], [won ? 1 : 0, won ? 0 : 1, '2026-11-12', null]);

  step('after the battle, today is locked until midnight and practice unlocks');
  assert.ok(await page.isHidden('#play'));
  assert.equal(await page.textContent('#played-result'), won ? 'You beat RED today!' : 'RED won today.');
  assert.match(await page.textContent('#played-next'), /^Next battle in \d\d:\d\d:\d\d$/);
  assert.ok(await page.isVisible('#practice'));
  assert.ok(await page.isHidden('#practice-locked'));

  step('a practice run starts with the lead, and RUN ends it unrecorded');
  await page.click('#practice');
  await page.waitForSelector('.commands', { state: 'visible', timeout: 30000 });
  assert.equal(await page.textContent('.infobox-you .ib-name'), team[3]);
  assert.ok(await page.isVisible('#practice-chip'));
  await page.click('.action:has-text("RUN")');
  assert.equal(await page.textContent('#run-dialog-text'), 'Give up this practice run?');
  await page.click('#run-dialog button[value="run"]');
  assert.equal(await playToTheEnd(page), 'RED won this time.');
  assert.match(await page.textContent('#share-text'), /^Daily Red \(practice\)\nRan from RED on turn \d+\n/);
  await page.click('#back-home');
  const after = await page.evaluate(() => window.dailyRed.stats);
  assert.deepEqual([after.wins, after.losses], [stats.wins, stats.losses], 'practice runs are not recorded');

  step('the next day brings a new team; leaving the battle halfway counts as a loss');
  await page.clock.setSystemTime(DAY2);
  await page.reload();
  await page.waitForSelector('.app[data-state="home"]');
  const nextTeam = await page.evaluate(() => window.dailyRed.teams.team.map((m) => m.species));
  assert.notDeepEqual(nextTeam, team);
  assert.ok(await page.isVisible('#play'));
  await page.click('#play');
  await page.waitForSelector('.commands', { state: 'visible', timeout: 30000 });
  page.on('dialog', (dialog) => dialog.accept()); // "Leave site?"
  await page.reload();
  await page.waitForSelector('.app[data-state="home"]');
  stats = await page.evaluate(() => window.dailyRed.stats);
  assert.deepEqual([stats.losses, stats.lastPlayed, stats.lastResult], [won ? 1 : 2, '2026-11-13', 'lost']);
  assert.equal(await page.textContent('#stat-day-streak'), '2');

  step("the server board shows run-aways, last month's Master's 👑 and the Hall of Fame");
  const board = await page.evaluate(async () => {
    const { renderBoard, renderHallOfFame } = await import('./discord.js');
    const list = document.createElement('ol');
    const base = { avatarUrl: '', wins: 3, losses: 1, winStreak: 0, dayStreak: 2, bestWinStreak: 2, played: 4, winRate: 75 };
    renderBoard(list, [
      { ...base, id: '1', name: 'Ash', today: 'won', master: true, result: { won: true, monsLeft: 3, redLeft: 0, turns: 18 } },
      { ...base, id: '2', name: 'Misty', today: 'lost', result: { won: false, monsLeft: 6, redLeft: 6, turns: 2, gaveUp: true } },
    ], 'today');
    const hall = document.createElement('ol');
    renderHallOfFame(hall, [{ month: '2026-10', masters: [{ id: '1', name: 'Ash', wins: 21, losses: 4 }] }]);
    const cells = (row) => [...row.children].map((c) => c.textContent).filter(Boolean).join(' | ');
    return { rows: [...list.children].map(cells), hall: [...hall.children].map(cells) };
  });
  assert.deepEqual(board.rows, [
    'Ash 👑 | Beat RED | 3 left · 18 turns · 🔥 0 | 🟥🟥🟥⬛⬛⬛',
    'Misty | Ran from RED | Ran on turn 2 · 🔥 0 | 🟥🟥🟥🟥🟥🟥',
  ]);
  assert.deepEqual(board.hall, ['Oct 2026 | 👑 Ash | 21 wins']);

  step('the result screen says where you stand in the month\'s race');
  const standings = await page.evaluate(async () => {
    const { standingText } = await import('./discord.js');
    const p = (name, monthWins, monthLosses, you = false) => ({ name, monthWins, monthLosses, monthLeft: 0, monthTurns: 0, you });
    return [
      standingText([p('Ash', 5, 1), p('You', 4, 0, true), p('Brock', 3, 2)], 'November'),
      standingText([p('Ash', 5, 1), p('Brock', 3, 2), p('You', 1, 3, true)], 'November'),
      standingText([p('You', 5, 0, true), p('Ash', 4, 1)], 'November'),
      standingText([p('You', 5, 0, true), p('Ash', 5, 1)], 'November'),
      standingText([p('Ash', 5, 0), p('You', 5, 1, true)], 'November'),
      standingText([p('You', 1, 0, true), p('Ash', 0, 0)], 'November'),
      standingText([p('You', 0, 1, true), p('Ash', 0, 2)], 'November'),
      standingText([p('You', 1, 0, true)], 'November'),
    ];
  });
  assert.deepEqual(standings, [
    "You're 2nd in the November race, 1 win behind Ash.",
    "You're 3rd in the November race, 4 wins behind Ash.",
    'You lead the November race with 5 wins, 1 win ahead of Ash.',
    'You lead the November race on tiebreaks, level with Ash on 5 wins.',
    "You're 2nd in the November race, level with Ash on 5 wins but behind on tiebreaks.",
    "You're the only one in the November race so far, with 1 win.",
    'Nobody has beaten RED yet in November. The first win takes the lead!',
    "You're the only one in the November race so far, with 1 win.",
  ]);

  step('?seed= shows that seed\'s team as a practice team, but not a daily team');
  await page.goto(`${server.url}/?seed=12345`);
  await page.waitForSelector('.app[data-state="home"]');
  assert.equal(await page.textContent('#day-label'), 'Practice team #12345');
  assert.ok(await page.isVisible('#practice-note'));
  const tomorrowSeed = await page.evaluate(async () => {
    const { dailySeed, addDays, today } = await import('./daily.js');
    return dailySeed(addDays(today(), 1));
  });
  await page.goto(`${server.url}/?seed=${tomorrowSeed}`);
  await page.waitForSelector('.app[data-state="home"]');
  assert.match(await page.textContent('#day-label'), /^No\. 13, /, "tomorrow's team isn't open for practice");

  step('the website signs in with Discord, and the battle counts for the server');
  await signInTest(browser);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All site tests passed.');
} finally {
  await browser.close();
  server.close();
}

// The activity server (app.mjs) with a stand-in for Discord's API, and the
// browser sent through "Sign in with Discord".
async function signInTest(browser) {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fakeDiscord = async (url) => {
    if (url.endsWith('/oauth2/token')) return json(200, { access_token: 'token-ash', expires_in: 604800 });
    if (url.endsWith('/users/@me')) return json(200, { id: '80351110224678912', username: 'ash', global_name: 'Ash', avatar: null });
    if (url.endsWith('/users/@me/guilds')) return json(200, guilds);
    return json(404, {});
  };
  const guilds = [{ id: '42', name: 'Pallet Town' }]; // the player's servers
  const store = openStore(':memory:');
  store.savePlayer({ id: '1', name: 'Misty', avatarUrl: '', stats: {} });
  store.joinRoom('g:42', '1');
  const http = createServer((req, res) => handle(req, res));
  await new Promise((ok) => http.listen(0, '127.0.0.1', ok));
  const site = `http://127.0.0.1:${http.address().port}`;
  const handle = createApp({
    webRoot: join(ROOT, 'web'), store, clientId: '1234', clientSecret: 'secret', fetch: fakeDiscord,
    now: () => new Date('2026-11-12T15:00:00Z'), publicUrl: site,
  });
  const context = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  // Our /auth/login runs for real; where it would send the browser on to
  // Discord, the player "authorizes" and comes straight back with a code.
  // (Playwright can't intercept the redirect itself.)
  await page.route(`${site}/auth/login**`, async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const authorize = new URL(response.headers().location);
    assert.equal(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${site}/auth/callback`);
    await route.fulfill({
      status: 302,
      headers: {
        'Set-Cookie': response.headers()['set-cookie'],
        Location: `${site}/auth/callback?code=abc&state=${authorize.searchParams.get('state')}`,
      },
    });
  });
  await page.route('https://cdn.discordapp.com/**', (route) => route.fulfill({ status: 404 }));
  try {
    await page.clock.install({ time: DAY1 });
    await page.goto(`${site}/?g=42`);
    await page.waitForSelector('.app[data-state="home"]', { timeout: 30000 });
    assert.ok(await page.isHidden('#play'), 'signed out: no battle that counts');
    assert.ok(await page.isVisible('#signin'));
    assert.equal(await page.getAttribute('#signin-link', 'href'), 'auth/login?g=42');
    await page.screenshot({ path: join(OUT, 'signed-out.png') });

    await page.click('#signin-link');
    await page.waitForURL(`${site}/?g=42`);
    await page.waitForSelector('.app[data-state="home"]', { timeout: 30000 });
    assert.equal(await page.textContent('#account-name'), 'Ash');
    assert.equal(await page.textContent('#board-heading'), 'Today in Pallet Town');
    assert.ok(await page.isVisible('#play'));
    assert.ok(await page.isHidden('#signin'));
    await page.evaluate(() => window.dailyRed.setSpeed('fast'));
    await page.screenshot({ path: join(OUT, 'signed-in.png') });

    await page.click('#play');
    await page.waitForSelector('.commands', { state: 'visible', timeout: 30000 });
    await page.click('.action:has-text("RUN")');
    await page.click('#run-dialog button[value="run"]');
    await playToTheEnd(page);
    await page.waitForSelector('#done-standing', { state: 'attached' });
    await page.click('#back-home');
    await page.waitForFunction(() => document.querySelector('#board-list .board-row.is-you'));
    assert.match(await page.textContent('#board-list .is-you'), /^Ash \(you\)Ran from RED/);
    const saved = store.roomResults('g:42', '2026-11-12').get('80351110224678912');
    assert.deepEqual([saved.won, saved.gaveUp], [false, true], 'saved on the server for the server');

    // The bot is added to another server after this sign-in. Its ▶️ link
    // signs in again by itself to pick the new server up, and today's battle
    // shows on that server's board straight away.
    guilds.push({ id: '77', name: 'Cerulean City' });
    store.joinRoom('g:77', '1');
    await page.goto(`${site}/?g=77`);
    await page.waitForURL(`${site}/?g=77`);
    await page.waitForFunction(() => document.querySelector('#board-heading')?.textContent === 'Today in Cerulean City', null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#board-list .board-row.is-you'));
    assert.match(await page.textContent('#board-list .is-you'), /^Ash \(you\)Ran from RED/);
    assert.deepEqual(errors, [], 'no page errors');

    await page.goto(`${site}/auth/logout`);
    await page.waitForSelector('.app[data-state="home"]', { timeout: 30000 });
    assert.ok(await page.isVisible('#signin'), 'signed out again');
  } finally {
    await context.close();
    http.close();
  }
}
