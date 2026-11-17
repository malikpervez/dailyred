// Daily Red's bot: posts the day's battles in each Discord server, like
// Wordle's app does.
//
//   - The live card: one message per server per day in #general (or the
//     channel named by DAILYRED_CHANNEL), posted when the first battle of the
//     day starts there and edited as players start and finish. It shows each
//     player's result, Pokémon left, turns and streak (never their team), and
//     the month's Master race. When someone finishes and the card has
//     scrolled up (BUMP_AFTER newer messages), it moves back to the bottom.
//   - The morning recap: yesterday's results ranked, win streak leaders, the
//     month's Master race, the server's days-in-a-row streak and who didn't
//     play, at RECAP_TIME in RECAP_TIMEZONE (06:00 America/New_York by default).
//   - Pokémon Master of the Month: on the 1st, right after the recap, the
//     player with the most wins last month (ties: fewer losses, then more
//     Pokémon left, then fewer turns; still tied = co-Masters). They're kept
//     in the Hall of Fame, and wear a 👑 all the next month. Streaks start
//     over that day (web/daily.js).
//   - The weekly leaderboard: Mondays, right after the recap.
//   - Daily reminders: players who press "Reminders" get mentioned at
//     REMINDER_TIME (17:00 by default) on days they haven't played yet.
//   - How to play: once per server. Today's card goes up at RECAP_TIME too,
//     below the recap, so each day starts with something to tap.
//   - News: a one-time announcement on the morning a feature starts (NEWS),
//     between the recap and today's card.
//   - Each result: when someone finishes the day's battle, a short post of
//     how it went (squares, prize money, their place in the month's race),
//     just below the card, like Wordle's app.
//   - /dailyred: your day, how to play and the buttons, privately.
//   - Buttons on all of them: "Battle RED" opens the website for that server
//     (or, without PUBLIC_URL, launches the Activity),
//     "Leaderboard" posts the leaderboard and Hall of Fame in the channel
//     (replacing the last one), "Reminders" turns their reminder on or off. Discord sends button
//     presses to POST /api/interactions (app.mjs), checked with the app's
//     public key.
//
// It only uses Discord's HTTP API with the bot token (plus one Gateway login,
// which Discord requires before a bot's first message).
import { createPublicKey, verify } from 'node:crypto';
import { EMPTY, addDays, currentStreaks, dayNumber, resultFor, undoResult } from '../web/daily.js';
import {
  economyOpen, ECONOMY_START, ECONOMY_START_LABEL, PRIZE, ITEMS, WEEKLY_BAG, CARRY_LIMIT, prizeFor, walletFor,
} from '../web/economy.js';
import { ROAD, ROAD_START, TRAINERS, trainerOn, roadOpen } from '../web/road.js';
import { scheduleFor, nextMonth as cupNextMonth, MAX_PLAYERS, MIN_PLAYERS, ROUND_DAYS } from './cup-month.mjs';
import { onClock as draftOnClock } from './cup-draft.mjs';

const API = 'https://discord.com/api/v10';
const RED = 0xd63a3a;
const GOLD = 0xf0b232;
// View Channel, Send Messages, Embed Links, Read Message History.
export const BOT_PERMISSIONS = 1024 + 2048 + 16384 + 65536;
const PLAY_BUTTON = 'dailyred:play';
const BOARD_BUTTON = 'dailyred:board';
const REMIND_BUTTON = 'dailyred:remind';
const BANNER_ON = 'dailyred:banner-on';
const BANNER_OFF = 'dailyred:banner-off';
const CUP_JOIN = 'cup:join';
const CUP_LEAVE = 'cup:leave';
const CUP_GOLD = 0xe0a800;
const REDO_COMMAND = 'dailyred-redo';
const REDO_DAYS = 3; // how far back /dailyred-redo reaches
const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;
const MAX_LINES = 25;
// The card moves to the bottom of the channel when a battle finishes and
// it's no longer among the channel's last this-many messages.
const BUMP_AFTER = 10;

export const inviteUrl = (clientId) =>
  `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}`;

// --- Text ------------------------------------------------------------------------------

const squares = (left) => (left == null ? '' : '🟥'.repeat(left) + '⬛'.repeat(Math.max(0, 6 - left)));
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const dateLabel = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (month) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthName = (month) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
const shortMonth = (month) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export const nextMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
export const previousMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const timeLabel = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const zoneLabel = (zone) => ({ 'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain', 'America/Los_Angeles': 'Pacific' }[zone] ?? zone);

// Wins first (more Pokémon left, then fewer turns), then losses (RED left with
// fewer, then more of yours left, then fewer turns).
export function compareResults(a, b) {
  if (a.won !== b.won) return a.won ? -1 : 1;
  if (a.won) return (b.monsLeft ?? 0) - (a.monsLeft ?? 0) || (a.turns ?? 999) - (b.turns ?? 999);
  return (a.redLeft ?? 6) - (b.redLeft ?? 6) || (b.monsLeft ?? 0) - (a.monsLeft ?? 0) || (a.turns ?? 999) - (b.turns ?? 999);
}

// The Master of the Month race: most wins, then fewer losses, then more
// Pokémon left in total, then fewer turns.
export function compareMonths(a, b) {
  return b.wins - a.wins || a.losses - b.losses || b.monsLeft - a.monsLeft || a.turns - b.turns;
}

// `crowned`: the set of player ids who are the reigning Pokémon Master.
const who = (id, crowned) => `<@${id}>${crowned?.has(id) ? ' 👑' : ''}`;
const ordinal = (n) => `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th'}`;

// `foe`: the day's trainer's name (RED, or the week's on the Road to RED).
// `named`: start with the player's mention (off where their name is shown already).
function resultLine(player, result, streaks, crowned, foe = 'RED', { named = true } = {}) {
  const name = named ? `${who(player.id, crowned)} ` : '';
  // Items from the bag (from Nov 15) count with the turns.
  const turns = (result.turns ? ` · ${plural(result.turns, 'turn')}` : '') + (result.items ? ` · 🎒 ${plural(result.items, 'item')}` : '');
  let line;
  if (result.won) {
    line = `${name}**Beat ${foe}**${result.monsLeft != null ? ` with ${result.monsLeft} left` : ''}${turns}`;
    if (streaks.winStreak > 1) line += ` · 🔥 ${streaks.winStreak}-day win streak`;
  } else if (result.gaveUp) {
    line = `${name}🏃 Ran from ${foe}${result.turns ? ` on turn ${result.turns}` : ''}`;
  } else {
    line = `${name}Lost to ${foe}${result.redLeft != null ? `, he had ${result.redLeft} left` : ''}${turns}`;
    if (streaks.dayStreak > 1) line += ` · 📅 ${streaks.dayStreak} days in a row`;
  }
  const grid = squares(result.monsLeft);
  return grid ? `${line}\n${grid}` : line;
}

const cap = (lines) => (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `…and ${lines.length - MAX_LINES} more`] : lines);
const MEDALS = ['🥇', '🥈', '🥉'];
const rank = (i) => MEDALS[i] ?? `**${i + 1}.**`;

// --- The bot -------------------------------------------------------------------------------

