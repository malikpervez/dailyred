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

// A fake discord.com/api: channels, messages (posted / edited / deleted) and
// each channel's history (chatter() adds other people's messages).
function fakeDiscord({ channels = [{ id: 'c-rules', type: 0, name: 'rules' }, { id: 'c-general', type: 0, name: 'general' }], systemChannel = 'c-sys', noAccess = false } = {}) {
  const calls = [];
  const deleted = new Set();
  const history = new Map(); // channel id -> message ids, oldest first
  const said = (channel, id) => history.set(channel, [...(history.get(channel) ?? []), id]);
  let nextId = 1;
  const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/api/v10', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body, auth: init.headers?.Authorization });
    if (noAccess) return json(403, { message: 'Missing Access' });
    if (path === `/guilds/${GUILD}/channels`) return json(200, channels);
    if (path === `/guilds/${GUILD}`) return json(200, { id: GUILD, system_channel_id: systemChannel });
    if (path === '/users/@me/guilds') return json(200, [{ id: GUILD, name: 'Test server' }]);
    if (path === '/applications/999/commands' && init.method === 'POST') return json(200, { id: 'cmd1', ...body });
    const original = /^\/webhooks\/999\/([^/]+)\/messages\/@original$/.exec(path);
    if (original) return json(200, { id: `orig-${original[1]}`, channel_id: 'c-general' });
    let m = /^\/channels\/([^/]+)\/messages$/.exec(path);
    if (m && init.method === 'POST') {
      const id = `m${nextId++}`;
      said(m[1], id);
      return json(200, { id, channel_id: m[1] });
    }
    if (m && init.method === 'GET') {
      const limit = Number(new URL(url).searchParams.get('limit') ?? 50);
      return json(200, (history.get(m[1]) ?? []).filter((id) => !deleted.has(id)).slice(-limit).reverse().map((id) => ({ id })));
    }
    m = /^\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(path);
    if (m && init.method === 'PATCH') return deleted.has(m[2]) ? json(404, { message: 'Unknown Message' }) : json(200, { id: m[2] });
    if (m && init.method === 'DELETE') {
      if (deleted.has(m[2])) return json(404, { message: 'Unknown Message' });
      deleted.add(m[2]);
      return json(204);
    }
    return json(404, { message: 'Not found' });
  };
  return {
    fetch, calls, deleted,
    chatter: (channel, n) => { for (let i = 0; i < n; i++) said(channel, `chat${nextId++}`); },
    posts: () => calls.filter((c) => c.method === 'POST'),
    edits: () => calls.filter((c) => c.method === 'PATCH'),
    deletes: () => calls.filter((c) => c.method === 'DELETE'),
  };
}

function setup({ discord = fakeDiscord(), clock = new Date('2026-11-12T15:00:00Z'), publicKey = null } = {}) {
  const store = openStore(':memory:');
  const bot = createBot({ token: 'bot-token', clientId: '999', publicKey, store, fetch: discord.fetch, now: () => clock, log: quiet, followUpDelay: 0 });
  const player = (id, name, stats = {}) => {
    store.savePlayer({ id, name, avatarUrl: '', stats: { ...EMPTY, ...stats } });
    store.joinRoom(`g:${GUILD}`, id);
  };
  return { store, bot, discord, player, setClock: (d) => { clock = d; } };
}

