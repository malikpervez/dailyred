// Tests for the Discord bot (bot.mjs) with a fake Discord API:
//   cd activity && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createBot, compareResults, compareMonths } from '../bot.mjs';
import { createApp } from '../app.mjs';
import { openStore } from '../store.mjs';
import { EMPTY } from '../../web/daily.js';

const GUILD = '111';
const quiet = { log() {}, warn() {} };

// A fake discord.com/api: channels, messages (posted / edited / deleted).
function fakeDiscord({ channels = [{ id: 'c-rules', type: 0, name: 'rules' }, { id: 'c-general', type: 0, name: 'general' }], systemChannel = 'c-sys', noAccess = false } = {}) {
  const calls = [];
  const deleted = new Set();
  let nextId = 1;
  const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/api/v10', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body, auth: init.headers?.Authorization });
    if (noAccess) return json(403, { message: 'Missing Access' });
    if (path === `/guilds/${GUILD}/channels`) return json(200, channels);
    if (path === `/guilds/${GUILD}`) return json(200, { id: GUILD, system_channel_id: systemChannel });
    let m = /^\/channels\/([^/]+)\/messages$/.exec(path);
    if (m && init.method === 'POST') return json(200, { id: `m${nextId++}`, channel_id: m[1] });
    m = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(path);
    if (m && init.method === 'PATCH') return deleted.has(m[2]) ? json(404, { message: 'Unknown Message' }) : json(200, { id: m[2] });
    return json(404, { message: 'Not found' });
  };
  return { fetch, calls, deleted, posts: () => calls.filter((c) => c.method === 'POST'), edits: () => calls.filter((c) => c.method === 'PATCH') };
}

function setup({ discord = fakeDiscord(), clock = new Date('2026-11-12T15:00:00Z'), publicKey = null } = {}) {
  const store = openStore(':memory:');
  const bot = createBot({ token: 'bot-token', clientId: '999', publicKey, store, fetch: discord.fetch, now: () => clock, log: quiet });
  const player = (id, name, stats = {}) => {
    store.savePlayer({ id, name, avatarUrl: '', stats: { ...EMPTY, ...stats } });
    store.joinRoom(`g:${GUILD}`, id);
  };
  return { store, bot, discord, player, setClock: (d) => { clock = d; } };
}

const description = (call) => call.body.embeds[0].description;

test('the live card goes to #general and is edited as players start and finish', async () => {
  const { store, bot, discord, player } = setup();
  player('1', 'Ash', { pending: '2026-11-12' });
  await bot.updateCard(GUILD, '2026-11-12');
  assert.equal(discord.posts().length, 1);
  const post = discord.posts()[0];
  assert.equal(post.path, '/channels/c-general/messages');
  assert.equal(post.auth, 'Bot bot-token');
  assert.equal(post.body.embeds[0].title, 'Daily Red No. 12 · Thu, Nov 12');
  assert.match(description(post), /^<@1> ⚔️ Battling RED…$/);
  assert.deepEqual(post.body.allowed_mentions, { parse: [] }, 'mentions never ping');
  assert.equal(post.body.components.length, 0, 'no buttons without the public key');

  // Ash wins with 4 left, Misty loses; the same message is edited.
  player('1', 'Ash', { wins: 5, winStreak: 5, dayStreak: 5, lastPlayed: '2026-11-12', lastResult: 'won' });
  store.saveResult({ playerId: '1', date: '2026-11-12', won: true, monsLeft: 4, redLeft: 0, turns: 18 });
  player('2', 'Misty', { losses: 1, dayStreak: 3, lastPlayed: '2026-11-12', lastResult: 'lost' });
  store.saveResult({ playerId: '2', date: '2026-11-12', won: false, monsLeft: 0, redLeft: 2, turns: 22 });
  player('3', 'Brock', { pending: '2026-11-12' });
  await bot.updateCard(GUILD, '2026-11-12');
  assert.equal(discord.posts().length, 1, 'no second card');
  const edit = discord.edits().at(-1);
  assert.equal(edit.path, `/channels/c-general/messages/${'m1'}`);
  assert.equal(description(edit), [
    '<@1> **Beat RED** with 4 left · 18 turns · 🔥 5-day win streak',
    '🟥🟥🟥🟥⬛⬛',
    '<@2> Lost to RED, he had 2 left · 22 turns · 📅 3 days in a row',
    '⬛⬛⬛⬛⬛⬛',
    '<@3> ⚔️ Battling RED…',
  ].join('\n'));
  assert.match(edit.body.embeds[0].footer.text, /^1 of 2 beat RED · 1 battling · New team at midnight/);
  assert.doesNotMatch(JSON.stringify(edit.body), /Pikachu|lead/i, "the card never shows anyone's team");
});

