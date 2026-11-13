// Daily Red with Discord. As an Activity, Discord opens the page inside its
// app with launch parameters in the URL (frame_id, instance_id, guild_id,
// ...), and this module signs the player in with the Embedded App SDK. On the
// website, players can sign in with Discord too (connectWeb: the server's
// /auth/login, then a cookie). Either way their stats are kept on the server
// (activity/server.mjs) instead of in this browser, and the page lists who
// in the server has played today.

import { today } from './daily.js';

export const inDiscord = new URLSearchParams(location.search).has('frame_id');

// The OAuth2 scopes the activity asks for: who you are, and your status line.
const SCOPES = ['identify', 'rpc.activities.write'];
const CONNECT_TIMEOUT_MS = 20000;

// Resolves to the Discord session, or throws if signing in fails (the site
// then falls back to stats in this browser).
export async function connectDiscord() {
  const [{ DiscordSDK }, config] = await Promise.all([
    import('./vendor/discord-sdk.js'),
    request('GET', 'api/config'),
  ]);
  if (!config.clientId) throw new Error('The activity server has no DISCORD_CLIENT_ID.');
  const sdk = new DiscordSDK(config.clientId);
  // Only ready() gets a time limit: the consent dialog below waits for the player.
  await withTimeout(sdk.ready(), CONNECT_TIMEOUT_MS, "Discord didn't respond.");

  // Shows Discord's consent dialog the first time, then signs in silently.
  const { code } = await sdk.commands.authorize({
    client_id: config.clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: SCOPES,
  });
  const { access_token: token } = await request('POST', 'api/token', { code });
  await sdk.commands.authenticate({ access_token: token });

  // A server, or the DM / group DM the activity was started in.
  const room = sdk.guildId ? `g:${sdk.guildId}` : sdk.channelId ? `c:${sdk.channelId}` : null;
  const call = (method, path, body) => request(method, path, body, token);
  let lastPresence = '';

  return session({
    call,
    room,
    inServer: Boolean(sdk.guildId),

    // The two lines under "Playing Daily Red" in Discord.
    setPresence(details, state) {
      const key = `${details}\n${state}`;
      if (key === lastPresence) return;
      lastPresence = key;
      sdk.commands.setActivity({ activity: { type: 0, details, state } })
        .catch((err) => console.warn('setActivity failed', err));
    },

    // Links can't open inside the activity frame; Discord opens them in the
    // browser after asking the player.
    openLink: (url) => sdk.commands.openExternalLink({ url }).catch(() => {}),

    // Puts the result picture on Discord's CDN (through our server, with the
    // player's token), then opens Discord's "share" dialog with it.
    async shareImage(blob) {
      const response = await fetch('api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` },
        body: blob,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await sdk.commands.openShareMomentDialog({ mediaUrl: data.url });
    },
  });
}

// --- The website with "Sign in with Discord" --------------------------------------

// { available, user, rooms } from the server: whether the website can sign in
// (the server has PUBLIC_URL), and who is signed in (a cookie).
export const webSession = () => request('GET', 'api/web/session');

// The signed-in website player's session, playing for `room` (one of
// web.rooms, or null if Daily Red isn't in any of their servers).
export function connectWeb(web, room) {
  return session({
    call: (method, path, body) => request(method, path, body),
    room,
    inServer: Boolean(room),
    rooms: web.rooms,
    setPresence() {}, // only inside Discord
    openLink: (url) => window.open(url, '_blank', 'noopener'),
  });
}

// What both kinds of session share: stats and the wallet kept on the server,
// results reported to it, and the server's board.
async function session({ call, room, ...rest }) {
  const date = today();
  const { user, stats: serverStats, wallet: serverWallet } = await call('GET', `api/me?settle=1&date=${date}${room ? `&room=${room}` : ''}`);
  let cached = serverStats;
  let wallet = serverWallet ?? null;
  let reports = Promise.resolve();
  return {
    user,
    room,
    ...rest,

    // For daily.js (useStatsStorage): the stats live on the server, this is
    // just the copy the page works with. Nothing goes in localStorage, which
    // other Discord accounts on this device would share.
    storage: {
      read: () => cached,
      write: (stats) => { cached = { ...stats }; },
    },

    // Fetches the stats again (another device may have played meanwhile).
    async refreshStats() {
      await reports;
      const data = await call('GET', `api/me?date=${today()}`);
      cached = data.stats;
      wallet = data.wallet ?? wallet;
    },

    // Money and items (economy.js), kept and checked by the server. get() is
    // the last copy it sent (walletFor() brings it up to a date).
    wallet: {
      get: () => wallet,
      async buy(item, quantity, day) {
        ({ wallet } = await call('POST', 'api/shop', { date: day, item, quantity }));
        return wallet;
      },
      // Only while today's battle is on: after its 'start' has reached the server.
      async use(item, day) {
        await reports;
        ({ wallet } = await call('POST', 'api/bag/use', { date: day, item }));
        return wallet;
      },
    },

    // Sends 'start' / 'result' to the server, in order. Each one is retried
    // for a while: if a result never arrived, the server would count the
    // battle as abandoned (a loss) next time.
    // For a result, `details` is { monsLeft, redLeft, turns, gaveUp } for the board and the bot.
    // Resolves to the server's answer ({ stats, wallet, prize }), or undefined if it never got there.
    report(event, day, won, details = {}) {
      const body = { event, date: day, room, ...(event === 'result' && { won, ...details }) };
      const sent = reports.then(() => retry(() => call('POST', 'api/battle', body)))
        .then((data) => {
          cached = data.stats;
          wallet = data.wallet ?? wallet;
          return data;
        })
        .catch((err) => console.error(`Couldn't save the ${event} of today's battle`, err));
      reports = sent.then(() => {});
      return sent;
    },

    board: (day) => room ? call('GET', `api/board?room=${room}&date=${day}`) : Promise.resolve({ players: [] }),

    // The bot's daily reminder for this server (the same as its 🔔 button).
    setReminder: (on) => call('POST', 'api/reminder', { room, on }),
  };
}

// --- "Today in this server" ---------------------------------------------------

const TODAY_LABEL = { won: 'Beat RED', lost: 'Lost to RED', battling: 'Battling RED' };
const squares = (left) => (left == null ? '' : '🟥'.repeat(left) + '⬛'.repeat(Math.max(0, 6 - left)));

// The board's three tabs: who played today, streaks, and all-time records.
const TABS = {
  today: {
    sort: null, // the server's order: today's results first
    detail(p) {
      const r = p.result;
      if (!r) return `${p.wins}W ${p.losses}L · ${p.winStreak} win streak`;
      if (r.gaveUp) return [`Ran on turn ${r.turns || 1}`, `🔥 ${p.winStreak}`].join(' · ');
      const how = r.won
        ? `${r.monsLeft != null ? `${r.monsLeft} left` : 'Won'}`
        : `${r.redLeft != null ? `RED had ${r.redLeft} left` : 'Lost'}`;
      return [how, r.turns ? `${r.turns} turns` : null, `🔥 ${p.winStreak}`].filter(Boolean).join(' · ');
    },
    badge: (p) => (p.result?.gaveUp ? 'Ran from RED' : TODAY_LABEL[p.today] ?? 'Not yet'),
    squares: (p) => squares(p.result?.monsLeft),
  },
  month: {
    // The Pokémon Master of the Month race: most wins, then fewer losses,
    // more Pokémon left, fewer turns (the same order as the bot's).
    sort: (a, b) => b.monthWins - a.monthWins || a.monthLosses - b.monthLosses
      || b.monthLeft - a.monthLeft || a.monthTurns - b.monthTurns,
    filter: (p) => p.monthWins + p.monthLosses > 0,
    detail: (p) => `🔥 ${p.winStreak} win streak · ${p.monthWins + p.monthLosses} played this month`,
    badge: (p) => `🏆 ${p.monthWins}W ${p.monthLosses}L`,
    squares: () => '',
  },
  streaks: {
    sort: (a, b) => b.winStreak - a.winStreak || b.bestWinStreak - a.bestWinStreak || b.wins - a.wins,
    detail: (p) => `Best ${p.bestWinStreak} · ${p.dayStreak ? `${p.dayStreak}-day play streak` : 'No play streak'}`,
    badge: (p) => `🔥 ${p.winStreak}`,
    squares: () => '',
  },
  alltime: {
    sort: (a, b) => b.wins - a.wins || b.winRate - a.winRate || a.losses - b.losses,
    detail: (p) => `${p.played} played · best streak ${p.bestWinStreak}`,
    badge: (p) => `${p.wins}W ${p.losses}L · ${p.winRate}%`,
    squares: () => '',
  },
};

// players: from GET /api/board. Names come from Discord, so they only ever
// go in as text.
export function renderBoard(list, players, tab = 'today') {
  const view = TABS[tab] ?? TABS.today;
  const shown = view.sort ? players.filter(view.filter ?? ((p) => p.played > 0)).sort(view.sort) : players;
  list.dataset.tab = tab;
  list.replaceChildren(...shown.map((p, i) => {
    const row = document.createElement('li');
    row.className = 'board-row';
    row.dataset.today = tab === 'today' ? p.today ?? 'none' : 'rank';
    if (p.you) row.classList.add('is-you');

    const avatar = document.createElement('img');
    avatar.className = 'board-avatar';
    avatar.src = p.avatarUrl;
    avatar.alt = '';
    avatar.width = avatar.height = 32;
    avatar.loading = 'lazy';
    avatar.referrerPolicy = 'no-referrer';

    const name = document.createElement('span');
    name.className = 'board-name';
    name.textContent = `${tab === 'today' ? '' : `${i + 1}. `}${p.you ? `${p.name} (you)` : p.name}`;
    if (p.master) {
      // Last month's Pokémon Master.
      const crown = document.createElement('span');
      crown.className = 'board-crown';
      crown.textContent = ' 👑';
      crown.title = "Last month's Pokémon Master";
      name.append(crown);
    }

    const today = document.createElement('span');
    today.className = 'board-today';
    today.textContent = view.badge(p);

    const streak = document.createElement('span');
    streak.className = 'board-streak';
    streak.textContent = view.detail(p);

    const grid = document.createElement('span');
    grid.className = 'board-squares';
    grid.textContent = view.squares(p);

    row.append(avatar, name, today, streak, grid);
    return row;
  }));
}

// Where you stand in the month's Master race, for the result screen: e.g.
// "You're 2nd in the November race, 1 win behind Ash." `players` from GET
// /api/board, `month` the month's name.
export function standingText(players, month) {
  const race = players.filter(TABS.month.filter).sort(TABS.month.sort);
  const i = race.findIndex((p) => p.you);
  if (i < 0) return '';
  const me = race[i];
  const leader = race[0];
  const wins = (n) => `${n} ${n === 1 ? 'win' : 'wins'}`;
  const place = (n) => `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? 'th'}`;
  if (race.length === 1) return `You're the only one in the ${month} race so far, with ${wins(me.monthWins)}.`;
  if (leader.monthWins === 0) return `Nobody has beaten RED yet in ${month}. The first win takes the lead!`;
  if (i === 0) {
    const gap = me.monthWins - race[1].monthWins;
    return gap > 0
      ? `You lead the ${month} race with ${wins(me.monthWins)}, ${wins(gap)} ahead of ${race[1].name}.`
      : `You lead the ${month} race on tiebreaks, level with ${race[1].name} on ${wins(me.monthWins)}.`;
  }
  const gap = leader.monthWins - me.monthWins;
  return gap > 0
    ? `You're ${place(i + 1)} in the ${month} race, ${wins(gap)} behind ${leader.name}.`
    : `You're ${place(i + 1)} in the ${month} race, level with ${leader.name} on ${wins(me.monthWins)} but behind on tiebreaks.`;
}

// The Hall of Fame: hallOfFame from GET /api/board, newest month first.
export function renderHallOfFame(list, hallOfFame) {
  list.replaceChildren(...hallOfFame.map(({ month, masters }) => {
    const row = document.createElement('li');
    row.className = 'hall-row';
    const label = document.createElement('span');
    label.className = 'hall-month';
    label.textContent = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const names = document.createElement('span');
    names.className = 'hall-names';
    names.textContent = `👑 ${masters.map((m) => m.name).join(' & ')}`;
    const record = document.createElement('span');
    record.className = 'hall-record';
    record.textContent = `${masters[0].wins} ${masters[0].wins === 1 ? 'win' : 'wins'}`;
    row.append(label, names, record);
    return row;
  }));
}

// --- Helpers ---------------------------------------------------------------------

async function request(method, path, body, token) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
      // The website's session cookie only counts with this (no CSRF).
      'X-Daily-Red': '1',
    },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  }
  return data;
}

// Network hiccups get a few more tries; a 4xx answer won't change by retrying.
async function retry(fn, delays = [1000, 3000, 10000, 30000]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length || (err.status >= 400 && err.status < 500)) throw err;
      await new Promise((ok) => setTimeout(ok, delays[attempt]));
    }
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
