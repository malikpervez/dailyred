// Daily Red's bot: posts the day's battles in each Discord server, like
// Wordle's app does.
//
//   - The live card: one message per server per day in #general (or the
//     channel named by DAILYRED_CHANNEL), posted when the first battle of the
//     day starts there and edited as players start and finish. It shows each
//     player's result, Pokémon left, turns and streak, never their team.
//   - The morning recap: yesterday's results ranked, win streak leaders, the
//     server's days-in-a-row streak and who didn't play, at RECAP_TIME in
//     RECAP_TIMEZONE (06:00 America/New_York by default).
//   - Buttons on both: "Battle RED" launches the Activity, "Leaderboard" shows
//     the server's leaderboard to whoever pressed it. Discord sends button
//     presses to POST /api/interactions (app.mjs), checked with the app's
//     public key.
//
// It only uses Discord's HTTP API with the bot token (plus one Gateway login,
// which Discord requires before a bot's first message).
import { createPublicKey, verify } from 'node:crypto';
import { EMPTY, addDays, currentStreaks, dayNumber } from '../web/daily.js';

const API = 'https://discord.com/api/v10';
const RED = 0xd63a3a;
// View Channel, Send Messages, Embed Links, Read Message History.
export const BOT_PERMISSIONS = 1024 + 2048 + 16384 + 65536;
const PLAY_BUTTON = 'dailyred:play';
const BOARD_BUTTON = 'dailyred:board';
const MAX_LINES = 25;

export const inviteUrl = (clientId) =>
  `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`;

// --- Text ------------------------------------------------------------------------------

const squares = (left) => (left == null ? '' : '🟥'.repeat(left) + '⬛'.repeat(Math.max(0, 6 - left)));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const dateLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// Wins first (more Pokémon left, then fewer turns), then losses (RED left with
// fewer, then more of yours left, then fewer turns).
export function compareResults(a, b) {
  if (a.won !== b.won) return a.won ? -1 : 1;
  if (a.won) return (b.monsLeft ?? 0) - (a.monsLeft ?? 0) || (a.turns ?? 999) - (b.turns ?? 999);
  return (a.redLeft ?? 6) - (b.redLeft ?? 6) || (b.monsLeft ?? 0) - (a.monsLeft ?? 0) || (a.turns ?? 999) - (b.turns ?? 999);
}

function resultLine(player, result, streaks) {
  const turns = result.turns ? ` · ${plural(result.turns, 'turn')}` : '';
  let line;
  if (result.won) {
    line = `<@${player.id}> **Beat RED**${result.monsLeft != null ? ` with ${result.monsLeft} left` : ''}${turns}`;
    if (streaks.winStreak > 1) line += ` · 🔥 ${streaks.winStreak}-day win streak`;
  } else {
    line = `<@${player.id}> Lost to RED${result.redLeft != null ? `, he had ${result.redLeft} left` : ''}${turns}`;
    if (streaks.dayStreak > 1) line += ` · 📅 ${streaks.dayStreak} days in a row`;
  }
  const grid = squares(result.monsLeft);
  return grid ? `${line}\n${grid}` : line;
}

const cap = (lines) => (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `…and ${lines.length - MAX_LINES} more`] : lines);

// --- The bot -------------------------------------------------------------------------------