test('a deleted card is posted again; with no #general it uses the system channel', async () => {
  const discord = fakeDiscord({ channels: [{ id: 'c-chat', type: 0, name: 'chat' }] });
  const { bot, player } = setup({ discord });
  player('1', 'Ash', { pending: '2026-11-12' });
  await bot.updateCard(GUILD, '2026-11-12');
  assert.equal(discord.posts()[0].path, '/channels/c-sys/messages');
  discord.deleted.add('m1');
  await bot.updateCard(GUILD, '2026-11-12');
  assert.equal(discord.posts().length, 2);
});

test("nothing is posted where the bot can't see the server", async () => {
  const discord = fakeDiscord({ noAccess: true });
  const { bot, player } = setup({ discord });
  player('1', 'Ash', { pending: '2026-11-12' });
  await bot.updateCard(GUILD, '2026-11-12');
  assert.equal(discord.posts().length, 0);
});

test('results rank wins by Pokémon left and turns, losses by how few RED had left', () => {
  const sorted = [
    { won: false, redLeft: 4, monsLeft: 0, turns: 10 },
    { won: true, monsLeft: 2, turns: 30 },
    { won: false, redLeft: 1, monsLeft: 0, turns: 25 },
    { won: true, monsLeft: 5, turns: 20 },
    { won: true, monsLeft: 2, turns: 18 },
  ].sort(compareResults);
  assert.deepEqual(sorted.map((r) => `${r.won ? 'W' : 'L'}${r.won ? r.monsLeft : r.redLeft}/${r.turns}`), ['W5/20', 'W2/18', 'W2/30', 'L1/25', 'L4/10']);
});

test('the recap goes out once, at 6:00 in New York, with yesterday ranked', async () => {
  const { store, bot, discord, player, setClock } = setup({ clock: new Date('2026-11-13T10:59:00Z') }); // 5:59 AM EST
  player('1', 'Ash', { wins: 6, winStreak: 6, bestWinStreak: 9, dayStreak: 6, lastPlayed: '2026-11-12', lastResult: 'won' });
  player('2', 'Misty', { wins: 2, losses: 1, winStreak: 2, dayStreak: 2, lastPlayed: '2026-11-12', lastResult: 'won' });
  player('3', 'Brock', { losses: 1, dayStreak: 1, lastPlayed: '2026-11-12', lastResult: 'lost' });
  player('4', 'Erika', { wins: 1, lastPlayed: '2026-11-10', lastResult: 'won' });
  for (const [id, won, monsLeft, redLeft, turns] of [['1', true, 5, 0, 16], ['2', true, 1, 0, 24], ['3', false, 0, 1, 30]]) {
    store.saveResult({ playerId: id, date: '2026-11-12', won, monsLeft, redLeft, turns });
  }
  store.saveResult({ playerId: '1', date: '2026-11-11', won: true, monsLeft: 3, redLeft: 0, turns: 20 });
  store.saveResult({ playerId: '4', date: '2026-11-10', won: true, monsLeft: 1, redLeft: 0, turns: 25 });

  await bot.tick();
  assert.equal(discord.posts().length, 0, 'not before 6:00');

  setClock(new Date('2026-11-13T11:00:00Z')); // 6:00 AM EST
  await bot.tick();
  assert.equal(discord.posts().length, 1);
  const recap = discord.posts()[0];
  assert.equal(recap.path, '/channels/c-general/messages');
  assert.equal(recap.body.embeds[0].title, "Yesterday's results · Daily Red No. 12");
  assert.equal(description(recap), [
    '**2 of 3 beat RED** · this server has played 3 days in a row',
    '',
    '👑 <@1> **Beat RED** with 5 left · 16 turns · 🔥 6-day win streak',
    '🟥🟥🟥🟥🟥⬛',
    '**2.** <@2> **Beat RED** with 1 left · 24 turns · 🔥 2-day win streak',
    '🟥⬛⬛⬛⬛⬛',
    '**3.** <@3> Lost to RED, he had 1 left · 30 turns',
    '⬛⬛⬛⬛⬛⬛',
    '',
    '🔥 Win streaks: <@1> 6 · <@2> 2',
    '🏆 November Master race: <@1> 2 · <@2> 1 · <@4> 1',
    "💤 Didn't play: <@4>",
  ].join('\n'));

  await bot.tick();
  assert.equal(discord.posts().length, 1, 'only once');
});