const description = (call) => call.body.embeds[0].description;
const titles = (discord) => discord.posts().map((p) => p.body.embeds?.[0]?.title ?? p.body.content);

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
    '',
    '🏆 November race: <@1> 1',
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
  assert.deepEqual(titles(discord), ['How to play Daily Red'], 'before 6:00, only the one-time how-to');

  setClock(new Date('2026-11-13T11:00:00Z')); // 6:00 AM EST
  await bot.tick();
  assert.deepEqual(titles(discord), ['How to play Daily Red', "Yesterday's results · Daily Red No. 12", 'Daily Red No. 13 · Fri, Nov 13'],
    "then the recap, and today's card below it");
  const recap = discord.posts()[1];
  assert.equal(recap.path, '/channels/c-general/messages');
  assert.equal(recap.body.embeds[0].title, "Yesterday's results · Daily Red No. 12");
  assert.equal(description(recap), [
    '**2 of 3 beat RED** · this server has played 3 days in a row',
    '',
    '🥇 <@1> **Beat RED** with 5 left · 16 turns · 🔥 6-day win streak',
    '🟥🟥🟥🟥🟥⬛',
    '🥈 <@2> **Beat RED** with 1 left · 24 turns · 🔥 2-day win streak',
    '🟥⬛⬛⬛⬛⬛',
    '🥉 <@3> Lost to RED, he had 1 left · 30 turns',
    '⬛⬛⬛⬛⬛⬛',
    '',
    '🔥 Win streaks: <@1> 6 · <@2> 2',
    '🏆 November Master race: <@1> 2 · <@2> 1 · <@4> 1',
    "💤 Didn't play: <@4>",
  ].join('\n'));

  await bot.tick();
  assert.equal(discord.posts().length, 3, 'only once');
});