export function createBot({
  token,
  clientId,
  publicKey = null,
  store,
  channelName = 'general',
  recapTime = '06:00',
  recapTimeZone = 'America/New_York',
  publicUrl = null,
  fetch = globalThis.fetch,
  now = () => new Date(),
  api = API,
  log = console,
}) {
  const key = publicKey ? createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]),
    format: 'der',
    type: 'spki',
  }) : null;
  const channels = new Map(); // guild id -> { id, until } or { missing, until }
  const queues = new Map(); // guild:date -> promise, so card edits don't race
  const failedRecaps = new Map(); // guild:date -> time of the last failed try
  let timer = null;

  // --- Discord HTTP API --------------------------------------------------------------

  async function discord(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${api}${path}`, {
        method,
        headers: { Authorization: `Bot ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
        body: body && JSON.stringify(body),
      });
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      if (res.status === 429 && attempt < 2) {
        await new Promise((ok) => setTimeout(ok, Math.min(5, data?.retry_after ?? 1) * 1000));
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`Discord ${method} ${path}: HTTP ${res.status} ${data?.message ?? ''}`), { status: res.status });
      return data;
    }
  }

  // The channel to post in: the text channel called `channelName` (#general),
  // or the server's system channel. Looked up again after an hour.
  async function channelFor(guildId) {
    const cached = channels.get(guildId);
    if (cached && cached.until > Date.now()) return cached.id ?? null;
    let id = null;
    try {
      const list = await discord('GET', `/guilds/${guildId}/channels`);
      id = list.find((c) => (c.type === 0 || c.type === 5) && c.name.toLowerCase() === channelName.toLowerCase())?.id ?? null;
      if (!id) id = (await discord('GET', `/guilds/${guildId}`)).system_channel_id ?? null;
      if (!id) log.warn(`Daily Red bot: server ${guildId} has no #${channelName} channel to post in.`);
    } catch (err) {
      log.warn(`Daily Red bot can't see server ${guildId} (${err.message}). Invite it with ${inviteUrl(clientId)}`);
    }
    channels.set(guildId, { id, until: Date.now() + 60 * 60 * 1000 });
    return id;
  }

  const buttons = (label) => (key ? [{
    type: 1,
    components: [
      { type: 2, style: 3, label, emoji: { name: '▶️' }, custom_id: PLAY_BUTTON },
      { type: 2, style: 2, label: 'Leaderboard', custom_id: BOARD_BUTTON },
    ],
  }] : []);
  const thumbnail = publicUrl ? { url: `${publicUrl.replace(/\/$/, '')}/sprites/front/25.png` } : undefined;

  // --- The live card --------------------------------------------------------------------

  function cardMessage(guildId, date) {
    const room = `g:${guildId}`;
    const results = store.roomResults(room, date);
    const players = store.roomPlayers(room).map((p) => ({ ...p, stats: { ...EMPTY, ...p.stats } }));
    const finished = players.filter((p) => results.has(p.id))
      .sort((a, b) => compareResults(results.get(a.id), results.get(b.id)));
    const battling = players.filter((p) => !results.has(p.id) && p.stats.pending === date);
    const lines = [
      ...finished.map((p) => resultLine(p, results.get(p.id), currentStreaks(p.stats, date))),
      ...battling.map((p) => `<@${p.id}> ⚔️ Battling RED…`),
    ];
    const wins = finished.filter((p) => results.get(p.id).won).length;
    const summary = [
      finished.length && `${wins} of ${finished.length} beat RED`,
      battling.length && `${battling.length} battling`,
    ].filter(Boolean).join(' · ');
    return {
      embeds: [{
        color: RED,
        title: `Daily Red No. ${dayNumber(date)} · ${dateLabel(date)}`,
        description: cap(lines).join('\n') || 'Nobody has battled RED yet today.',
        thumbnail,
        footer: { text: `${summary ? `${summary} · ` : ''}New team at midnight, your time` },
      }],
      components: buttons('Battle RED'),
      allowed_mentions: { parse: [] },
    };
  }

  // Posts or edits the server's card for `date`. Never throws.
  function updateCard(guildId, date) {
    const queueKey = `${guildId}:${date}`;
    const run = async () => {
      const message = cardMessage(guildId, date);
      const card = store.getCard(guildId, date);
      if (card) {
        try {
          await discord('PATCH', `/channels/${card.channelId}/messages/${card.messageId}`, message);
          return;
        } catch (err) {
          if (err.status !== 404) throw err; // deleted: post a new one
        }
      }
      const channelId = await channelFor(guildId);
      if (!channelId) return;
      const posted = await discord('POST', `/channels/${channelId}/messages`, message);
      store.saveCard(guildId, date, channelId, posted.id);
    };
    const next = (queues.get(queueKey) ?? Promise.resolve()).then(run)
      .catch((err) => log.warn(`Daily Red bot couldn't update the card for server ${guildId}: ${err.message}`));
    queues.set(queueKey, next);
    next.finally(() => { if (queues.get(queueKey) === next) queues.delete(queueKey); });
    return next;
  }

  // --- The morning recap -----------------------------------------------------------------

  // Wall-clock date and "HH:MM" in the recap's time zone.
  function zonedNow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: recapTimeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now()).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  }

  // How many days in a row (ending on `date`) someone in the room finished a battle.
  function serverStreak(room, date) {
    let streak = 0;
    let day = date;
    for (const played of store.roomDates(room, date)) {
      if (played !== day) break;
      streak++;
      day = addDays(day, -1);
    }
    return streak;
  }

  function recapMessage(guildId, date) {
    const room = `g:${guildId}`;
    const results = store.roomResults(room, date);
    const players = store.roomPlayers(room).map((p) => ({ ...p, stats: { ...EMPTY, ...p.stats } }));
    const finished = players.filter((p) => results.has(p.id))
      .sort((a, b) => compareResults(results.get(a.id), results.get(b.id)));
    const left = players.filter((p) => !results.has(p.id) && p.stats.pending === date);
    const recent = new Set(store.recentPlayers(room, addDays(date, -7), date));
    const missed = players.filter((p) => recent.has(p.id) && !results.has(p.id) && p.stats.pending !== date);
    const today = addDays(date, 1);
    const streaks = players
      .map((p) => ({ p, s: currentStreaks(p.stats, today).winStreak }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);

    const wins = finished.filter((p) => results.get(p.id).won).length;
    const streak = serverStreak(room, date);
    const lines = [
      `**${wins} of ${finished.length} beat RED**${streak > 1 ? ` · this server has played ${streak} days in a row` : ''}`,
      '',
      ...cap(finished.map((p, i) => `${i === 0 ? '👑' : `**${i + 1}.**`} ${resultLine(p, results.get(p.id), currentStreaks(p.stats, date))}`)),
      ...left.map((p) => `<@${p.id}> Left the battle (counts as a loss)`),
    ];
    if (streaks.length) lines.push('', `🔥 Win streaks: ${streaks.map(({ p, s }) => `<@${p.id}> ${s}`).join(' · ')}`);
    if (missed.length) lines.push(`💤 Didn't play: ${missed.slice(0, 10).map((p) => `<@${p.id}>`).join(' ')}`);
    return {
      embeds: [{
        color: RED,
        title: `Yesterday's results · Daily Red No. ${dayNumber(date)}`,
        description: lines.join('\n'),
        thumbnail,
        footer: { text: `${dateLabel(date)} · Today's team is No. ${dayNumber(today)}` },
      }],
      components: buttons(`Play No. ${dayNumber(today)}`),
      allowed_mentions: { parse: [] },
    };
  }

  async function postRecap(guildId, date) {
    const channelId = await channelFor(guildId);
    if (!channelId) throw new Error('no channel to post in');
    await discord('POST', `/channels/${channelId}/messages`, recapMessage(guildId, date));
    store.markRecapPosted(guildId, date);
  }

  // Runs every minute: from RECAP_TIME on, posts yesterday's recap in every
  // server where someone finished a battle yesterday (once; failed tries are
  // retried every 30 minutes).
  async function tick() {
    const { date: todayZoned, time } = zonedNow();
    if (time < recapTime) return;
    const date = addDays(todayZoned, -1);
    for (const room of store.roomsWithResults(date)) {
      const guildId = room.slice(2);
      const failKey = `${guildId}:${date}`;
      if (store.recapPosted(guildId, date)) continue;
      if (Date.now() - (failedRecaps.get(failKey) ?? 0) < 30 * 60 * 1000) continue;
      try {
        await postRecap(guildId, date);
        failedRecaps.delete(failKey);
      } catch (err) {
        failedRecaps.set(failKey, Date.now());
        log.warn(`Daily Red bot couldn't post the recap for server ${guildId}: ${err.message}`);
      }
    }
  }

  // --- Leaderboard --------------------------------------------------------------------------

  // Everyone in the room: current and best win streak, wins, losses, win rate.
  function leaderboard(room, date) {
    return store.roomPlayers(room).map((p) => {
      const stats = { ...EMPTY, ...p.stats };
      const { winStreak, dayStreak } = currentStreaks(stats, date);
      const played = stats.wins + stats.losses;
      return {
        id: p.id, name: p.name, avatarUrl: p.avatarUrl, winStreak, dayStreak,
        bestWinStreak: Math.max(stats.bestWinStreak || 0, stats.winStreak), wins: stats.wins, losses: stats.losses,
        played, winRate: played ? Math.round((stats.wins / played) * 100) : 0,
      };
    }).filter((p) => p.played > 0)
      .sort((a, b) => b.winStreak - a.winStreak || b.wins - a.wins || b.winRate - a.winRate || a.name.localeCompare(b.name));
  }

  function leaderboardMessage(guildId) {
    const { date } = zonedNow();
    const rows = leaderboard(`g:${guildId}`, date).slice(0, 15);
    const lines = rows.map((p, i) => `**${i + 1}.** <@${p.id}> 🔥 ${p.winStreak} · best ${p.bestWinStreak} · ${p.wins}W ${p.losses}L (${p.winRate}%)`);
    return {
      flags: 64, // only the person who pressed the button sees it
      embeds: [{ color: RED, title: 'Daily Red leaderboard', description: lines.join('\n') || 'Nobody here has battled RED yet.' }],
      allowed_mentions: { parse: [] },
    };
  }

  // --- Interactions (button presses) -----------------------------------------------------------

  // Checks Discord's signature on a request to the interactions endpoint.
  function verifyRequest(headers, rawBody) {
    if (!key) return false;
    const signature = headers['x-signature-ed25519'];
    const timestamp = headers['x-signature-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
    try {
      return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, 'hex'));
    } catch {
      return false;
    }
  }

  // The response to a (verified) interaction.
  function interaction(body) {
    if (body.type === 1) return { type: 1 }; // PING
    const id = body.data?.custom_id ?? body.data?.name;
    if (body.type === 3 && id === BOARD_BUTTON && body.guild_id) return { type: 4, data: leaderboardMessage(body.guild_id) };
    if (body.type === 3 && id === PLAY_BUTTON) return { type: 12 }; // LAUNCH_ACTIVITY
    if (body.type === 2) return { type: 12 }; // the app's launch command
    return { type: 4, data: { flags: 64, content: "That button doesn't do anything any more." } };
  }

  // --- Start / stop ---------------------------------------------------------------------------

  // Discord wants a bot to log in to the Gateway once before its first message.
  async function identifyOnce() {
    if (store.getSetting('gateway_identified') || typeof WebSocket !== 'function') return;
    await new Promise((resolve) => {
      const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
      const done = () => { clearTimeout(timeout); try { ws.close(); } catch { /* already closed */ } resolve(); };
      const timeout = setTimeout(done, 15000);
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.op === 10) {
          ws.send(JSON.stringify({ op: 2, d: { token, intents: 0, properties: { os: 'linux', browser: 'dailyred', device: 'dailyred' } } }));
        } else if (msg.t === 'READY') {
          store.setSetting('gateway_identified', '1');
          log.log(`Daily Red bot logged in as ${msg.d.user.username}.`);
          done();
        } else if (msg.op === 9) {
          log.warn('Daily Red bot: Discord rejected the bot token (DISCORD_BOT_TOKEN).');
          done();
        }
      });
      ws.addEventListener('error', done);
      ws.addEventListener('close', done);
    });
  }

  return {
    updateCard,
    tick,
    leaderboard,
    verifyRequest,
    interaction,
    cardMessage,
    recapMessage,
    get canVerify() { return Boolean(key); },
    async start() {
      await identifyOnce().catch((err) => log.warn(`Daily Red bot login failed: ${err.message}`));
      timer = setInterval(() => tick().catch((err) => log.warn(err)), 60 * 1000);
      timer.unref?.();
      tick().catch((err) => log.warn(err));
    },
    stop() { clearInterval(timer); },
  };
}