test('buttons: signed requests only; Battle RED launches the Activity; Leaderboard is private', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const discord = fakeDiscord();
  const { store, bot, player } = setup({ discord, publicKey: rawKey, clock: new Date('2026-11-12T15:00:00Z') });
  player('1', 'Ash', { wins: 6, losses: 2, winStreak: 6, bestWinStreak: 9, lastPlayed: '2026-11-12', lastResult: 'won' });
  player('2', 'Misty', { wins: 1, losses: 3, winStreak: 0, bestWinStreak: 2, lastPlayed: '2026-11-11', lastResult: 'lost' });

  const server = createServer(createApp({ webRoot: '.', store, clientId: '999', clientSecret: 's', bot }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/api/interactions`;
  const send = (body, { badSignature = false } = {}) => {
    const raw = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + (badSignature ? `${raw} ` : raw)), privateKey).toString('hex');
    return fetch(url, { method: 'POST', headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp, 'Content-Type': 'application/json' }, body: raw });
  };
  try {
    assert.equal((await send({ type: 1 }, { badSignature: true })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', body: '{"type":1}' })).status, 401);
    assert.deepEqual(await (await send({ type: 1 })).json(), { type: 1 });
    assert.deepEqual(await (await send({ type: 3, guild_id: GUILD, data: { custom_id: 'dailyred:play' } })).json(), { type: 12 });

    const board = await (await send({ type: 3, guild_id: GUILD, data: { custom_id: 'dailyred:board' } })).json();
    assert.equal(board.type, 4);
    assert.equal(board.data.flags, 64);
    assert.equal(board.data.embeds[0].title, 'Daily Red leaderboard · November 2026');
    assert.equal(board.data.embeds[0].description, [
      '**1.** <@1> 🏆 0 this month · 🔥 6 · best 9 · 6W 2L (75%)',
      '**2.** <@2> 🏆 0 this month · 🔥 0 · best 2 · 1W 3L (25%)',
    ].join('\n'));

    // With the key set, cards get the buttons.
    player('3', 'Brock', { pending: '2026-11-12' });
    await bot.updateCard(GUILD, '2026-11-12');
    const buttons = discord.posts().at(-1).body.components[0].components.map((b) => b.custom_id);
    assert.deepEqual(buttons, ['dailyred:play', 'dailyred:board']);
  } finally {
    server.close();
  }
});

test('on the 1st, after the recap, the Pokémon Master of the Month is announced once', async () => {
  const { store, bot, discord, player, setClock } = setup({ clock: new Date('2026-12-01T10:59:00Z') }); // 5:59 AM EST
  player('1', 'Ash', { wins: 3, losses: 1, lastPlayed: '2026-11-30', lastResult: 'won' });
  player('2', 'Misty', { wins: 3, losses: 2, lastPlayed: '2026-11-30', lastResult: 'won' });
  player('3', 'Brock', { wins: 1, losses: 0, lastPlayed: '2026-11-20', lastResult: 'won' });
  const day = (id, date, won, monsLeft = won ? 2 : 0) => store.saveResult({ playerId: id, date, won, monsLeft, redLeft: won ? 0 : 2, turns: 20 });
  ['2026-11-27', '2026-11-28', '2026-11-30'].forEach((d) => day('1', d, true));
  day('1', '2026-11-29', false);
  ['2026-11-26', '2026-11-29', '2026-11-30'].forEach((d) => day('2', d, true));
  ['2026-11-27', '2026-11-28'].forEach((d) => day('2', d, false));
  day('3', '2026-11-20', true);
  day('1', '2026-10-31', true); // October doesn't count

  await bot.tick();
  assert.equal(discord.posts().length, 0);
  setClock(new Date('2026-12-01T11:00:00Z')); // 6:00 AM EST
  await bot.tick();
  const [recap, month] = discord.posts();
  assert.equal(recap.body.embeds[0].title, "Yesterday's results · Daily Red No. 30");
  assert.equal(month.path, '/channels/c-general/messages');
  assert.equal(month.body.embeds[0].title, '🏆 Pokémon Master of November 2026');
  assert.equal(description(month), [
    '<@1> is the Pokémon Master of November with **3 wins**, 1 loss (75%)!',
    '',
    '🥈 <@2> 3 wins, 2 losses',
    '🥉 <@3> 1 win, 0 losses',
    '',
    "Everyone's streaks start over today. Good luck in December!",
  ].join('\n'));
  assert.equal(month.body.embeds[0].footer.text, '3 trainers battled RED 10 times in November');

  await bot.tick();
  assert.equal(discord.posts().length, 2, 'only once');
});

test('ties for Master: fewer losses, more Pokémon left, fewer turns, then co-Masters', () => {
  const x = (wins, losses, monsLeft, turns) => ({ wins, losses, monsLeft, turns });
  assert.ok(compareMonths(x(5, 1, 10, 90), x(5, 2, 20, 50)) < 0);
  assert.ok(compareMonths(x(5, 1, 20, 90), x(5, 1, 10, 50)) < 0);
  assert.ok(compareMonths(x(5, 1, 10, 50), x(5, 1, 10, 90)) < 0);
  assert.equal(compareMonths(x(5, 1, 10, 50), x(5, 1, 10, 50)), 0);
});

test('a tie all the way down makes co-Masters', async () => {
  const { store, bot, discord, player } = setup({ clock: new Date('2026-12-01T12:00:00Z') });
  player('1', 'Ash');
  player('2', 'Misty');
  for (const id of ['1', '2']) store.saveResult({ playerId: id, date: '2026-11-15', won: true, monsLeft: 3, redLeft: 0, turns: 20 });
  await bot.tick();
  const month = discord.posts().find((p) => p.body.embeds[0].title.startsWith('🏆'));
  assert.match(description(month), /^It's a tie! <@1> and <@2> share Pokémon Master of November with \*\*1 win\*\*, 0 losses \(100%\) each\./);
});

test('the public key may be pasted with spaces, quotes or capitals; a wrong one is reported, not fatal', () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const store = openStore(':memory:');
  const make = (key) => createBot({ token: '', clientId: '999', publicKey: key, store, log: quiet });
  const pasted = make(`  "${hex.toUpperCase()}" `);
  assert.equal(pasted.canVerify, true);
  assert.equal(pasted.status().publicKey, 'ok');
  assert.equal(pasted.status().posting, false, 'no bot token: buttons only');
  const wrong = make('not-a-key');
  assert.equal(wrong.canVerify, false);
  assert.equal(wrong.status().publicKey, 'invalid');
  assert.equal(make(null).status().publicKey, 'missing');
});