test('buttons: signed requests only; Battle RED launches the Activity; Leaderboard is for everyone', async () => {
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
    assert.equal(board.data.flags, undefined, 'everyone in the channel sees it');
    assert.equal(board.data.embeds[0].title, 'Daily Red leaderboard · November 2026');
    assert.deepEqual(board.data.embeds[0].fields, [
      { name: '🏆 Master race', value: 'Nobody has battled RED yet in November.' },
      { name: '🔥 Win streaks', value: '<@1> **6** (best 9)' },
      { name: '📈 All time', value: '<@1> **6W** 75% · <@2> **1W** 25%' },
    ]);

    // With the key set, cards get the buttons.
    player('3', 'Brock', { pending: '2026-11-12' });
    await bot.updateCard(GUILD, '2026-11-12');
    const buttons = discord.posts().at(-1).body.components[0].components.map((b) => b.custom_id);
    assert.deepEqual(buttons, ['dailyred:play', 'dailyred:board', 'dailyred:remind']);
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
  assert.deepEqual(titles(discord), ['How to play Daily Red']);
  setClock(new Date('2026-12-01T11:00:00Z')); // 6:00 AM EST
  await bot.tick();
  assert.equal(titles(discord).at(-1), 'Daily Red No. 31 · Tue, Dec 1');
  const [, recap, month] = discord.posts();
  assert.equal(recap.body.embeds[0].title, "Yesterday's results · Daily Red No. 30");
  assert.equal(month.path, '/channels/c-general/messages');
  assert.equal(month.body.embeds[0].title, '🏆 Pokémon Master of November 2026');
  assert.equal(description(month), [
    '<@1> is the Pokémon Master of November with **3 wins**, 1 loss (75%)!',
    '',
    '🥈 <@2> 3 wins, 2 losses',
    '🥉 <@3> 1 win, 0 losses',
    '',
    '<@1> wears the 👑 all December and joins the Hall of Fame.',
    "Everyone's streaks start over today. Good luck in December!",
  ].join('\n'));
  assert.equal(month.body.embeds[0].footer.text, '3 trainers battled RED 10 times in November');

  await bot.tick();
  assert.equal(discord.posts().length, 4, 'only once');
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

test("opening the Activity posts today's card if someone already played, including battles from before the bot", async () => {
  const { bot, discord, player } = setup();
  player('1', 'Ash', { wins: 1, winStreak: 1, dayStreak: 1, lastPlayed: '2026-11-12', lastResult: 'won' }); // no results row
  await bot.ensureCard(GUILD, '2026-11-12');
  assert.equal(discord.posts().length, 1);
  assert.equal(description(discord.posts()[0]), '<@1> **Beat RED**');
  await bot.ensureCard(GUILD, '2026-11-12');
  assert.equal(discord.posts().length + discord.edits().length, 1, 'only when there is no card yet');
  await bot.ensureCard(GUILD, '2026-11-13');
  assert.equal(discord.posts().length, 1, 'nobody has played on the 13th');
  assert.equal(await bot.servers(), 1);
});

test('a run-away shows as "Ran from RED on turn N"', async () => {
  const { store, bot, discord, player } = setup();
  player('1', 'Ash', { losses: 1, dayStreak: 4, lastPlayed: '2026-11-12', lastResult: 'lost' });
  store.saveResult({ playerId: '1', date: '2026-11-12', won: false, monsLeft: 6, redLeft: 6, turns: 3, gaveUp: true });
  await bot.updateCard(GUILD, '2026-11-12');
  assert.equal(description(discord.posts()[0]), '<@1> 🏃 Ran from RED on turn 3\n🟥🟥🟥🟥🟥🟥');
});

test("last month's Master wears a 👑 all month and joins the Hall of Fame", async () => {
  const discord = fakeDiscord();
  const { publicKey } = generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const { store, bot, player, setClock } = setup({ discord, publicKey: rawKey, clock: new Date('2026-11-01T12:00:00Z') });
  player('1', 'Ash', { wins: 2, lastPlayed: '2026-10-31', lastResult: 'won' });
  player('2', 'Misty', { wins: 1, lastPlayed: '2026-10-30', lastResult: 'won' });
  for (const [id, date] of [['1', '2026-10-30'], ['1', '2026-10-31'], ['2', '2026-10-30']]) {
    store.saveResult({ playerId: id, date, won: true, monsLeft: 2, redLeft: 0, turns: 20 });
  }
  await bot.tick(); // Nov 1: October's Master is announced and saved
  assert.deepEqual(store.masters(GUILD).map((m) => [m.month, m.playerId, m.wins]), [['2026-10', '1', 2]]);

  setClock(new Date('2026-11-12T15:00:00Z'));
  store.saveResult({ playerId: '1', date: '2026-11-12', won: true, monsLeft: 3, redLeft: 0, turns: 15 });
  player('1', 'Ash', { wins: 3, winStreak: 1, dayStreak: 1, lastPlayed: '2026-11-12', lastResult: 'won' });
  await bot.updateCard(GUILD, '2026-11-12');
  assert.match(description(discord.posts().at(-1)), /^<@1> 👑 \*\*Beat RED\*\* with 3 left/);

  const board = bot.interaction({ type: 3, guild_id: GUILD, data: { custom_id: 'dailyred:board' } });
  assert.equal(board.data.embeds[0].description, '18 days left · most wins becomes Pokémon Master\n👑 Reigning Master: <@1>');
  assert.deepEqual(board.data.embeds[0].fields, [
    { name: '🏆 Master race', value: '🥇 <@1> 👑 · **1W** 0L · ✅ beat RED today' },
    { name: '🔥 Win streaks', value: '<@1> **1** (best 1)' },
    { name: '📈 All time', value: '<@1> **3W** 100% · <@2> **1W** 100%' },
    { name: '🏛️ Hall of Fame', value: '**Oct 2026** <@1> (2 wins)' },
  ]);

  // The crown is only for the month after: in December it's November's Master.
  setClock(new Date('2026-12-05T15:00:00Z'));
  assert.equal(bot.crownedOn(GUILD, '2026-12-05').size, 0);

  // The page's board shows it too.
  const app = createApp({ webRoot: '.', store, clientId: '999', clientSecret: 's', bot, now: () => new Date('2026-11-12T15:00:00Z'),
    fetch: async () => new Response(JSON.stringify({ id: '2', username: 'misty' }), { status: 200 }) });
  const server = createServer(app);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/board?room=g:${GUILD}&date=2026-11-12`, { headers: { Authorization: 'Bearer t' } });
    const { players, hallOfFame } = await res.json();
    assert.deepEqual(players.map((p) => [p.id, p.master]), [['1', true], ['2', false]]);
    assert.deepEqual(hallOfFame, [{ month: '2026-10', masters: [{ id: '1', name: 'Ash', avatarUrl: '', wins: 2, losses: 0 }] }]);
  } finally {
    server.close();
  }
});

test('Mondays at 6:00 the weekly leaderboard follows the recap, once', async () => {
  const { store, bot, discord, player } = setup({ clock: new Date('2026-11-16T11:00:00Z') }); // Mon 6:00 AM EST
  player('1', 'Ash', { wins: 3, losses: 1, winStreak: 2, lastPlayed: '2026-11-15', lastResult: 'won' });
  player('2', 'Misty', { wins: 1, losses: 2, lastPlayed: '2026-11-11', lastResult: 'lost' });
  for (const [id, date, won] of [['1', '2026-11-15', true], ['1', '2026-11-14', true], ['1', '2026-11-13', false], ['2', '2026-11-11', false], ['2', '2026-11-10', true]]) {
    store.saveResult({ playerId: id, date, won, monsLeft: won ? 2 : 0, redLeft: won ? 0 : 3, turns: 20 });
  }
  await bot.tick();
  const [, recap, weekly, card] = discord.posts();
  assert.equal(card.body.embeds[0].title, 'Daily Red No. 16 · Mon, Nov 16');
  assert.equal(recap.body.embeds[0].title, "Yesterday's results · Daily Red No. 15");
  assert.equal(weekly.body.embeds[0].title, '📊 Weekly leaderboard · November 2026');
  assert.equal(description(weekly), '14 days left · most wins becomes Pokémon Master');
  assert.deepEqual(weekly.body.embeds[0].fields, [
    { name: '🏆 Master race', value: '🥇 <@1> · **2W** 1L\n🥈 <@2> · **1W** 1L' },
    { name: '🔥 Win streaks', value: '<@1> **2** (best 2)' },
    { name: '📈 All time', value: '<@1> **3W** 75% · <@2> **1W** 33%' },
  ]);
  await bot.tick();
  assert.equal(discord.posts().length, 4, 'only once');
});

test('🔔 Reminders: players opt in with the button and get one mention a day if they have not played', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const discord = fakeDiscord();
  const { store, bot, player, setClock } = setup({ discord, publicKey: rawKey, clock: new Date('2026-11-12T21:59:00Z') }); // 4:59 PM EST
  player('1', 'Ash', { lastPlayed: '2026-11-11', lastResult: 'won', wins: 1 });
  player('2', 'Misty', { lastPlayed: '2026-11-12', lastResult: 'won', wins: 1 }); // already played today
  player('3', 'Brock', { pending: '2026-11-12' }); // battling right now
  player('4', 'Erika'); // didn't ask
  const press = (userId) => bot.interaction({ type: 3, guild_id: GUILD, member: { user: { id: userId } }, data: { custom_id: 'dailyred:remind' } });
  for (const id of ['1', '2', '3', '5']) assert.match(press(id).data.content, /^🔔 Reminders on: .* 5:00 PM Eastern/);
  assert.equal(press('1').data.flags, 64);
  assert.match(press('1').data.content, /^🔔 Reminders on/, 'the second press turned it off, the third back on');
  assert.deepEqual(store.reminders(GUILD).sort(), ['1', '2', '3', '5']);

  const reminders = () => discord.posts().filter((p) => p.body.content?.startsWith('⏰'));
  await bot.tick();
  assert.equal(reminders().length, 0, 'not before 17:00');
  setClock(new Date('2026-11-12T22:00:00Z'));
  await bot.tick();
  const [reminder] = reminders();
  // 5 pressed the button without ever playing: reminded too.
  assert.match(reminder.body.content, /^⏰ Today's Daily Red \(No\. 12\) is waiting for <@1> <@5>\. /);
  assert.deepEqual(reminder.body.allowed_mentions, { users: ['1', '5'] }, 'pings only who asked and has not played');
  await bot.tick();
  assert.equal(reminders().length, 1, 'once a day');

  assert.match(press('1').data.content, /^🔕 Reminders off/);
  assert.deepEqual(store.reminders(GUILD).sort(), ['2', '3', '5']);
});

test('when a battle finishes and the card has scrolled up, it moves back to the bottom', async () => {
  const discord = fakeDiscord();
  const { store, bot, player } = setup({ discord });
  player('1', 'Ash', { pending: '2026-11-12' });
  await bot.updateCard(GUILD, '2026-11-12');
  assert.equal(store.getCard(GUILD, '2026-11-12').messageId, 'm1');

  // A few messages later it's still in view: edited in place.
  discord.chatter('c-general', 5);
  await bot.updateCard(GUILD, '2026-11-12', { bump: true });
  assert.deepEqual([discord.posts().length, discord.edits().length, discord.deletes().length], [1, 1, 0]);

  // Starting a battle never moves it, even when it has scrolled up.
  discord.chatter('c-general', 20);
  await bot.updateCard(GUILD, '2026-11-12');
  assert.deepEqual([discord.posts().length, discord.deletes().length], [1, 0]);

  // Finishing does: the old card is deleted and posted again at the bottom.
  store.saveResult({ playerId: '1', date: '2026-11-12', won: true, monsLeft: 2, redLeft: 0, turns: 20 });
  player('1', 'Ash', { wins: 1, winStreak: 1, dayStreak: 1, lastPlayed: '2026-11-12', lastResult: 'won' });
  await bot.updateCard(GUILD, '2026-11-12', { bump: true });
  assert.equal(discord.deletes()[0].path, '/channels/c-general/messages/m1');
  assert.equal(discord.posts().length, 2);
  const moved = store.getCard(GUILD, '2026-11-12').messageId;
  assert.notEqual(moved, 'm1');
  assert.match(description(discord.posts().at(-1)), /^<@1> \*\*Beat RED\*\*/);

  // The server's result endpoint asks for the move.
  discord.chatter('c-general', 20);
  player('2', 'Misty', { pending: '2026-11-12' });
  const app = createApp({ webRoot: '.', store, clientId: '999', clientSecret: 's', bot, now: () => new Date('2026-11-12T15:00:00Z'),
    fetch: async () => new Response(JSON.stringify({ id: '2', username: 'misty' }), { status: 200 }) });
  const server = createServer(app);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/battle`, {
      method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'result', date: '2026-11-12', room: `g:${GUILD}`, won: false, monsLeft: 0, redLeft: 3, turns: 25 }),
    });
    assert.equal(res.status, 200);
    await new Promise((ok) => setTimeout(ok, 50)); // the card updates in the background
    assert.equal(discord.deletes().at(-1).path, `/channels/c-general/messages/${moved}`);
    assert.equal(discord.posts().length, 3);
  } finally {
    server.close();
  }
});

