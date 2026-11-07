// Daily Red as a Discord Activity. Discord opens the page inside its app with
// launch parameters in the URL (frame_id, instance_id, guild_id, ...). Then
// this module signs the player in with their Discord account, keeps their
// stats on the activity server (activity/server.mjs) instead of in this
// browser, lists who in the server has played today, and sets the player's
// Discord status. Opened any other way, the page doesn't load any of it.

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

  const { user, stats: serverStats } = await call('GET', `api/me?settle=1${room ? `&room=${room}` : ''}`);
  let cached = serverStats;
  let reports = Promise.resolve();
  let lastPresence = '';

  return {
    user,
    room,
    inServer: Boolean(sdk.guildId),

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
      cached = (await call('GET', 'api/me')).stats;
    },

    // Sends 'start' / 'result' to the server, in order. Each one is retried
    // for a while: if a result never arrived, the server would count the
    // battle as abandoned (a loss) next time.
    report(event, date, won) {
      const body = { event, date, room, ...(event === 'result' && { won }) };
      reports = reports.then(() => retry(() => call('POST', 'api/battle', body)))
        .then(({ stats }) => { cached = stats; })
        .catch((err) => console.error(`Couldn't save the ${event} of today's battle`, err));
      return reports;
    },

    board: (date) => room ? call('GET', `api/board?room=${room}&date=${date}`) : Promise.resolve({ players: [] }),

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
  };
}

// --- "Today in this server" ---------------------------------------------------

const TODAY_LABEL = { won: 'Beat RED', lost: 'Lost to RED', battling: 'Battling RED' };

// players: from GET /api/board. Names come from Discord, so they only ever
// go in as text.
export function renderBoard(list, players) {
  list.replaceChildren(...players.map((p) => {
    const row = document.createElement('li');
    row.className = 'board-row';
    row.dataset.today = p.today ?? 'none';
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
    name.textContent = p.you ? `${p.name} (you)` : p.name;

    const today = document.createElement('span');
    today.className = 'board-today';
    today.textContent = TODAY_LABEL[p.today] ?? 'Not yet';

    const streak = document.createElement('span');
    streak.className = 'board-streak';
    streak.textContent = `${p.wins}W ${p.losses}L · ${p.winStreak} win streak`;

    row.append(avatar, name, today, streak);
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
