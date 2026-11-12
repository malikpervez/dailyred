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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

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

// Clicks through a battle until it ends: the first usable move each turn, the
// first healthy Pokémon when one faints. Returns the result text.
async function playToTheEnd(page) {
  for (let i = 0; i < 2000; i++) {
    if (await page.isVisible('#battle-done')) break;
    // The screen can move on between the check and the click (the next
    // message starts), so clicks give up quickly and the loop looks again.
    const quick = { timeout: 1500 };
    if (await page.isVisible('.summary')) await page.click('.sum-shift:not(:disabled)', quick).catch(() => {});
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

  step('a practice run starts with the lead, and Give up ends it unrecorded');
  await page.click('#practice');
  await page.waitForSelector('.commands', { state: 'visible', timeout: 30000 });
  assert.equal(await page.textContent('.infobox-you .ib-name'), team[3]);
  assert.ok(await page.isVisible('#practice-chip'));
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
  await page.click('.action:has-text("RUN")');
  await page.click('#run-dialog button[value="run"]');
  assert.equal(await playToTheEnd(page), 'RED won this time.');
  assert.match(await page.textContent('#share-text'), /^Daily Red \(practice\)/);
  await page.click('#back-home');
  let stats = await page.evaluate(() => window.dailyRed.stats);
  assert.equal(stats.wins + stats.losses, 0, 'practice runs are not recorded');

  step('the official battle plays to the end and is recorded');
  await page.click('#play');
  await page.waitForSelector('.commands', { state: 'visible', timeout: 30000 });
  assert.equal((await page.evaluate(() => window.dailyRed.stats)).pending, '2026-11-12');
  const title = await playToTheEnd(page);
  const won = title === 'You beat RED!';
  assert.match(await page.textContent('#share-text'), /^Daily Red No\. 12\n(Beat RED with \d left|Lost to RED \(he had \d left\))\n[🟥⬛]{6}$/u);
  await page.screenshot({ path: join(OUT, 'result.png'), fullPage: true });
  await page.click('#back-home');
  stats = await page.evaluate(() => window.dailyRed.stats);
  assert.deepEqual([stats.wins, stats.losses, stats.lastPlayed, stats.pending], [won ? 1 : 0, won ? 0 : 1, '2026-11-12', null]);

  step('after the battle, today is locked until midnight (practice still works)');
  assert.ok(await page.isHidden('#play'));
  assert.equal(await page.textContent('#played-result'), won ? 'You beat RED today!' : 'RED won today.');
  assert.match(await page.textContent('#played-next'), /^Next battle in \d\d:\d\d:\d\d$/);
  assert.ok(await page.isVisible('#practice'));

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

  step('?seed= shows that seed\'s team as a practice team');
  await page.goto(`${server.url}/?seed=12345`);
  await page.waitForSelector('.app[data-state="home"]');
  assert.equal(await page.textContent('#day-label'), 'Practice team #12345');
  assert.ok(await page.isVisible('#practice-note'));

  assert.deepEqual(errors, [], 'no page errors');
  console.log('All site tests passed.');
} finally {
  await browser.close();
  server.close();
}