test('the Leaderboard button shows today and where the presser stands, and replaces the last one', async () => {
  const { store, bot, discord, player } = setup({ clock: new Date('2026-11-12T15:00:00Z') });
  player('1', 'Ash', { wins: 2, winStreak: 2, dayStreak: 2, lastPlayed: '2026-11-12', lastResult: 'won' });
  player('2', 'Misty', { losses: 1, dayStreak: 1, lastPlayed: '2026-11-12', lastResult: 'lost' });
  player('3', 'Brock', { wins: 1, winStreak: 1, lastPlayed: '2026-11-11', lastResult: 'won', pending: '2026-11-12' });
  for (const [id, date, won, gaveUp] of [['1', '2026-11-11', true], ['1', '2026-11-12', true], ['3', '2026-11-11', true], ['2', '2026-11-12', false, true]]) {
    store.saveResult({ playerId: id, date, won, monsLeft: won ? 3 : 6, redLeft: won ? 0 : 6, turns: won ? 20 : 2, gaveUp });
  }
  const press = (token, userId) => bot.interaction({ type: 3, guild_id: GUILD, token, member: { user: { id: userId } }, data: { custom_id: 'dailyred:board' } });
  const settle = () => new Promise((ok) => setTimeout(ok, 30));

  const board = press('tok1', '3');
  assert.deepEqual(board.data.embeds[0].fields.find((f) => f.name === '🏆 Master race').value.split('\n'), [
    '🥇 <@1> · **2W** 0L · ✅ beat RED today',
    '🥈 <@3> · **1W** 0L · ⚔️ battling',
    '🥉 <@2> · **0W** 1L · 🏃 ran today',
  ]);
  assert.equal(board.data.embeds[0].fields.find((f) => f.name === '➡️ Standing').value, '<@3> is 2nd, 1 win behind <@1>.');
  assert.deepEqual(board.data.allowed_mentions, { parse: [] }, 'nobody is pinged');
  await settle();
  assert.equal(discord.deletes().length, 0, 'nothing to replace the first time');

  const again = press('tok2', '1');
  assert.equal(again.data.embeds[0].fields.find((f) => f.name === '➡️ Standing').value, '<@1> leads, 1 win ahead of <@3>.');
  await settle();
  assert.deepEqual(discord.deletes().map((d) => d.path), ['/channels/c-general/messages/orig-tok1']);
});

