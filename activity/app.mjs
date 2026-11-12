// The activity server's request handler: serves web/ and a small JSON API
// for the Discord Activity (see web/discord.js for the other side).
//
//   GET  /api/config   { clientId }                    (no sign-in needed)
//   POST /api/token    { code } -> { access_token }    OAuth2 code exchange
//   GET  /api/me       ?room=&settle=1 -> { user, stats }
//   POST /api/battle   { event: 'start' | 'result', date, won, room } -> { stats }
//   GET  /api/board    ?room=&date= -> { players: [...] }
//
// Every /api call except config and token needs "Authorization: Bearer
// <Discord access token>"; the token is checked against Discord's API and
// tells us who the player is. Stats follow the same rules as the website
// (web/daily.js), applied here so a player's record is the same on every
// device they play on.
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  EMPTY, addDays, currentStreaks, markBattleStarted, recordResult, resultFor, settleAbandonedGame,
  useStatsStorage,
} from '../web/daily.js';

// daily.js saves through this; the server saves players itself.
useStatsStorage({ read: () => null, write: () => {} });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
// Worth gzipping on the way out (the battle engine shrinks from 7 MB to about
// 1.2 MB, which matters on a home uplink). Each file is compressed once.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM = /^[gc]:\d{1,20}$/; // g:<server id> or c:<channel id> (DMs)
const TOKEN_CACHE_MS = 10 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({
  webRoot,
  store,
  clientId,
  clientSecret,
  discordApi = 'https://discord.com/api/v10',
  fetch = globalThis.fetch,
  now = () => new Date(),
  bot = null, // bot.mjs: the live card, recaps and button presses (optional)
}) {
  const root = resolve(webRoot);
  const gzipCache = new Map(); // path -> { mtimeMs, body }
  const tokenCache = new Map(); // access token -> { user, expires }

  // --- Static files ------------------------------------------------------------

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    let path = normalize(join(root, decoded));
    if (path !== root && !path.startsWith(root + sep)) throw new HttpError(403, 'Forbidden');
    if (relative(root, path).split(sep).some((part) => part.startsWith('.'))) throw new HttpError(404, 'Not found');
    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      path = join(path, 'index.html');
      info = await stat(path).catch(() => null);
    }
    if (!info?.isFile()) throw new HttpError(404, 'Not found');

    const ext = extname(path);
    const etag = `W/"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // Discord's proxy and browsers keep files; revalidating each time means
      // a rebuilt image shows up straight away (unchanged files get a 304).
      'Cache-Control': 'no-cache',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    };
    if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      let cached = gzipCache.get(path);
      if (!cached || cached.mtimeMs !== info.mtimeMs) {
        cached = { mtimeMs: info.mtimeMs, body: gzipSync(await readFile(path), { level: 9 }) };
        gzipCache.set(path, cached);
      }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': cached.body.length });
      res.end(req.method === 'HEAD' ? undefined : cached.body);
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(path).on('error', () => res.destroy()).pipe(res);
  }

  // --- Discord ------------------------------------------------------------------

  async function discordJson(path, init) {
    const response = await fetch(`${discordApi}${path}`, init);
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  }

  async function exchangeCode(code) {
    if (!clientId || !clientSecret) {
      throw new HttpError(500, 'The server is missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET.');
    }
    if (typeof code !== 'string' || !code || code.length > 200) throw new HttpError(400, 'Missing code');
    const { ok, status, body } = await discordJson('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
      }),
    });
    if (!ok || !body.access_token) {
      console.warn(`Discord token exchange failed (HTTP ${status}): ${body.error || ''} ${body.error_description || ''}`);
      // Discord's error code says what to fix (it never contains the secret):
      // invalid_client = wrong DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET.
      const hint = body.error === 'invalid_client' ? ': check DISCORD_CLIENT_SECRET on the server' : '';
      throw new HttpError(401, `Discord sign-in failed (${body.error || `HTTP ${status}`}${hint})`);
    }
    return { access_token: body.access_token, expires_in: body.expires_in, scope: body.scope };
  }

  // The signed-in Discord user, from the request's access token.
  async function requireUser(req) {
    const token = /^Bearer (\S{1,512})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) throw new HttpError(401, 'Not signed in');
    const cached = tokenCache.get(token);
    if (cached && cached.expires > Date.now()) return cached.user;

    const { ok, status, body } = await discordJson('/users/@me', { headers: { Authorization: `Bearer ${token}` } });
    if (!ok) throw new HttpError(status === 401 ? 401 : 502, 'Discord sign-in expired');
    const user = { id: String(body.id), name: body.global_name || body.username || 'Trainer', avatarUrl: avatarUrl(body) };
    if (tokenCache.size > 5000) tokenCache.clear();
    tokenCache.set(token, { user, expires: Date.now() + TOKEN_CACHE_MS });
    return user;
  }

  // --- Players ----------------------------------------------------------------

  // The player's saved row with their current Discord name and avatar.
  function loadPlayer(user) {
    const saved = store.getPlayer(user.id);
    return { ...user, stats: { ...EMPTY, ...saved?.stats } };
  }

  // Dates come from the player's own time zone, so they're within a day of
  // the server's UTC date. Anything else is a broken (or edited) client.
  function checkDate(date) {
    const utc = now().toISOString().slice(0, 10);
    if (typeof date !== 'string' || !DATE.test(date) || date < addDays(utc, -1) || date > addDays(utc, 1)) {
      throw new HttpError(400, 'Bad date');
    }
    return date;
  }

  function checkRoom(room, { required = false } = {}) {
    if (room == null || room === '') {
      if (required) throw new HttpError(400, 'Missing room');
      return null;
    }
    if (typeof room !== 'string' || !ROOM.test(room)) throw new HttpError(400, 'Bad room');
    return room;
  }

  // GET /api/me. settle=1 when the activity starts: a battle that started but
  // never finished is a loss, exactly like reloading the website mid-battle.
  // settleAbandonedGame(), also saving the loss as that day's result.
  function settle(player) {
    const { pending } = player.stats;
    settleAbandonedGame(player.stats);
    if (pending && player.stats.lastPlayed === pending && player.stats.lastResult === 'lost') {
      store.saveResult({ playerId: player.id, date: pending, won: false });
    }
  }

  function me(user, query) {
    const player = loadPlayer(user);
    if (query.get('settle') === '1') settle(player);
    store.savePlayer(player);
    const room = checkRoom(query.get('room'));
    if (room) store.joinRoom(room, user.id);
    // Opening the Activity in a server puts up today's card if it's missing.
    if (bot && room?.startsWith('g:') && query.get('date')) {
      try {
        bot.ensureCard(room.slice(2), checkDate(query.get('date')));
      } catch {
        // a bad date from the page shouldn't stop it signing in
      }
    }
    return { user, stats: player.stats };
  }

  function battle(user, body) {
    const date = checkDate(body.date);
    const room = checkRoom(body.room);
    const player = loadPlayer(user);
    const { stats } = player;
    if (stats.lastPlayed && date < stats.lastPlayed) throw new HttpError(409, 'A later day is already recorded');
    // A battle left unfinished on an earlier day (another device, a crash)
    // is a loss before today's counts.
    if (stats.pending && stats.pending < date && stats.pending !== stats.lastPlayed) {
      store.saveResult({ playerId: user.id, date: stats.pending, won: false });
      recordResult(stats, stats.pending, false);
    }

    if (body.event === 'start') {
      markBattleStarted(stats, date);
    } else if (body.event === 'result') {
      if (typeof body.won !== 'boolean') throw new HttpError(400, 'Missing won');
      // How it went, for the board and the bot (older pages don't send these).
      const count = (value, max) => (Number.isInteger(value) && value >= 0 && value <= max ? value : null);
      if (!resultFor(stats, date)) {
        store.saveResult({
          playerId: user.id, date, won: body.won,
          monsLeft: count(body.monsLeft, 6), redLeft: count(body.redLeft, 6), turns: count(body.turns, 1000),
        });
      }
      recordResult(stats, date, body.won); // ignored if the day already has a result
    } else {
      throw new HttpError(400, 'Unknown event');
    }
    store.savePlayer(player);
    if (room) store.joinRoom(room, user.id);
    if (bot && room?.startsWith('g:')) bot.updateCard(room.slice(2), date);
    return { stats };
  }

  function board(user, query) {
    const room = checkRoom(query.get('room'), { required: true });
    const date = checkDate(query.get('date'));
    const results = store.roomResults(room, date);
    const month = store.monthTotals(room, date.slice(0, 7)); // the Master of the Month race
    const players = store.roomPlayers(room).map(({ id, name, avatarUrl, stats }) => {
      const full = { ...EMPTY, ...stats };
      const result = resultFor(full, date);
      const today = result || (full.pending === date ? 'battling' : null);
      const played = full.wins + full.losses;
      return {
        id, name, avatarUrl, today, wins: full.wins, losses: full.losses, ...currentStreaks(full, date),
        bestWinStreak: Math.max(full.bestWinStreak || 0, full.winStreak),
        played, winRate: played ? Math.round((full.wins / played) * 100) : 0,
        result: result ? results.get(id) ?? { won: result === 'won' } : null,
        monthWins: month.get(id)?.wins ?? 0, monthLosses: month.get(id)?.losses ?? 0,
        monthLeft: month.get(id)?.monsLeft ?? 0, monthTurns: month.get(id)?.turns ?? 0,
        you: id === user.id,
      };
    });
    const order = { won: 0, lost: 1, battling: 2 };
    players.sort((a, b) => (order[a.today] ?? 3) - (order[b.today] ?? 3)
      || b.winStreak - a.winStreak || b.dayStreak - a.dayStreak || b.wins - a.wins || a.name.localeCompare(b.name));
    return { date, players };
  }

  // --- Routing ------------------------------------------------------------------

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    let result;
    if (route === 'GET /api/config') {
      result = { clientId: clientId || null };
    } else if (route === 'POST /api/token') {
      result = await exchangeCode((await readJson(req)).code);
    } else if (route === 'GET /api/me') {
      result = me(await requireUser(req), url.searchParams);
    } else if (route === 'POST /api/battle') {
      const user = await requireUser(req);
      result = battle(user, await readJson(req));
    } else if (route === 'GET /api/board') {
      result = board(await requireUser(req), url.searchParams);
    } else if (route === 'GET /api/interactions') {
      // Open this in a browser to check the bot's setup (no secrets shown).
      const status = bot?.status() ?? { publicKey: 'missing', posting: false };
      const servers = bot ? await bot.servers() : null;
      result = {
        ...status,
        servers,
        loggedIn: bot?.loggedIn ?? false,
        invite: servers === 0 ? 'The bot isn\'t in any server yet: open the invite link from the container log.' : undefined,
        buttons: status.publicKey === 'ok'
          ? 'Ready: Discord can verify this address (Developer Portal > Interactions Endpoint URL).'
          : status.publicKey === 'invalid'
            ? 'DISCORD_PUBLIC_KEY is set but isn\'t a valid key: copy it again from General Information > Public Key.'
            : 'DISCORD_PUBLIC_KEY isn\'t reaching the server: add it to the environment (and to the compose file\'s environment: list), then Up.',
        bot: status.posting ? 'On: posts the live card and recaps.' : 'Off: DISCORD_BOT_TOKEN isn\'t set.',
      };
    } else if (route === 'POST /api/interactions') {
      // Discord's button presses (bot.mjs), signed with the app's key.
      if (!bot?.canVerify) throw new HttpError(404, 'Not found');
      const raw = await readBody(req, 64 * 1024);
      if (!bot.verifyRequest(req.headers, raw)) throw new HttpError(401, 'Bad signature');
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Expected JSON');
      }
      result = bot.interaction(body);
    } else {
      throw new HttpError(404, 'Not found');
    }
    sendJson(res, 200, result);
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      // Inside Discord, requests can arrive with the proxy's /.proxy prefix.
      if (url.pathname.startsWith('/.proxy/')) url.pathname = url.pathname.slice('/.proxy'.length);
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('ok');
      } else if (url.pathname.startsWith('/api/')) {
        await api(req, res, url);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) {
        res.destroy();
      } else if (req.url.includes('/api/')) {
        sendJson(res, status, { error: status === 500 && !(err instanceof HttpError) ? 'Server error' : err.message });
      } else {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(status === 404 ? 'Not found' : err.message);
      }
    }
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 16 * 1024) {
  const raw = await readBody(req, limit);
  try {
    const body = JSON.parse(raw.toString('utf8') || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* fall through */ }
  throw new HttpError(400, 'Expected a JSON object');
}

// Avatars load straight from Discord's CDN, which activities are allowed to use.
export function avatarUrl({ id, avatar }) {
  if (avatar) return `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=64`;
  const index = Number((BigInt(id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