export function createBot({
  token,
  clientId,
  publicKey = null,
  store,
  channelName = 'general',
  recapTime = '06:00',
  recapTimeZone = 'America/New_York',
  reminderTime = '17:00',
  publicUrl = null,
  fetch = globalThis.fetch,
  now = () => new Date(),
  followUpDelay = 1500, // ms to wait before looking up a just-posted leaderboard
  teamOfDay = null, // date -> the day's six species (server.mjs), for the card
  cardPictures = false, // whether the server draws /card/<date>.png (card-image.mjs)
  api = API,
  log = console,
  cupMonth = null, // cup-month.mjs: the Daily Red Cup, posted in #<cupChannelName>
  cupChannelName = 'daily-red-cup',
}) {
  // The public key as pasted from the Developer Portal: 64 hex digits.
  // Stray spaces or quotes from copying are ignored.
  const keyHex = publicKey ? String(publicKey).trim().replace(/^["']|["']$/g, '').trim().toLowerCase() : '';
  let keyStatus = keyHex ? 'ok' : 'missing';
  let key = null;
  if (keyHex && !/^[0-9a-f]{64}$/.test(keyHex)) {
    keyStatus = 'invalid';
    log.warn(`DISCORD_PUBLIC_KEY doesn't look right (${keyHex.length} characters): it should be the 64 letters and digits`
      + ' under Developer Portal > General Information > Public Key.');
  } else if (keyHex) {
    key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(keyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
  }
  const posting = Boolean(token); // without a bot token, only the buttons work
  const channels = new Map(); // guild id -> { id, until }
  const queues = new Map(); // guild:date -> promise, so card edits don't race
  const failed = new Map(); // what:guild:date -> time of the last failed try
  let serverCache = null; // { ids, until }
  let timer = null;

  // --- Discord HTTP API --------------------------------------------------------------

  // The ids of the servers the bot is in (null if it can't tell), for the
  // website's sign-in. Looked up again after a minute.
  async function guildIds() {
    if (!posting) return null;
    if (serverCache && serverCache.until > Date.now()) return serverCache.ids;
    try {
      const guilds = await discord('GET', '/users/@me/guilds');
      serverCache = { ids: guilds.map((g) => String(g.id)), until: Date.now() + 60 * 1000 };
      return serverCache.ids;
    } catch (err) {
      log.warn(`Daily Red bot couldn't list its servers: ${err.message}`);
      return null;
    }
  }

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

  async function post(guildId, message) {
    const channelId = await channelFor(guildId);
    if (!channelId) throw new Error('no channel to post in');
    return discord('POST', `/channels/${channelId}/messages`, message);
  }

  const site = publicUrl ? publicUrl.replace(/\/$/, '') : null;
  // The play button: a link to the website for that server, where players
  // sign in with Discord (anyone can; the Activity is only for App Testers
  // until Discord verifies it). Without PUBLIC_URL, the Activity instead.
  const playButton = (label, guildId) => (site && guildId
    ? { type: 2, style: 5, label, emoji: { name: '▶️' }, url: `${site}/?g=${guildId}` }
    : key && { type: 2, style: 3, label, emoji: { name: '▶️' }, custom_id: PLAY_BUTTON });
  // The message buttons. The link works even without the public key; the
  // others are button presses, which need it.
  const buttons = (label, guildId) => {
    const row = [
      playButton(label, guildId),
      key && { type: 2, style: 2, label: 'Leaderboard', custom_id: BOARD_BUTTON },
      key && { type: 2, style: 2, label: 'Reminders', emoji: { name: '🔔' }, custom_id: REMIND_BUTTON },
    ].filter(Boolean);
    return row.length ? [{ type: 1, components: row }] : [];
  };

  // How to play, for the one-time welcome message and /dailyred.
  const roadNames = ROAD.map((id) => TRAINERS[id].name).join(', ');
  const howToLines = () => {
    const today = zonedNow().date;
    const t = trainerOn(today);
    return [
      roadOpen(today)
        ? `• One battle a day. This week it's **${t.name}**, ${t.title}: a new trainer every Monday on the Road to RED (${roadNames}, then round again). Everyone in the server gets the same six level 100 Pokémon.`
        : "• One battle a day against RED's team. Everyone in the server gets the same six level 100 Pokémon.",
      `• Tap **▶️ Battle ${t.name}**, sign in with Discord, pick your lead and battle. Your result shows up on the day's card here.`,
      '• The most wins in a month makes you **Pokémon Master of the Month** 👑, whoever they were against. Streaks start over on the 1st.',
      economyOpen(today)
        ? '• 🎒 Every battle pays prize money to spend in the PokéMart, and a free bag (3 Full Restores, 2 Revives, a Max Revive) refills every Monday. Up to 4 items a battle; each one takes your turn.'
        : `• 🎒 From ${ECONOMY_START_LABEL}: prize money for every battle, a PokéMart, and a free bag of items every Monday.`,
      !roadOpen(today) && `• 🏔️ From Monday, Nov 23: the Road to RED, a new trainer every week (${roadNames}), each one harder, building up to RED.`,
      `• **🔔 Reminders** mentions you at ${timeLabel(reminderTime)} ${zoneLabel(recapTimeZone)} on days you haven't played. **Leaderboard** shows the standings.`,
      '• Type `/dailyred` any time for these buttons.',
    ].filter(Boolean);
  };

  function howToMessage(guildId) {
    return {
      embeds: [{
        color: RED,
        title: 'How to play Daily Red',
        description: howToLines().join('\n'),
        thumbnail: thumbnailOn(zonedNow().date),
        footer: { text: `A new team every day · today's card goes up at ${timeLabel(recapTime)} ${zoneLabel(recapTimeZone)}` },
      }],
      components: buttons(battleLabel(zonedNow().date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  // /dailyred: today's number, whether you've played, and the buttons (only
  // the person who typed it sees it).
  function commandMessage(guildId, userId) {
    const { date } = zonedNow();
    const { results, players } = dayResults(`g:${guildId}`, date);
    const mine = userId && results.get(userId);
    const battling = players.some((p) => p.id === userId && p.stats.pending === date);
    const { name } = trainerOn(date);
    const status = mine ? (mine.won ? `You beat ${name} today${mine.monsLeft != null ? ` with ${mine.monsLeft} left` : ''}! 🔥`
      : mine.gaveUp ? `You ran from ${name} today. New team at midnight!` : `${name} won today. New team at midnight!`)
      : battling ? `You're battling ${name} right now.` : `You haven't battled ${name} today yet.`;
    const wins = [...results.values()].filter((r) => r.won).length;
    return {
      flags: 64,
      embeds: [{
        color: RED,
        title: `Daily Red No. ${dayNumber(date)} · ${dateLabel(date)}`,
        description: [`**${status}**`, results.size ? `${wins} of ${results.size} in this server beat ${name} today.` : '', teamLine(date), '', ...howToLines()]
          .filter((line, i) => line || i === 3).join('\n'),
      }],
      components: buttons(battleLabel(date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  // Adds /dailyred to Discord (once; POST adds or updates just this command,
  // leaving the Activity's own launch command alone).
  async function registerCommand() {
    const version = '3';
    if (store.getSetting('command:dailyred') === version) return;
    await discord('POST', `/applications/${clientId}/commands`, {
      name: 'dailyred',
      type: 1,
      description: "Play today's Daily Red, see the leaderboard or turn on reminders",
      contexts: [0], // in servers
      integration_types: [0],
    });
    await discord('POST', `/applications/${clientId}/commands`, {
      name: 'dailyred-preview',
      type: 1,
      description: "Admins: preview today's card with the Daily Red banner, and turn it on or off",
      contexts: [0],
      integration_types: [0],
      default_member_permissions: String(MANAGE_GUILD), // only shown to people who can manage the server
    });
    await discord('POST', `/applications/${clientId}/commands`, {
      name: REDO_COMMAND,
      type: 1,
      description: "Admins: clear a player's latest result (a battle lost to a crash) so they can battle again",
      options: [{ type: 6, name: 'player', description: 'Whose result to clear', required: true }], // 6: a user
      contexts: [0],
      integration_types: [0],
      default_member_permissions: String(MANAGE_GUILD),
    });
    store.setSetting('command:dailyred', version);
    log.log('Daily Red bot added the /dailyred, /dailyred-preview and /dailyred-redo commands.');
  }
  // The picture beside the bot's posts: the day's trainer on the Road to RED,
  // RED's Pikachu on RED's days.
  const thumbnailOn = (date) => {
    if (!site) return undefined;
    const { id } = trainerOn(date);
    return { url: id === 'red' ? `${site}/sprites/front/25.png` : `${site}/sprites/trainers/${id}.png` };
  };
  const battleLabel = (date) => `Battle ${trainerOn(date).name}`;
  // The day's lineup picture, which the server draws (card-image.mjs). Bump v=
  // if the drawing changes, so Discord fetches it again instead of its copy.
  const pictureUrl = (date) => (site && cardPictures ? `${site}/card/${date}.png?v=1` : null);

  // Wall-clock date and "HH:MM" in the recap's time zone.
  function zonedNow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: recapTimeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(now()).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday };
  }

  // The reigning Pokémon Master(s) on `date`: last month's.
  const crownedOn = (guildId, date) => new Set(store.masters(guildId)
    .filter((m) => m.month === previousMonth(date.slice(0, 7))).map((m) => m.playerId));

  // --- The live card --------------------------------------------------------------------

  // "**Today's team:** Pupitar · Umbreon · …": everyone's six for `date`, in
  // the day's order (never anyone's chosen lead). Worked out once a day.
  const teams = new Map();
  function teamLine(date) {
    if (!teamOfDay) return '';
    if (!teams.has(date)) {
      if (teams.size > 7) teams.clear();
      try {
        teams.set(date, teamOfDay(date));
      } catch (err) {
        log.warn(`Daily Red bot couldn't work out the team for ${date}: ${err.message}`);
        teams.set(date, null);
      }
    }
    const team = teams.get(date);
    return team?.length ? `**Today's team:** ${team.join(' · ')}` : '';
  }

  // The room's players and their results on `date`. Battles saved before
  // results were kept per day only have won/lost (from the player's stats).
  function dayResults(room, date) {
    const results = store.roomResults(room, date);
    const players = store.roomPlayers(room).map((p) => ({ ...p, stats: { ...EMPTY, ...p.stats } }));
    for (const p of players) {
      const result = resultFor(p.stats, date);
      if (result && !results.has(p.id)) results.set(p.id, { won: result === 'won', monsLeft: null, redLeft: null, turns: null });
    }
    return { results, players };
  }

  // `banner`: the Daily Red banner over the card (bannerOn() by default).
  function cardMessage(guildId, date, { banner = bannerOn(guildId) } = {}) {
    const room = `g:${guildId}`;
    const crowned = crownedOn(guildId, date);
    const { results, players } = dayResults(room, date);
    const finished = players.filter((p) => results.has(p.id))
      .sort((a, b) => compareResults(results.get(a.id), results.get(b.id)));
    const battling = players.filter((p) => !results.has(p.id) && p.stats.pending === date);
    const foe = trainerOn(date);
    const lines = [
      ...finished.map((p) => resultLine(p, results.get(p.id), currentStreaks(p.stats, date), crowned, foe.name)),
      ...battling.map((p) => `${who(p.id, crowned)} ⚔️ Battling ${foe.name}…`),
    ];
    const wins = finished.filter((p) => results.get(p.id).won).length;
    const summary = [
      finished.length && `${wins} of ${finished.length} beat ${foe.name}`,
      battling.length && `${battling.length} battling`,
    ].filter(Boolean).join(' · ');
    // The month's top three, so every update is a leaderboard update too.
    const month = date.slice(0, 7);
    const race = monthStandings(room, month).filter((x) => x.wins > 0).slice(0, 3);
    const raceLine = race.length ? `🏆 ${monthName(month)} race: ${race.map((x) => `${who(x.id, crowned)} ${x.wins}`).join(' · ')}` : '';
    const road = roadOpen(date) ? `🏔️ Week ${foe.week} of ${ROAD.length} on the Road to RED: **${foe.name}**, ${foe.title}` : '';
    const description = [road, teamLine(date), cap(lines).join('\n') || `Nobody has battled ${foe.name} yet today.`].filter(Boolean).join('\n\n');
    const card = {
      color: RED,
      title: `Daily Red No. ${dayNumber(date)} · ${dateLabel(date)}`,
      description: raceLine ? `${description}\n\n${raceLine}` : description,
      thumbnail: banner && pictureUrl(date) ? undefined : thumbnailOn(date), // the picture has the team already
      footer: { text: `${summary ? `${summary} · ` : ''}New team at midnight, your time` },
    };
    return {
      // The banner (today's six facing the day's trainer) as its own embed, so it sits on top.
      embeds: banner && pictureUrl(date) ? [{ color: RED, image: { url: pictureUrl(date) } }, card] : [card],
      components: buttons(battleLabel(date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  // --- The banner over the card: today's six facing RED (off until a server admin turns it on) ---

  function bannerOn(guildId) {
    return Boolean(site && cardPictures) && store.getSetting(`banner:${guildId}`) === 'on';
  }

  // /dailyred-preview (server admins only): today's card with the banner,
  // seen only by whoever typed it, and a button to turn it on or off.
  function previewMessage(guildId) {
    if (!site || !cardPictures) {
      return { flags: 64, content: "The banner needs PUBLIC_URL set on the server (Discord gets the picture from there) and the server's battle data (it's in the Docker image)." };
    }
    const on = bannerOn(guildId);
    const { embeds } = cardMessage(guildId, zonedNow().date, { banner: true });
    return {
      flags: 64,
      content: on
        ? '**Preview, only you can see this.** The banner is **on**: everyone sees today\'s card like this.'
        : '**Preview, only you can see this.** This is today\'s card with the banner. Everyone else still sees it without.',
      embeds,
      components: [{
        type: 1,
        components: [on
          ? { type: 2, style: 4, label: 'Turn the banner off', custom_id: BANNER_OFF }
          : { type: 2, style: 3, label: 'Turn the banner on for everyone', custom_id: BANNER_ON }],
      }],
      allowed_mentions: { parse: [] },
    };
  }

  // The switch: only people who can manage the server. Today's card (if it's
  // up) changes straight away.
  function setBanner(body, on) {
    const permissions = BigInt(body.member?.permissions ?? 0);
    if (!(permissions & MANAGE_GUILD) && !(permissions & ADMINISTRATOR)) {
      return { type: 4, data: { flags: 64, content: 'Only people who can manage this server can change the banner.' } };
    }
    store.setSetting(`banner:${body.guild_id}`, on ? 'on' : 'off');
    const today = zonedNow().date;
    if (store.getCard(body.guild_id, today)) updateCard(body.guild_id, today);
    log.log(`Daily Red bot: the card banner is ${on ? 'on' : 'off'} in server ${body.guild_id}.`);
    return { type: 7, data: previewMessage(body.guild_id) }; // UPDATE_MESSAGE: the preview shows the new state
  }

  // /dailyred-redo player: for a battle lost to a crash. Clears the player's
  // latest result (from the last few days): their record goes back as it
  // was, the prize money it paid comes off, and the card and leaderboard
  // drop it. If it was today's, they can battle again today. Only people
  // who can manage the server; only they see the reply.
  function redo(body) {
    const reply = (content) => ({ type: 4, data: { flags: 64, content, allowed_mentions: { parse: [] } } });
    const permissions = BigInt(body.member?.permissions ?? 0);
    if (!(permissions & MANAGE_GUILD) && !(permissions & ADMINISTRATOR)) {
      return reply('Only people who can manage this server can clear a result.');
    }
    const playerId = String(body.data?.options?.find((o) => o.name === 'player')?.value ?? '');
    const player = playerId ? store.getPlayer(playerId) : null;
    const user = body.data?.resolved?.users?.[playerId];
    const name = player?.name ?? user?.global_name ?? user?.username ?? 'That player';
    const stats = { ...EMPTY, ...player?.stats };
    const date = stats.lastPlayed;
    const today = zonedNow().date;
    if (!player || !date) return reply(`${name} has no Daily Red result to clear.`);
    if (date < addDays(today, -REDO_DAYS)) {
      return reply(`${name}'s latest result is from ${dateLabel(date)}: only results from the last ${REDO_DAYS} days can be cleared.`);
    }
    const result = store.getResult(playerId, date);
    const lost = stats.lastResult === 'won' ? 'win' : 'loss';
    undoResult(stats, date, store.playerResults(playerId));
    store.savePlayer({ ...player, stats });
    store.deleteResult(playerId, date);
    store.clearProgress(playerId);
    // The prize money: what the result paid (older results didn't keep it:
    // a finished battle's is worked out again; a battle left unfinished paid nothing).
    const wallet = walletFor(store.getWallet(playerId), date);
    const paid = result?.prize ?? (result?.turns != null && economyOpen(date) ? prizeFor(result) : 0);
    const refund = wallet.month === date.slice(0, 7) ? Math.min(paid, wallet.cash) : 0;
    wallet.cash -= refund;
    wallet.earned = Math.max(0, wallet.earned - refund);
    if (wallet.battle?.date === date) wallet.battle = null; // a fresh battle carries a full bag
    store.saveWallet(playerId, wallet);
    if (store.getCard(body.guild_id, date)) updateCard(body.guild_id, date);
    refreshBoard(body.guild_id);
    log.log(`Daily Red bot: cleared player ${playerId}'s result on ${date} in server ${body.guild_id}.`);
    const record = `${stats.wins}W ${stats.losses}L`;
    return reply(date === today
      ? `Cleared ${name}'s ${lost} today. Their record is back to ${record}, and they can battle again today.`
      : `Cleared ${name}'s ${lost} on ${dateLabel(date)}. Their record is back to ${record}. That day's battle can't be played again, but today's can.`);
  }

  // Whether the card has scrolled up: not among the channel's latest
  // messages. If the bot can't tell, it isn't moved.
  async function buried(card) {
    try {
      const recent = await discord('GET', `/channels/${card.channelId}/messages?limit=${BUMP_AFTER}`);
      return recent.length >= BUMP_AFTER && !recent.some((m) => m.id === card.messageId);
    } catch {
      return false;
    }
  }

  // Posts or edits the server's card for `date`. With `bump` (a battle just
  // finished), a card that has scrolled up is deleted and posted again at
  // the bottom, so the update is seen. Never throws.
  function updateCard(guildId, date, { bump = false } = {}) {
    if (!posting) return Promise.resolve();
    const queueKey = `${guildId}:${date}`;
    const run = async () => {
      const message = cardMessage(guildId, date);
      let card = store.getCard(guildId, date);
      if (card && bump && await buried(card)) {
        try {
          await discord('DELETE', `/channels/${card.channelId}/messages/${card.messageId}`);
          card = null;
        } catch (err) {
          if (err.status === 404) card = null; // already gone; otherwise edit it where it is
        }
      }
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
      log.log(`Daily Red bot posted the card for ${date} in server ${guildId}.`);
    };
    const next = (queues.get(queueKey) ?? Promise.resolve()).then(run)
      .catch((err) => log.warn(`Daily Red bot couldn't update the card for server ${guildId}: ${err.message}`));
    queues.set(queueKey, next);
    next.finally(() => { if (queues.get(queueKey) === next) queues.delete(queueKey); });
    return next;
  }

  // --- Each result -----------------------------------------------------------------------
  // When someone finishes the day's battle (POST /api/battle, app.mjs): how
  // it went, with their name and avatar, the squares, the prize money it
  // paid (`prize`, web/economy.js) and their place in the month's race. It
  // goes in the card's queue, so it lands just below the card. Never throws.
  function resultMessage(guildId, date, playerId, { prize = 0 } = {}) {
    const room = `g:${guildId}`;
    const { results, players } = dayResults(room, date);
    const player = players.find((p) => p.id === playerId);
    const result = results.get(playerId);
    if (!player || !result) return null;
    const crowned = crownedOn(guildId, date);
    const foe = trainerOn(date);
    const month = date.slice(0, 7);
    const race = monthStandings(room, month).filter((x) => x.wins > 0);
    const place = race.findIndex((x) => x.id === playerId);
    const extras = [
      prize > 0 && `💰 +₽${prize.toLocaleString('en-US')}`,
      place >= 0 && `🏆 ${ordinal(place + 1)} in the ${monthName(month)} race with ${plural(race[place].wins, 'win')}`,
    ].filter(Boolean).join(' · ');
    const all = [...results.values()];
    return {
      embeds: [{
        color: result.won ? GOLD : RED,
        author: {
          name: `${player.name}${crowned.has(playerId) ? ' 👑' : ''} · Daily Red No. ${dayNumber(date)}`,
          ...(player.avatarUrl && { icon_url: player.avatarUrl }),
        },
        description: [resultLine(player, result, currentStreaks(player.stats, date), crowned, foe.name, { named: false }), extras].filter(Boolean).join('\n'),
        footer: { text: `${all.filter((r) => r.won).length} of ${all.length} here beat ${foe.name} today` },
      }],
      components: buttons(battleLabel(date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  function postResult(guildId, date, playerId, details = {}) {
    if (!posting) return Promise.resolve();
    const queueKey = `${guildId}:${date}`;
    const run = async () => {
      const message = resultMessage(guildId, date, playerId, details);
      if (message) await post(guildId, message);
    };
    const next = (queues.get(queueKey) ?? Promise.resolve()).then(run)
      .catch((err) => log.warn(`Daily Red bot couldn't post a result in server ${guildId}: ${err.message}`));
    queues.set(queueKey, next);
    next.finally(() => { if (queues.get(queueKey) === next) queues.delete(queueKey); });
    return next;
  }

  // Posts the day's card if there isn't one yet and someone in the server has
  // played or is battling (e.g. when the Activity is opened after a battle
  // that happened before the bot was set up).
  function ensureCard(guildId, date) {
    if (!posting || store.getCard(guildId, date)) return Promise.resolve();
    const { results, players } = dayResults(`g:${guildId}`, date);
    if (!results.size && !players.some((p) => p.stats.pending === date)) return Promise.resolve();
    return updateCard(guildId, date);
  }

  // --- The morning recap -----------------------------------------------------------------

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

  // Everyone in the room who battled in `month`, best first.
  function monthStandings(room, month) {
    return [...store.monthTotals(room, month)].map(([id, totals]) => ({ id, ...totals })).sort(compareMonths);
  }

  function recapMessage(guildId, date) {
    const room = `g:${guildId}`;
    const today = addDays(date, 1);
    const crowned = crownedOn(guildId, date);
    const { results, players } = dayResults(room, date);
    const finished = players.filter((p) => results.has(p.id))
      .sort((a, b) => compareResults(results.get(a.id), results.get(b.id)));
    const left = players.filter((p) => !results.has(p.id) && p.stats.pending === date);
    const recent = new Set(store.recentPlayers(room, addDays(date, -7), date));
    const missed = players.filter((p) => recent.has(p.id) && !results.has(p.id) && p.stats.pending !== date);
    const streaks = players
      .map((p) => ({ p, s: currentStreaks(p.stats, today).winStreak }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);

    const wins = finished.filter((p) => results.get(p.id).won).length;
    const streak = serverStreak(room, date);
    const lines = [
      `**${wins} of ${finished.length} beat ${trainerOn(date).name}**${streak > 1 ? ` · this server has played ${streak} days in a row` : ''}`,
      '',
      ...cap(finished.map((p, i) => `${rank(i)} ${resultLine(p, results.get(p.id), currentStreaks(p.stats, date), crowned, trainerOn(date).name)}`)),
      ...left.map((p) => `${who(p.id, crowned)} Left the battle (counts as a loss)`),
    ];
    const race = monthStandings(room, date.slice(0, 7)).filter((x) => x.wins > 0).slice(0, 3);
    const extras = [
      streaks.length && `🔥 Win streaks: ${streaks.map(({ p, s }) => `<@${p.id}> ${s}`).join(' · ')}`,
      race.length && `🏆 ${monthName(date.slice(0, 7))} Master race: ${race.map((x) => `<@${x.id}> ${x.wins}`).join(' · ')}`,
      missed.length && `💤 Didn't play: ${missed.slice(0, 10).map((p) => `<@${p.id}>`).join(' ')}`,
    ].filter(Boolean);
    if (extras.length) lines.push('', ...extras);
    return {
      embeds: [{
        color: RED,
        title: `Yesterday's results · Daily Red No. ${dayNumber(date)}`,
        description: lines.join('\n'),
        thumbnail: thumbnailOn(date),
        footer: { text: `${dateLabel(date)} · Today's team is No. ${dayNumber(today)}` },
      }],
      components: buttons(`Play No. ${dayNumber(today)}`, guildId),
      allowed_mentions: { parse: [] },
    };
  }

  // --- Pokémon Master of the Month ----------------------------------------------------------

  // The month's winners: everyone tied for first, if anyone won a battle.
  function mastersOf(standings) {
    const best = standings[0];
    return best && best.wins > 0 ? standings.filter((x) => compareMonths(x, best) === 0) : [];
  }

  function monthMessage(guildId, month) {
    const standings = monthStandings(`g:${guildId}`, month);
    const masters = mastersOf(standings);
    const best = standings[0];
    const rate = (x) => Math.round((x.wins / Math.max(1, x.played)) * 100);
    const record = (x) => `**${plural(x.wins, 'win')}**, ${plural(x.losses, 'loss', 'losses')} (${rate(x)}%)`;
    const lines = [];
    if (masters.length === 1) {
      lines.push(`<@${best.id}> is the Pokémon Master of ${monthName(month)} with ${record(best)}!`);
    } else if (masters.length > 1) {
      lines.push(`It's a tie! ${masters.map((x) => `<@${x.id}>`).join(' and ')} share Pokémon Master of ${monthName(month)} with ${record(best)} each.`);
    } else {
      lines.push(`Nobody won a battle in ${monthName(month)}, so nobody takes the title this time.`);
    }
    const others = standings.filter((x) => !masters.includes(x)).slice(0, 4);
    if (others.length) {
      lines.push('', ...others.map((x, i) => `${['🥈', '🥉'][i] ?? `**${masters.length + i + 1}.**`} <@${x.id}> ${plural(x.wins, 'win')}, ${plural(x.losses, 'loss', 'losses')}`));
    }
    const next = monthName(nextMonth(month));
    lines.push('');
    if (masters.length === 1) lines.push(`<@${best.id}> wears the 👑 all ${next} and joins the Hall of Fame.`);
    else if (masters.length > 1) lines.push(`They wear the 👑 all ${next} and join the Hall of Fame.`);
    lines.push(`Everyone's streaks start over today. Good luck in ${next}!`);
    const battles = standings.reduce((n, x) => n + x.played, 0);
    return {
      embeds: [{
        color: GOLD,
        title: `🏆 Pokémon Master of ${monthLabel(month)}`,
        description: lines.join('\n'),
        thumbnail: thumbnailOn(zonedNow().date),
        footer: { text: `${plural(standings.length, 'trainer')} played ${plural(battles, 'battle')} in ${monthName(month)}` },
      }],
      components: buttons(battleLabel(zonedNow().date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  async function postMonth(guildId, month) {
    await post(guildId, monthMessage(guildId, month));
    for (const m of mastersOf(monthStandings(`g:${guildId}`, month))) store.saveMaster(guildId, month, m.id, m.wins, m.losses);
    store.markRecapPosted(guildId, `month:${month}`);
  }

  // --- Leaderboard --------------------------------------------------------------------------

  // Everyone in the room: this month's wins (the Master race), current and
  // best win streak, all-time wins, losses and win rate.
  function leaderboard(room, date) {
    const month = store.monthTotals(room, date.slice(0, 7));
    return store.roomPlayers(room).map((p) => {
      const stats = { ...EMPTY, ...p.stats };
      const { winStreak, dayStreak } = currentStreaks(stats, date);
      const played = stats.wins + stats.losses;
      const m = month.get(p.id);
      return {
        id: p.id, name: p.name, avatarUrl: p.avatarUrl, winStreak, dayStreak,
        bestWinStreak: Math.max(stats.bestWinStreak || 0, stats.winStreak), wins: stats.wins, losses: stats.losses,
        played, winRate: played ? Math.round((stats.wins / played) * 100) : 0,
        monthWins: m?.wins ?? 0, monthLosses: m?.losses ?? 0, monthLeft: m?.monsLeft ?? 0, monthTurns: m?.turns ?? 0,
      };
    }).filter((p) => p.played > 0)
      .sort((a, b) => compareMonths(
        { wins: a.monthWins, losses: a.monthLosses, monsLeft: a.monthLeft, turns: a.monthTurns },
        { wins: b.monthWins, losses: b.monthLosses, monsLeft: b.monthLeft, turns: b.monthTurns },
      ) || b.winStreak - a.winStreak || b.wins - a.wins || a.name.localeCompare(b.name));
  }

  // The Hall of Fame: past Masters, newest first, grouped by month.
  function hallOfFame(guildId) {
    const months = new Map();
    for (const m of store.masters(guildId)) {
      if (!months.has(m.month)) months.set(m.month, []);
      months.get(m.month).push(m);
    }
    return [...months].map(([month, masters]) => ({ month, masters }));
  }

  const hallLines = (guildId, limit) => hallOfFame(guildId).slice(0, limit)
    .map(({ month, masters }) => `**${shortMonth(month)}** ${masters.map((m) => `<@${m.playerId}>`).join(' & ')} (${plural(masters[0].wins, 'win')})`);

  // Lines for an embed field, cut to Discord's 1024-character limit.
  function fieldValue(lines) {
    const out = [...lines];
    let more = 0;
    while (out.length > 1 && out.join('\n').length > 1000) {
      out.pop();
      more++;
    }
    if (more) out.push(`…and ${more} more`);
    return out.join('\n');
  }

  // Where `id` is in the month's race, e.g. "<@3> is 3rd, 2 wins behind <@1>."
  function standingLine(race, id) {
    const i = race.findIndex((p) => p.id === id);
    if (i < 0) return `<@${id}> hasn't battled this month yet.`;
    const me = race[i];
    if (race.length === 1) return `<@${id}> is the only one in the race so far.`;
    if (i === 0) {
      const gap = me.monthWins - race[1].monthWins;
      return gap > 0 ? `<@${id}> leads, ${plural(gap, 'win')} ahead of <@${race[1].id}>.` : `<@${id}> leads on tiebreaks.`;
    }
    const gap = race[0].monthWins - me.monthWins;
    const place = `${i + 1}${{ 1: 'st', 2: 'nd', 3: 'rd' }[(i + 1) % 100 > 10 && (i + 1) % 100 < 14 ? 0 : (i + 1) % 10] ?? 'th'}`;
    return gap > 0
      ? `<@${id}> is ${place}, ${plural(gap, 'win')} behind <@${race[0].id}>.`
      : `<@${id}> is ${place}, level on wins with <@${race[0].id}> but behind on tiebreaks.`;
  }

  // The leaderboard in sections: the month's Master race (with how each
  // player did today), win streaks, all time and the Hall of Fame. `viewer`:
  // who pressed the button, to say where they stand. `showToday`: off for the
  // Monday post, which goes out before anyone has played that day.
  function boardEmbed(guildId, date, { title, viewer = null, showToday = true }) {
    const room = `g:${guildId}`;
    const month = date.slice(0, 7);
    const crowned = crownedOn(guildId, date);
    const rows = leaderboard(room, date);
    const { results, players } = dayResults(room, date);
    const battling = new Set(players.filter((p) => !results.has(p.id) && p.stats.pending === date).map((p) => p.id));
    const today = (id) => {
      const r = results.get(id);
      if (!r) return battling.has(id) ? '⚔️ battling' : '⏳ not yet';
      return r.won ? `✅ beat ${trainerOn(date).name} today` : r.gaveUp ? '🏃 ran today' : '❌ lost today';
    };

    const [y, m] = month.split('-').map(Number);
    const daysLeft = new Date(Date.UTC(y, m, 0)).getUTCDate() - Number(date.slice(8));
    const intro = [
      `${daysLeft === 0 ? `Last day of ${monthName(month)}` : `${plural(daysLeft, 'day')} left`} · most wins becomes Pokémon Master`,
    ];
    if (crowned.size) intro.push(`👑 Reigning Master: ${[...crowned].map((id) => `<@${id}>`).join(' & ')}`);

    const race = rows.filter((p) => p.monthWins + p.monthLosses > 0);
    const fields = [{
      name: '🏆 Master race',
      value: race.length
        ? fieldValue(race.map((p, i) => `${rank(i)} ${who(p.id, crowned)} · **${p.monthWins}W** ${p.monthLosses}L${showToday ? ` · ${today(p.id)}` : ''}`))
        : `Nobody has battled yet in ${monthName(month)}.`,
    }];
    const streaks = rows.filter((p) => p.winStreak > 0).sort((a, b) => b.winStreak - a.winStreak || b.bestWinStreak - a.bestWinStreak).slice(0, 5);
    if (streaks.length) {
      fields.push({ name: '🔥 Win streaks', value: streaks.map((p) => `<@${p.id}> **${p.winStreak}** (best ${p.bestWinStreak})`).join(' · ') });
    }
    const allTime = [...rows].filter((p) => p.wins > 0).sort((a, b) => b.wins - a.wins || b.winRate - a.winRate).slice(0, 5);
    if (allTime.length) {
      fields.push({ name: '📈 All time', value: allTime.map((p) => `<@${p.id}> **${p.wins}W** ${p.winRate}%`).join(' · ') });
    }
    if (viewer && race.length) fields.push({ name: '➡️ Standing', value: standingLine(race, viewer) });
    const hall = hallLines(guildId, 6);
    if (hall.length) fields.push({ name: '🏛️ Hall of Fame', value: hall.join('\n') });

    return {
      color: RED,
      title,
      description: rows.length ? intro.join('\n') : 'Nobody here has battled yet.',
      fields: rows.length ? fields : [],
      thumbnail: thumbnailOn(date),
      footer: { text: `Daily Red No. ${dayNumber(date)} · press Leaderboard any time for the latest` },
    };
  }

  // The Leaderboard button: posted for everyone in the channel.
  function leaderboardMessage(guildId, viewer = null) {
    const { date } = zonedNow();
    return {
      embeds: [boardEmbed(guildId, date, { title: `Daily Red leaderboard · ${monthLabel(date.slice(0, 7))}`, viewer })],
      components: buttons(battleLabel(date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  // After the button's leaderboard is posted: the one before it in the server
  // is deleted, so the channel only ever has the latest.
  async function replaceOldBoard(guildId, interactionToken, viewer) {
    if (!posting) return;
    try {
      await new Promise((ok) => setTimeout(ok, followUpDelay)); // Discord needs a moment to post it
      const posted = await discord('GET', `/webhooks/${clientId}/${interactionToken}/messages/@original`);
      const previous = JSON.parse(store.getSetting(`board:${guildId}`) ?? 'null');
      store.setSetting(`board:${guildId}`, JSON.stringify({ channelId: posted.channel_id, messageId: posted.id, viewer }));
      if (previous && previous.messageId !== posted.id) {
        await discord('DELETE', `/channels/${previous.channelId}/messages/${previous.messageId}`).catch((err) => {
          if (err.status !== 404) throw err;
        });
      }
    } catch (err) {
      log.warn(`Daily Red bot couldn't tidy up the old leaderboard in server ${guildId}: ${err.message}`);
    }
  }

  // Brings the server's posted leaderboard up to date (after a battle), so
  // it never shows old standings. Queued like the card's edits. Never throws.
  function refreshBoard(guildId) {
    if (!posting) return Promise.resolve();
    const queueKey = `board:${guildId}`;
    const run = async () => {
      const saved = JSON.parse(store.getSetting(queueKey) ?? 'null');
      if (!saved) return;
      try {
        await discord('PATCH', `/channels/${saved.channelId}/messages/${saved.messageId}`, leaderboardMessage(guildId, saved.viewer ?? null));
      } catch (err) {
        if (err.status === 404 || err.status === 403) store.setSetting(queueKey, 'null'); // deleted, or not ours to edit
        throw err;
      }
    };
    const next = (queues.get(queueKey) ?? Promise.resolve()).then(run)
      .catch((err) => log.warn(`Daily Red bot couldn't update the leaderboard in server ${guildId}: ${err.message}`));
    queues.set(queueKey, next);
    next.finally(() => { if (queues.get(queueKey) === next) queues.delete(queueKey); });
    return next;
  }

  // Mondays: the same leaderboard, for everyone.
  function weeklyMessage(guildId, date) {
    return {
      embeds: [boardEmbed(guildId, date, { title: `📊 Weekly leaderboard · ${monthLabel(date.slice(0, 7))}`, showToday: false })],
      components: buttons(battleLabel(date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  // --- News ------------------------------------------------------------------------------------
  // Announced once per server at RECAP_TIME on the day a feature starts (or
  // a later morning that week, if the bot was down then). Servers that add
  // the bot later learn about it from the how-to instead.
  const NEWS = [
    { key: 'news:economy', from: ECONOMY_START, message: (guildId, date) => economyNews(guildId, date) },
    { key: 'news:road', from: ROAD_START, message: (guildId, date) => roadNews(guildId, date) },
  ];

  const money = (n) => `₽${n.toLocaleString('en-US')}`;
  const andList = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');

  // Prize money, the free bag and the PokéMart (web/economy.js), from its numbers.
  function economyNews(guildId, date) {
    const launchDay = date === ECONOMY_START;
    const startsOnMonday = new Date(`${ECONOMY_START}T12:00:00Z`).getUTCDay() === 1;
    const bag = andList(Object.entries(WEEKLY_BAG).map(([id, n]) => `${n} ${ITEMS[id].name}${n > 1 ? 's' : ''}`));
    const lines = [
      `${launchDay ? 'Starting today' : `Since ${ECONOMY_START_LABEL}`}, your daily battle pays out, and you can take items into it.`,
      '',
      '**💰 Prize money**',
      `• Win: ${money(PRIZE.win)} + ${money(PRIZE.perLeft)} for each of your Pokémon left`,
      `• Lose: ${money(PRIZE.loss)} + ${money(PRIZE.perKO)} for each of RED's Pokémon you knock out`,
      '• Run away: nothing',
      '',
      '**🎒 A free bag every Monday**',
      `${bag}.${launchDay && !startsOnMonday ? ' You get one today too, and it fills back up on Monday.' : ''}`,
      '',
      "**🏪 The PokéMart**, on today's page",
      Object.values(ITEMS).map((item) => `${item.name} ${money(item.price)}`).join(' · '),
      '',
      `**In battle**, tap **BAG**: up to ${CARRY_LIMIT} items a battle, and each one uses your turn (RED still attacks). Money and bought items reset on the 1st, with the streaks.`,
    ];
    return {
      embeds: [{
        color: GOLD,
        title: '🎒 New: prize money, the bag and the PokéMart',
        description: lines.join('\n'),
        thumbnail: thumbnailOn(date),
        footer: { text: 'Practice runs get the free bag every time, and nothing is used up.' },
      }],
      components: buttons(battleLabel(date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  // The Road to RED (web/road.js): who's coming, week by week.
  function roadNews(guildId, date) {
    const first = date === ROAD_START;
    const short = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const now = trainerOn(date);
    const weeks = [];
    let t = trainerOn(now.from);
    for (let i = 0; i < ROAD.length; i++) {
      weeks.push(`${i === 0 ? '▶️' : '•'} **${t.name}**, ${t.title} · from ${short(t.from)}${t.id === 'red' ? ' 🏔️' : ''}`);
      t = trainerOn(t.next.from);
    }
    const lines = [
      `${first ? 'Starting today' : `Since ${short(ROAD_START)}`}, every Monday brings a new trainer for the week, all at level 100, each one a little harder, building up to RED himself. Then it starts over.`,
      '',
      ...weeks,
      '',
      `This week: **${now.name}**. ${now.style}`,
      '',
      'Everyone still gets the same six each day, and every win counts the same for Pokémon Master of the Month. Your streaks carry on.',
    ];
    return {
      embeds: [{
        color: GOLD,
        title: '🏔️ New: the Road to RED',
        description: lines.join('\n'),
        thumbnail: thumbnailOn(date),
        footer: { text: `${now.name} is on today's card. A new trainer every Monday.` },
      }],
      components: buttons(battleLabel(date), guildId),
      allowed_mentions: { parse: [] },
    };
  }

  // --- Reminders ---------------------------------------------------------------------------------

  const reminderNote = `${timeLabel(reminderTime)} ${zoneLabel(recapTimeZone)}`;

  // Opted-in players in the server who haven't battled (or started) on
  // `date`, including ones who pressed the button but never played yet.
  // At most 50, so the message stays under Discord's length limit.
  function remindees(guildId, date) {
    return store.reminders(guildId).filter((id) => {
      const stats = { ...EMPTY, ...store.getPlayer(id)?.stats };
      return stats.lastPlayed !== date && stats.pending !== date;
    }).slice(0, 50);
  }

  function reminderMessage(guildId, date, ids) {
    return {
      content: `⏰ Today's Daily Red (No. ${dayNumber(date)}) is waiting for ${ids.map((id) => `<@${id}>`).join(' ')}. Beat ${trainerOn(date).name} before midnight!`,
      components: buttons(battleLabel(date), guildId),
      allowed_mentions: { users: ids }, // only the people who asked
    };
  }

  // --- Scheduled posts ----------------------------------------------------------------------------

  // Runs `fn` once per key, retrying failures every 30 minutes.
  async function once(postedKey, guildId, what, fn) {
    if (store.recapPosted(guildId, postedKey)) return;
    const failKey = `${guildId}:${postedKey}`;
    if (Date.now() - (failed.get(failKey) ?? 0) < 30 * 60 * 1000) return;
    try {
      await fn();
      store.markRecapPosted(guildId, postedKey);
      failed.delete(failKey);
    } catch (err) {
      failed.set(failKey, Date.now());
      log.warn(`Daily Red bot couldn't post the ${what} for server ${guildId}: ${err.message}`);
    }
  }

  // Runs every minute. From RECAP_TIME: yesterday's recap in every server
  // where someone finished a battle; on the 1st, last month's Pokémon Master;
  // on Mondays, the weekly leaderboard; any news; today's card. From
  // REMINDER_TIME: today's reminder.
  async function tick() {
    if (!posting) return;
    const { date: today, time, weekday } = zonedNow();
    const guilds = (await guildIds()) ?? [];
    // Once per server: how to play.
    for (const guildId of guilds) {
      await once('howto', guildId, 'how-to-play message', () => post(guildId, howToMessage(guildId)));
    }
    if (time >= recapTime) {
      const date = addDays(today, -1);
      for (const room of store.roomsWithResults(date)) {
        const guildId = room.slice(2);
        await once(date, guildId, 'recap', () => post(guildId, recapMessage(guildId, date)));
      }
      if (today.endsWith('-01')) {
        const month = date.slice(0, 7);
        for (const room of store.roomsInMonth(month)) {
          const guildId = room.slice(2);
          await once(`month:${month}`, guildId, 'Master of the Month', () => postMonth(guildId, month));
        }
      } else if (weekday === 'Mon') {
        for (const room of store.roomsSince(addDays(today, -7))) {
          const guildId = room.slice(2);
          await once(`week:${today}`, guildId, 'weekly leaderboard', () => post(guildId, weeklyMessage(guildId, today)));
        }
      }
      // Then news of anything that started today (NEWS).
      for (const news of NEWS) {
        if (today < news.from || today >= addDays(news.from, 7)) continue;
        for (const guildId of guilds) {
          await once(news.key, guildId, 'news', () => post(guildId, news.message(guildId, today)));
        }
      }
      // Then today's card, so every day starts with something to tap, below
      // the morning's other posts. (Battles after midnight may have put it up already.)
      for (const guildId of guilds) {
        await once(`card:${today}`, guildId, "today's card", async () => {
          if (store.getCard(guildId, today)) return;
          await updateCard(guildId, today);
          if (!store.getCard(guildId, today)) throw new Error('not posted');
        });
      }
    }
    // From the 25th at 6 AM to the 1st: next month's Cup sign-ups, in servers
    // with a Cup channel (cupMonth.current() opens them when it's time; the
    // post follows via cupChanged()).
    const day = Number(today.slice(8));
    if (cupMonth && (day >= 25 || day === 1)) {
      for (const guildId of guilds) {
        if (await cupChannelFor(guildId)) cupMonth.current(guildId);
      }
    }
    if (time >= reminderTime) {
      for (const guildId of store.reminderGuilds()) {
        await once(`remind:${today}`, guildId, 'reminder', async () => {
          const ids = remindees(guildId, today);
          if (ids.length) await post(guildId, reminderMessage(guildId, today, ids));
        });
      }
    }
  }

  // --- The Daily Red Cup (cup-month.mjs) -----------------------------------------------------------
  //
  // Only in servers with a #daily-red-cup channel: on the 25th at 6 AM the
  // sign-up post for next month (Join / Leave), edited into the draft
  // board; a mention for each player when it's their pick (deleted once
  // they've picked); and one for everyone when the pool is out and when the
  // teams are set.

  const cupChannels = new Map(); // guild id -> { id, until }
  async function cupChannelFor(guildId) {
    const cached = cupChannels.get(guildId);
    if (cached && cached.until > Date.now()) return cached.id;
    let id = null;
    try {
      const list = await discord('GET', `/guilds/${guildId}/channels`);
      id = list.find((c) => (c.type === 0 || c.type === 5) && c.name.toLowerCase() === cupChannelName.toLowerCase())?.id ?? null;
    } catch (err) {
      log.warn(`Daily Red bot: couldn't look for #${cupChannelName} in server ${guildId}: ${err.message}`);
    }
    cupChannels.set(guildId, { id, until: Date.now() + 10 * 60 * 1000 });
    return id;
  }

  const cupLink = (guildId) => (site ? `${site}/cup.html?g=${guildId}` : null);
  const etTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).replace(':00', '');
  const mention = (id) => `<@${id}>`;
  const speciesOf = (cup, index) => cup.draft.pool[index].set.species;

  function cupBoardMessage(cup) {
    const times = scheduleFor(cup.month);
    const firstDay = dateLabel(`${cup.month}-01`);
    const { players, draft } = cup;
    const lines = [];
    let color = CUP_GOLD;
    if (cup.stage === 'signup') {
      lines.push(
        `Sign-ups are open until **${firstDay} at ${etTime(times.signupsClose)} ET**: up to ${MAX_PLAYERS} players, at least ${MIN_PLAYERS}.`,
        `The **live draft** is that night at **${etTime(times.draft)} ET**: a pool of six random Pokémon per player (any of the 386, level 100, moves and items set), picked in turn, snake order, 90 seconds a pick. Whatever's left goes to whoever's left! Can't make it? Rank a wish list and turn on autodraft.`,
        `Then a **double-elimination bracket** all month: a round every ${ROUND_DAYS} days, one battle a match, whenever you and your opponent are both on.`,
        '',
        `**Players (${players.length} of ${MAX_PLAYERS})**`,
        players.length ? players.map((p) => mention(p.id)).join(' ') : 'Nobody yet: be the first!',
      );
    } else if (cup.stage === 'cancelled') {
      color = 0x808080;
      lines.push(`No Cup this month: ${players.length} signed up, and it needs ${MIN_PLAYERS}. Sign-ups for ${monthName(cupNextMonth(cup.month))} open on the 25th at 6 AM ET.`);
    } else if (draft) {
      const picks = (id) => draft.picks.filter((p) => p.player === id).map((p) => speciesOf(cup, p.pool));
      if (cup.stage === 'pool') lines.push(`Sign-ups are closed: **${players.length} players**. The pool is out: look it over and rank a wish list before the draft at **${etTime(times.draft)} ET**.`, '');
      if (cup.stage === 'draft') lines.push(`The draft is on: pick **${draft.picks.length + 1} of ${draft.pool.length}**.`, '');
      if (cup.stage === 'drafted') lines.push(`**The teams are set!** The bracket starts tomorrow: a round every ${ROUND_DAYS} days.`, '');
      lines.push(cup.stage === 'pool' ? '**Draft order**' : '**Teams**');
      players.forEach((p, i) => {
        const team = picks(p.id);
        const clock = cup.stage === 'draft' && cupOnClock(cup) === p.id ? ' ⏰' : '';
        lines.push(`${i + 1}. ${mention(p.id)}${clock}${team.length ? `: ${team.join(', ')}` : ''}`);
      });
    }
    const link = cupLink(cup.guildId);
    const row = [
      cup.stage === 'signup' && key && { type: 2, style: 3, label: 'Join', custom_id: CUP_JOIN },
      cup.stage === 'signup' && key && { type: 2, style: 2, label: 'Leave', custom_id: CUP_LEAVE },
      link && cup.stage !== 'cancelled' && { type: 2, style: 5, label: cup.stage === 'draft' ? 'Draft room' : 'Open the Cup', emoji: { name: '🏆' }, url: link },
    ].filter(Boolean);
    return {
      embeds: [{
        color,
        title: `🏆 Daily Red Cup · ${monthLabel(cup.month)}`,
        description: lines.join('\n'),
      }],
      components: row.length ? [{ type: 1, components: row }] : [],
      allowed_mentions: { parse: [] },
    };
  }

  // Whose pick it is, or null.
  const cupOnClock = (cup) => (cup.stage === 'draft' && cup.draft ? draftOnClock(cup.draft) : null);

  // Posts and edits, one at a time per Cup.
  const cupQueues = new Map();
  function cupChanged(cup, what) {
    if (!posting) return Promise.resolve();
    const previous = cupQueues.get(cup.id) ?? Promise.resolve();
    const next = previous.then(() => syncCup(cup, what)).catch((err) => log.warn(`Daily Red bot: the Cup post in server ${cup.guildId}: ${err.message}`));
    cupQueues.set(cup.id, next);
    return next;
  }

  async function syncCup(cup, what) {
    const channelId = await cupChannelFor(cup.guildId);
    if (!channelId) return;
    const settingKey = `cup-post:${cup.id}`;
    const saved = JSON.parse(store.getSetting(settingKey) ?? 'null') ?? { channelId };
    const keep = () => store.setSetting(settingKey, JSON.stringify(saved));
    // The board: one message, edited (posted again if it was deleted).
    const board = cupBoardMessage(cup);
    if (saved.boardId) {
      try {
        await discord('PATCH', `/channels/${saved.channelId}/messages/${saved.boardId}`, board);
      } catch (err) {
        if (err.status !== 404) throw err;
        saved.boardId = null;
      }
    }
    if (!saved.boardId) {
      saved.boardId = (await discord('POST', `/channels/${channelId}/messages`, board)).id;
      saved.channelId = channelId;
    }
    keep();
    // The mentions.
    const dropPing = async () => {
      if (!saved.pingId) return;
      await discord('DELETE', `/channels/${saved.channelId}/messages/${saved.pingId}`).catch(() => {});
      saved.pingId = null;
      saved.pingFor = null;
      keep();
    };
    const ping = async (content, ids) => {
      const link = cupLink(cup.guildId);
      const posted = await discord('POST', `/channels/${channelId}/messages`, {
        content: `${content}${link ? `\n${link}` : ''}`,
        allowed_mentions: { users: ids }, // only the Cup's players
      });
      return posted.id;
    };
    const everyone = cup.players.map((p) => p.id);
    if (what === 'closed') {
      await ping(`🏆 Sign-ups are closed! ${everyone.map(mention).join(' ')}: the pool is out. Look it over and rank your wish list before the draft tonight at ${etTime(scheduleFor(cup.month).draft)} ET.`, everyone);
    } else if (what === 'drafted') {
      await dropPing();
      await ping(`🏆 The teams are set! ${everyone.map(mention).join(' ')}: the bracket starts tomorrow, a round every ${ROUND_DAYS} days.`, everyone);
    } else if (cup.stage === 'draft') {
      // Whose pick it is (not if they're on autodraft: theirs is instant).
      const up = cupOnClock(cup);
      const pickNo = cup.draft.picks.length + 1;
      if (saved.pingFor === `${up}:${pickNo}`) return;
      await dropPing();
      if (up && !cup.autodraft?.[up]) {
        saved.pingId = await ping(`⏰ ${mention(up)}, you're up! Pick ${pickNo} of ${cup.draft.pool.length}: 90 seconds.`, [up]);
        saved.pingFor = `${up}:${pickNo}`;
        keep();
      }
    }
  }

  // The Join / Leave buttons.
  function cupButton(body, joining) {
    const reply = (content) => ({ type: 4, data: { flags: 64, content, allowed_mentions: { parse: [] } } });
    const u = body.member?.user ?? body.user;
    if (!u?.id) return reply("Couldn't tell who pressed that.");
    const user = {
      id: String(u.id),
      name: u.global_name || u.username || 'Trainer',
      avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`,
    };
    try {
      if (joining) cupMonth.join(body.guild_id, user);
      else cupMonth.leave(body.guild_id, user);
    } catch (err) {
      return reply(err.message);
    }
    const month = cupMonth.current(body.guild_id).month;
    const times = scheduleFor(month);
    const link = cupLink(body.guild_id);
    return reply(joining
      ? `🏆 You're in the ${monthName(month)} Daily Red Cup! Sign-ups close on ${dateLabel(`${month}-01`)} at ${etTime(times.signupsClose)} ET, when the pool comes out; the live draft is that night at ${etTime(times.draft)} ET.${link ? ` The draft room: ${link}` : ''}`
      : `You've left the ${monthName(month)} Cup. Changed your mind? Press Join again before sign-ups close.`);
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

  // Turns a player's reminder on or off in a server; returns the new state.
  function toggleReminder(guildId, playerId, on = !store.hasReminder(guildId, playerId)) {
    store.setReminder(guildId, playerId, on);
    return on;
  }

  const reminderReply = (on) => (on
    ? `🔔 Reminders on: you'll be mentioned in #${channelName} at ${reminderNote} on days you haven't played yet. Press Reminders again to stop.`
    : '🔕 Reminders off. Press Reminders again any time to turn them back on.');

  // The response to a (verified) interaction.
  function interaction(body) {
    if (body.type === 1) return { type: 1 }; // PING
    const id = body.data?.custom_id ?? body.data?.name;
    if (body.type === 3 && id === BOARD_BUTTON && body.guild_id) {
      const viewer = body.member?.user?.id ?? body.user?.id;
      if (body.token) replaceOldBoard(body.guild_id, body.token, viewer ? String(viewer) : null);
      return { type: 4, data: leaderboardMessage(body.guild_id, viewer ? String(viewer) : null) };
    }
    if (body.type === 3 && id === PLAY_BUTTON) {
      // Older messages' Activity button: the website now, if there is one.
      if (site && body.guild_id) {
        return { type: 4, data: { flags: 64, content: 'Daily Red plays in your browser now:', components: [{ type: 1, components: [playButton(battleLabel(zonedNow().date), body.guild_id)] }] } };
      }
      return { type: 12 }; // LAUNCH_ACTIVITY
    }
    if (body.type === 2 && id === 'dailyred-preview' && body.guild_id) return { type: 4, data: previewMessage(body.guild_id) };
    if (body.type === 3 && (id === BANNER_ON || id === BANNER_OFF) && body.guild_id) return setBanner(body, id === BANNER_ON);
    if (body.type === 3 && (id === CUP_JOIN || id === CUP_LEAVE) && body.guild_id) {
      if (!cupMonth) return { type: 4, data: { flags: 64, content: "The Cup isn't on in this server." } };
      return cupButton(body, id === CUP_JOIN);
    }
    if (body.type === 2 && id === REDO_COMMAND && body.guild_id) return redo(body);
    if (body.type === 2 && id === 'dailyred') {
      if (!body.guild_id) return { type: 4, data: { flags: 64, content: 'Daily Red is played in servers: try /dailyred in one.' } };
      return { type: 4, data: commandMessage(body.guild_id, String(body.member?.user?.id ?? body.user?.id ?? '')) };
    }
    if (body.type === 3 && id === REMIND_BUTTON && body.guild_id) {
      const userId = body.member?.user?.id ?? body.user?.id;
      if (!userId) return { type: 4, data: { flags: 64, content: "Couldn't tell who pressed that." } };
      return { type: 4, data: { flags: 64, content: reminderReply(toggleReminder(body.guild_id, String(userId))) } };
    }
    if (body.type === 2) return { type: 12 }; // the Activity's own launch command
    return { type: 4, data: { flags: 64, content: "That button doesn't do anything any more." } };
  }

  // --- Start / stop ---------------------------------------------------------------------------

  // Discord wants a bot to log in to the Gateway once before its first message.
  async function identifyOnce() {
    if (store.getSetting('gateway_identified') || typeof WebSocket !== 'function') return;
    await new Promise((resolve) => {
      const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
      let finished = false;
      const done = (problem) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (problem && !store.getSetting('gateway_identified')) log.warn(`Daily Red bot couldn't log in to Discord's Gateway (${problem}); it will try again on the next start.`);
        try { ws.close(); } catch { /* already closed */ }
        resolve();
      };
      const timeout = setTimeout(() => done('no answer in 15 s'), 15000);
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.op === 10) {
          ws.send(JSON.stringify({ op: 2, d: { token, intents: 0, properties: { os: 'linux', browser: 'dailyred', device: 'dailyred' } } }));
        } else if (msg.t === 'READY') {
          store.setSetting('gateway_identified', '1');
          log.log(`Daily Red bot logged in as ${msg.d.user.username}.`);
          done();
        } else if (msg.op === 9) {
          done('Discord rejected the bot token, DISCORD_BOT_TOKEN');
        }
      });
      ws.addEventListener('error', () => done('connection error'));
      ws.addEventListener('close', (event) => done(`closed, code ${event.code}`));
    });
  }

  return {
    updateCard,
    postResult,
    cupChanged,
    ensureCard,
    refreshBoard,
    tick,
    leaderboard,
    hallOfFame,
    crownedOn,
    toggleReminder,
    reminderNote,
    verifyRequest,
    interaction,
    cardMessage,
    recapMessage,
    monthMessage,
    weeklyMessage,
    howToMessage,
    commandMessage,
    previewMessage,
    get canVerify() { return Boolean(key); },
    // For GET /api/interactions: what's set up (never the secrets themselves).
    status: () => ({
      publicKey: keyStatus,
      posting,
      channel: `#${channelName}`,
      recap: `${recapTime} ${recapTimeZone}`,
      reminders: `${reminderTime} ${recapTimeZone}`,
    }),
    // How many servers the bot has been added to (null if it can't tell).
    async servers() {
      return (await guildIds())?.length ?? null;
    },
    guildIds,
    get loggedIn() { return Boolean(store.getSetting('gateway_identified')); },
    async start() {
      if (!posting) return;
      await identifyOnce().catch((err) => log.warn(`Daily Red bot login failed: ${err.message}`));
      if (key) await registerCommand().catch((err) => log.warn(`Daily Red bot couldn't add /dailyred: ${err.message}`));
      setImmediate(() => teamLine(zonedNow().date)); // load the battle data now, not on the first card
      timer = setInterval(() => tick().catch((err) => log.warn(err)), 60 * 1000);
      timer.unref?.();
      tick().catch((err) => log.warn(err));
    },
    stop() { clearInterval(timer); },
  };
}