test('with PUBLIC_URL, the play button is a link to the website for that server', async () => {
  const discord = fakeDiscord();
  const store = openStore(':memory:');
  const bot = createBot({ token: 'bot-token', clientId: '999', store, fetch: discord.fetch, now: () => new Date('2026-11-12T15:00:00Z'), log: quiet, publicUrl: 'https://nas.example.ts.net/' });
  store.savePlayer({ id: '1', name: 'Ash', avatarUrl: '', stats: { ...EMPTY, pending: '2026-11-12' } });
  store.joinRoom(`g:${GUILD}`, '1');
  await bot.updateCard(GUILD, '2026-11-12');
  const [row] = discord.posts()[0].body.components;
  assert.deepEqual(row.components, [{ type: 2, style: 5, label: 'Battle RED', emoji: { name: '▶️' }, url: `https://nas.example.ts.net/?g=${GUILD}` }],
    'without the public key, only the link');
  assert.deepEqual(await bot.guildIds(), [GUILD]);
});

test('/dailyred shows your day privately; old Activity buttons point to the website; the command is added once', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const discord = fakeDiscord();
  const store = openStore(':memory:');
  const bot = createBot({
    token: 'bot-token', clientId: '999', publicKey: rawKey, store, fetch: discord.fetch, log: quiet, followUpDelay: 0,
    now: () => new Date('2026-11-12T15:00:00Z'), publicUrl: 'https://nas.example.ts.net',
  });
  store.savePlayer({ id: '1', name: 'Ash', avatarUrl: '', stats: { ...EMPTY, wins: 1, winStreak: 1, lastPlayed: '2026-11-12', lastResult: 'won' } });
  store.joinRoom(`g:${GUILD}`, '1');
  store.saveResult({ playerId: '1', date: '2026-11-12', won: true, monsLeft: 4, redLeft: 0, turns: 18 });

  const command = (userId) => bot.interaction({ type: 2, guild_id: GUILD, member: { user: { id: userId } }, data: { name: 'dailyred' } });
  const mine = command('1');
  assert.equal(mine.type, 4);
  assert.equal(mine.data.flags, 64, 'only you see it');
  assert.equal(mine.data.embeds[0].title, 'Daily Red No. 12 · Thu, Nov 12');
  assert.match(mine.data.embeds[0].description, /^\*\*You beat RED today with 4 left! 🔥\*\*\n1 of 1 in this server beat RED today\.\n\n• One battle a day/);
  assert.deepEqual(mine.data.components[0].components.map((b) => b.url ?? b.custom_id),
    [`https://nas.example.ts.net/?g=${GUILD}`, 'dailyred:board', 'dailyred:remind']);
  assert.match(command('2').data.embeds[0].description, /^\*\*You haven't battled RED today yet\.\*\*/);
  assert.equal(bot.interaction({ type: 2, guild_id: GUILD, data: { name: 'launch' } }).type, 12, "the Activity's own command still launches it");

  const old = bot.interaction({ type: 3, guild_id: GUILD, data: { custom_id: 'dailyred:play' } });
  assert.equal(old.data.flags, 64);
  assert.equal(old.data.components[0].components[0].url, `https://nas.example.ts.net/?g=${GUILD}`);

  store.setSetting('gateway_identified', '1'); // skip the Gateway login
  await bot.start();
  bot.stop();
  await bot.start();
  bot.stop();
  const added = discord.calls.filter((c) => c.path === '/applications/999/commands');
  assert.deepEqual(added.map((c) => [c.method, c.body.name, c.body.contexts, c.body.default_member_permissions]), [
    ['POST', 'dailyred', [0], undefined],
    ['POST', 'dailyred-preview', [0], '32'], // only for people who can manage the server
  ], 'added once');
});

test("today's card lists the day's six (never anyone's lead), and still posts if that fails", async () => {
  const { teamSpecies } = await import('../team-of-day.mjs');
  const { dailySeed } = await import('../../web/daily.js');
  const { generateTeam } = await import('../../web/battle/team.js');
  const { Dex } = await import('@pkmn/sim');
  const six = teamSpecies(dailySeed('2026-11-12'));
  assert.deepEqual(six, generateTeam(Dex.forGen(3), dailySeed('2026-11-12')).map((s) => s.species), "the browser's team");

  const discord = fakeDiscord();
  const store = openStore(':memory:');
  const make = (teamOfDay) => createBot({ token: 'bot-token', clientId: '999', store, fetch: discord.fetch, log: quiet, now: () => new Date('2026-11-12T15:00:00Z'), teamOfDay });
  const bot = make((date) => teamSpecies(dailySeed(date)));
  store.savePlayer({ id: '1', name: 'Ash', avatarUrl: '', stats: { ...EMPTY, pending: '2026-11-12' } });
  store.joinRoom(`g:${GUILD}`, '1');
  await bot.updateCard(GUILD, '2026-11-12');
  assert.equal(description(discord.posts()[0]), `**Today's team:** ${six.join(' · ')}\n\n<@1> ⚔️ Battling RED…`);
  assert.match(bot.commandMessage(GUILD, '1').embeds[0].description, new RegExp(`\\n\\*\\*Today's team:\\*\\* ${six[0]}`));

  const broken = make(() => { throw new Error('no data'); });
  assert.equal(broken.cardMessage(GUILD, '2026-11-13').embeds[0].description, 'Nobody has battled RED yet today.');
});

test('the posted Leaderboard updates itself when a battle finishes', async () => {
  const { store, bot, discord, player } = setup({ clock: new Date('2026-11-12T15:00:00Z') });
  player('1', 'Ash', { wins: 1, winStreak: 1, lastPlayed: '2026-11-11', lastResult: 'won' });
  store.saveResult({ playerId: '1', date: '2026-11-11', won: true, monsLeft: 3, redLeft: 0, turns: 20 });
  bot.interaction({ type: 3, guild_id: GUILD, token: 'tok1', member: { user: { id: '1' } }, data: { custom_id: 'dailyred:board' } });
  await new Promise((ok) => setTimeout(ok, 30));
  assert.deepEqual(JSON.parse(store.getSetting(`board:${GUILD}`)), { channelId: 'c-general', messageId: 'orig-tok1', viewer: '1' });

  // Misty plays and wins: the same leaderboard message is edited.
  player('2', 'Misty', { wins: 1, winStreak: 1, lastPlayed: '2026-11-12', lastResult: 'won' });
  store.saveResult({ playerId: '2', date: '2026-11-12', won: true, monsLeft: 5, redLeft: 0, turns: 12 });
  await bot.refreshBoard(GUILD);
  const edit = discord.edits().at(-1);
  assert.equal(edit.path, '/channels/c-general/messages/orig-tok1');
  const race = edit.body.embeds[0].fields.find((f) => f.name === '🏆 Master race').value;
  assert.match(race, /<@2> · \*\*1W\*\* 0L · ✅ beat RED today/);
  assert.equal(edit.body.embeds[0].fields.find((f) => f.name === '➡️ Standing').value, '<@1> is 2nd, level on wins with <@2> but behind on tiebreaks.');

  // Deleted by someone: forgotten, nothing more to edit.
  discord.deleted.add('orig-tok1');
  await bot.refreshBoard(GUILD);
  assert.equal(JSON.parse(store.getSetting(`board:${GUILD}`)), null);
});

test("the banner over today's card: off until an admin previews it and turns it on", async () => {
  const discord = fakeDiscord();
  const store = openStore(':memory:');
  const bot = createBot({ token: 'bot-token', clientId: '999', store, fetch: discord.fetch, log: quiet, now: () => new Date('2026-11-12T15:00:00Z'), publicUrl: 'https://nas.example.ts.net' });
  store.savePlayer({ id: '1', name: 'Ash', avatarUrl: '', stats: { ...EMPTY, pending: '2026-11-12' } });
  store.joinRoom(`g:${GUILD}`, '1');
  await bot.updateCard(GUILD, '2026-11-12');
  const plain = discord.posts()[0].body;
  assert.equal(plain.embeds.length, 1, 'off to start with: the card looks as before');
  assert.equal(plain.embeds[0].thumbnail.url, 'https://nas.example.ts.net/sprites/front/25.png');

  const preview = bot.interaction({ type: 2, guild_id: GUILD, member: { user: { id: '1' }, permissions: '32' }, data: { name: 'dailyred-preview' } });
  assert.equal(preview.type, 4);
  assert.equal(preview.data.flags, 64, 'only the admin sees the preview');
  assert.deepEqual(preview.data.embeds[0], { color: 0xd63a3a, image: { url: 'https://nas.example.ts.net/sprites/banner.png?v=1' } });
  assert.equal(preview.data.embeds[1].title, 'Daily Red No. 12 · Thu, Nov 12');
  assert.equal(preview.data.embeds[1].thumbnail, undefined, 'no Pikachu in the corner under the banner');
  assert.equal(preview.data.components[0].components[0].custom_id, 'dailyred:banner-on');
  assert.equal(discord.edits().length, 0, "previewing doesn't touch the real card");

  const press = (permissions, id) => bot.interaction({ type: 3, guild_id: GUILD, member: { user: { id: '1' }, permissions }, data: { custom_id: id } });
  const refused = press('2048', 'dailyred:banner-on'); // can send messages, can't manage the server
  assert.match(refused.data.content, /^Only people who can manage this server/);
  assert.equal(bot.cardMessage(GUILD, '2026-11-12').embeds.length, 1);

  const on = press(String(1n << 5n), 'dailyred:banner-on');
  assert.equal(on.type, 7, 'the preview updates in place');
  assert.equal(on.data.components[0].components[0].custom_id, 'dailyred:banner-off');
  await new Promise((ok) => setTimeout(ok, 20));
  const edited = discord.edits().at(-1).body;
  assert.equal(edited.embeds[0].image.url, 'https://nas.example.ts.net/sprites/banner.png?v=1', "today's card gets it straight away");
  assert.equal(bot.cardMessage(GUILD, '2026-11-13').embeds.length, 2, "and tomorrow's");

  press(String(1n << 3n), 'dailyred:banner-off'); // administrators can too
  assert.equal(bot.cardMessage(GUILD, '2026-11-13').embeds.length, 1);
});

test('the banner is drawn at build time from the sprites', async () => {
  const { existsSync } = await import('node:fs');
  const sprites = new URL('../../web/sprites/', import.meta.url).pathname;
  if (!existsSync(`${sprites}trainers/red.png`)) return; // scripts/get-sprites.sh hasn't run here
  const { drawBanner } = await import('../banner.mjs');
  const { decodePng } = await import('../png.mjs');
  const png = drawBanner({ sprites });
  const { width, height, data } = decodePng(png);
  assert.deepEqual([width, height], [680, 240]);
  assert.deepEqual([...data.subarray(0, 4)], [0x5f, 0xa8, 0xe8, 255], 'sky in the top corner');
});
