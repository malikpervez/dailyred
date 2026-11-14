// The activity server's request handler: serves web/ and a small JSON API
// for the Discord Activity (see web/discord.js for the other side).
//
//   GET  /api/config   { clientId }                    (no sign-in needed)
//   POST /api/token    { code } -> { access_token }    OAuth2 code exchange
//   GET  /api/me       ?room=&settle=1&date= -> { user, stats, wallet }
//   POST /api/battle   { event: 'start' | 'result', date, won, room } -> { stats, wallet, prize }
//   POST /api/shop     { date, item, quantity } -> { wallet }    the PokéMart
//   POST /api/bag/use  { date, item } -> { wallet }              an item in today's battle
//   GET  /api/board    ?room=&date= -> { players, hallOfFame, reminders }
//   POST /api/reminder { room, on } -> { on, time }     the bot's daily reminder
//   POST /api/share    PNG image -> { url }             for Discord's share dialog
//   GET  /api/web/session -> { available, user, rooms }  the website's sign-in
//
// The website (outside Discord) can sign in too, for friends who can't open
// the Activity (it's only for App Testers until Discord verifies it):
//
//   GET /auth/login?g=<server id>  -> Discord's "Authorize" page
//   GET /auth/callback             <- Discord sends the player back here,
//                                     which must be the app's OAuth2 redirect
//   GET /auth/logout
//
//   GET /card/<date>.png           today's six facing RED, for the bot's card (card-image.mjs)
//
// Every /api call except config, token and web/session needs "Authorization:
// Bearer <Discord access token>" (the Activity) or the website's session
// cookie. A token is checked against Discord's API and tells us who the
// player is; the cookie is signed with a key made from the client secret. Stats follow the same rules as the website
// (web/daily.js), applied here so a player's record is the same on every
// device they play on.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  EMPTY, addDays, currentStreaks, markBattleStarted, recordResult, resultFor, settleAbandonedGame,
  useStatsStorage,
} from '../web/daily.js';
import { previousMonth } from './bot.mjs';
import { dayNumber } from '../web/daily.js';
import { walletFor, earn, buy, useItem, usedIn, economyOpen, EconomyError, ECONOMY_START_LABEL } from '../web/economy.js';

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
const MAX_SHARE_BYTES = 2 * 1024 * 1024;
const SESSION_DAYS = 30; // renewed on each visit, so only a month without playing signs you out
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'dailyred_session';
const STATE_COOKIE = 'dailyred_signin';
const MAX_ROOMS = 10; // servers remembered in a website session
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  publicUrl = null, // https://... this site's public address: turns on the website's sign-in
  cardPicture = null, // date -> PNG of the day's six facing RED (card-image.mjs), for the bot's card
}) {
  const pictures = new Map(); // date -> PNG, the last few days
  const site = publicUrl ? String(publicUrl).replace(/\/$/, '') : null;
  const redirectUri = site ? `${site}/auth/callback` : null;
  const webSignIn = Boolean(redirectUri && clientId && clientSecret);
  const sessionKey = clientSecret ? createHmac('sha256', 'dailyred-web-session').update(clientSecret).digest() : null;
  const root = resolve(webRoot);
  const gzipCache = new Map(); // path -> { mtimeMs, body }
  const tokenCache = new Map(); // access token -> { user, expires }
  const lastShare = new Map(); // user id -> time of their last image upload

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

  async function exchangeCode(code, redirect = null) {
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
        ...(redirect && { redirect_uri: redirect }),
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
  const bearer = (req) => /^Bearer (\S{1,512})$/.exec(req.headers.authorization || '')?.[1];

  async function requireUser(req) {
    const token = bearer(req);
    if (!token) {
      // The website: the session cookie. Changes need our own header too,
      // which another site's page can't send (no CSRF).
      const user = webUser(req);
      if (!user) throw new HttpError(401, 'Not signed in');
      if (req.method !== 'GET' && req.headers['x-daily-red'] !== '1') throw new HttpError(403, 'Missing X-Daily-Red header');
      return user;
    }
    const cached = tokenCache.get(token);
    if (cached && cached.expires > Date.now()) return cached.user;

    const { ok, status, body } = await discordJson('/users/@me', { headers: { Authorization: `Bearer ${token}` } });
    if (!ok) throw new HttpError(status === 401 ? 401 : 502, 'Discord sign-in expired');
    const user = { id: String(body.id), name: body.global_name || body.username || 'Trainer', avatarUrl: avatarUrl(body) };
    if (tokenCache.size > 5000) tokenCache.clear();
    tokenCache.set(token, { user, expires: Date.now() + TOKEN_CACHE_MS });
    return user;
  }

  // --- The website's sign-in -------------------------------------------------------

  function seal(value) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${createHmac('sha256', sessionKey).update(body).digest('base64url')}`;
  }

  function unseal(text) {
    if (!sessionKey || typeof text !== 'string') return null;
    const [body, mac] = text.split('.');
    if (!body || !mac) return null;
    const want = createHmac('sha256', sessionKey).update(body).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return value.exp > now().getTime() ? value : null;
    } catch {
      return null;
    }
  }

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${site?.startsWith('https:') ? '; Secure' : ''}`;

  const readSession = (req) => unseal(cookies(req)[SESSION_COOKIE]);
  const sessionCookie = (session) => cookie(SESSION_COOKIE, seal({ ...session, exp: now().getTime() + SESSION_DAYS * DAY_MS }), SESSION_DAYS * 86400);

  // The website's signed-in player: { id, name, avatarUrl, rooms, web: true }.
  function webUser(req) {
    const session = readSession(req);
    return session ? { id: session.id, name: session.name, avatarUrl: session.avatarUrl, rooms: session.rooms, web: true } : null;
  }

  function redirect(res, location, setCookies = []) {
    res.writeHead(302, { Location: location, 'Set-Cookie': setCookies, 'Cache-Control': 'no-store' });
    res.end();
  }

  // GET /auth/login?g=<server id>: off to Discord's "Authorize" page.
  function login(req, res, url) {
    if (!webSignIn) throw new HttpError(404, 'Website sign-in is off (PUBLIC_URL is not set)');
    const guild = /^\d{1,20}$/.test(url.searchParams.get('g') || '') ? url.searchParams.get('g') : null;
    const state = randomBytes(16).toString('base64url');
    const authorize = new URL('https://discord.com/oauth2/authorize');
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: clientId, scope: 'identify guilds', state, redirect_uri: redirectUri, prompt: 'none',
    })) authorize.searchParams.set(k, v);
    redirect(res, authorize.href, [cookie(STATE_COOKIE, seal({ state, guild, exp: now().getTime() + 10 * 60 * 1000 }), 600)]);
  }

  // GET /auth/callback: Discord sends the player back with a code.
  async function callback(req, res, url) {
    if (!webSignIn) throw new HttpError(404, 'Website sign-in is off');
    const pending = unseal(cookies(req)[STATE_COOKIE]);
    const clear = cookie(STATE_COOKIE, '', 0);
    const back = (guild) => (guild ? `/?g=${guild}` : '/');
    if (url.searchParams.get('error')) return redirect(res, back(pending?.guild), [clear]); // pressed Cancel
    if (!pending || url.searchParams.get('state') !== pending.state) throw new HttpError(400, 'Sign-in expired or came from somewhere else. Try again.');

    const { access_token: token } = await exchangeCode(url.searchParams.get('code'), redirectUri);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const [me, guilds] = await Promise.all([discordJson('/users/@me', auth), discordJson('/users/@me/guilds', auth)]);
    if (!me.ok) throw new HttpError(502, "Couldn't get your Discord account");
    // The player's servers that have Daily Red: the bot's servers, or (with
    // no bot) the ones where someone has played.
    const known = new Set((await bot?.guildIds?.().catch(() => null)) ?? store.knownGuilds());
    const rooms = (guilds.ok && Array.isArray(guilds.body) ? guilds.body : [])
      .filter((g) => known.has(String(g.id)))
      .slice(0, MAX_ROOMS)
      .map((g) => ({ room: `g:${g.id}`, name: String(g.name || 'Server').slice(0, 40) }));
    const user = { id: String(me.body.id), name: me.body.global_name || me.body.username || 'Trainer', avatarUrl: avatarUrl(me.body) };
    const session = { ...user, rooms };
    const guild = rooms.some((r) => r.room === `g:${pending.guild}`) ? pending.guild : null;
    redirect(res, back(guild), [clear, sessionCookie(session)]);
  }

  // A room the player may use. Website players: only their own servers.
  function allowRoom(user, room) {
    if (room && user.web && !user.rooms.some((r) => r.room === room)) throw new HttpError(403, "You're not in that server");
    return room;
  }

  // --- Players ----------------------------------------------------------------

  // The player's saved row with their current Discord name and avatar.
  function loadPlayer({ id, name, avatarUrl: avatar }) {
    const saved = store.getPlayer(id);
    return { id, name, avatarUrl: avatar, stats: { ...EMPTY, ...saved?.stats } };
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

  // --- Money and items (web/economy.js) --------------------------------------------
  // The wallet is the player's, whichever server they play for. It's only
  // saved when it changes, always on the player's own date.

  const walletOf = (id, date) => walletFor(store.getWallet(id), date);

  function spend(user, date, change) {
    if (!economyOpen(date)) throw new HttpError(400, `The PokéMart and the bag open on ${ECONOMY_START_LABEL}.`);
    if (!store.getPlayer(user.id)) store.savePlayer(loadPlayer(user));
    const wallet = walletOf(user.id, date);
    try {
      change(wallet);
    } catch (err) {
      if (err instanceof EconomyError) throw new HttpError(400, err.message);
      throw err;
    }
    store.saveWallet(user.id, wallet);
    return { wallet };
  }

  // POST /api/shop
  const shop = (user, body) => {
    const date = checkDate(body.date);
    return spend(user, date, (wallet) => buy(wallet, body.item, body.quantity ?? 1));
  };

  // POST /api/bag/use: only during today's official battle.
  function useFromBag(user, body) {
    const date = checkDate(body.date);
    const { stats } = loadPlayer(user);
    if (stats.pending !== date || resultFor(stats, date)) throw new HttpError(409, "Items are only for today's battle, while it's on.");
    return spend(user, date, (wallet) => useItem(wallet, date, body.item));
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
    const room = allowRoom(user, checkRoom(query.get('room')));
    const joined = room ? store.joinRoom(room, user.id) : false;
    // Opening the game for a server puts up today's card if it's missing. A
    // player new to the server who already played today (somewhere else)
    // goes on its card and leaderboard straight away.
    if (bot && room?.startsWith('g:') && query.get('date')) {
      try {
        const date = checkDate(query.get('date'));
        if (joined && resultFor(player.stats, date)) {
          bot.updateCard(room.slice(2), date);
          bot.refreshBoard?.(room.slice(2));
        } else {
          bot.ensureCard(room.slice(2), date);
        }
      } catch {
        // a bad date from the page shouldn't stop it signing in
      }
    }
    let date = now().toISOString().slice(0, 10);
    try {
      if (query.get('date')) date = checkDate(query.get('date'));
    } catch { /* the server's date will do */ }
    return { user, stats: player.stats, wallet: walletOf(user.id, date) };
  }

  function battle(user, body) {
    const date = checkDate(body.date);
    const room = allowRoom(user, checkRoom(body.room));
    const player = loadPlayer(user);
    const { stats } = player;
    if (stats.lastPlayed && date < stats.lastPlayed) throw new HttpError(409, 'A later day is already recorded');
    // A battle left unfinished on an earlier day (another device, a crash)
    // is a loss before today's counts.
    if (stats.pending && stats.pending < date && stats.pending !== stats.lastPlayed) {
      store.saveResult({ playerId: user.id, date: stats.pending, won: false });
      recordResult(stats, stats.pending, false);
    }

    const wallet = walletOf(user.id, date);
    let prize = 0;
    if (body.event === 'start') {
      markBattleStarted(stats, date);
    } else if (body.event === 'result') {
      if (typeof body.won !== 'boolean') throw new HttpError(400, 'Missing won');
      // How it went, for the board and the bot (older pages don't send these).
      const count = (value, max) => (Number.isInteger(value) && value >= 0 && value <= max ? value : null);
      if (!resultFor(stats, date)) {
        const result = {
          won: body.won, monsLeft: count(body.monsLeft, 6), redLeft: count(body.redLeft, 6), turns: count(body.turns, 1000),
          gaveUp: !body.won && body.gaveUp === true, // pressed RUN
        };
        store.saveResult({ playerId: user.id, date, ...result, items: usedIn(wallet, date) });
        prize = earn(wallet, date, result); // once a day: the first result counts
      }
      recordResult(stats, date, body.won); // ignored if the day already has a result
    } else {
      throw new HttpError(400, 'Unknown event');
    }
    store.savePlayer(player);
    if (prize) store.saveWallet(user.id, wallet);
    if (room) store.joinRoom(room, user.id);
    // A finished battle also brings the card back down if it scrolled up.
    if (bot && room?.startsWith('g:')) {
      bot.updateCard(room.slice(2), date, { bump: body.event === 'result' });
      if (body.event === 'result') bot.refreshBoard?.(room.slice(2)); // the posted Leaderboard too
    }
    return { stats, wallet, prize };
  }

  // The server's Pokémon Masters (bot.mjs saves them on the 1st), newest
  // first, grouped by month. DMs and group DMs have none.
  function hallOfFame(room) {
    if (!room.startsWith('g:')) return [];
    const months = new Map();
    for (const m of store.masters(room.slice(2))) {
      if (!months.has(m.month)) months.set(m.month, { month: m.month, masters: [] });
      months.get(m.month).masters.push({ id: m.playerId, name: m.name, avatarUrl: m.avatarUrl, wins: m.wins, losses: m.losses });
    }
    return [...months.values()];
  }

  function board(user, query) {
    const room = allowRoom(user, checkRoom(query.get('room'), { required: true }));
    const date = checkDate(query.get('date'));
    const results = store.roomResults(room, date);
    const month = store.monthTotals(room, date.slice(0, 7)); // the Master of the Month race
    const hall = hallOfFame(room);
    // Last month's Master(s) wear the crown all this month.
    const crowned = new Set(hall.find((h) => h.month === previousMonth(date.slice(0, 7)))?.masters.map((m) => m.id));
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
        master: crowned.has(id),
        you: id === user.id,
      };
    });
    const order = { won: 0, lost: 1, battling: 2 };
    players.sort((a, b) => (order[a.today] ?? 3) - (order[b.today] ?? 3)
      || b.winStreak - a.winStreak || b.dayStreak - a.dayStreak || b.wins - a.wins || a.name.localeCompare(b.name));
    // The daily reminder: only in servers, and only when the bot can post.
    const reminders = bot?.status().posting && room.startsWith('g:')
      ? { on: store.hasReminder(room.slice(2), user.id), time: bot.reminderNote }
      : null;
    return { date, players, hallOfFame: hall, reminders };
  }

  // POST /api/reminder: the same switch as the bot's 🔔 Reminders button.
  function reminder(user, body) {
    const room = allowRoom(user, checkRoom(body.room, { required: true }));
    if (!room.startsWith('g:') || !bot?.status().posting) throw new HttpError(400, 'Reminders only work in a server with the bot');
    if (typeof body.on !== 'boolean') throw new HttpError(400, 'Missing on');
    store.joinRoom(room, user.id);
    return { on: bot.toggleReminder(room.slice(2), user.id, body.on), time: bot.reminderNote };
  }

  // POST /api/share: puts the result image on Discord's CDN (with the
  // player's own token) so the Activity can open Discord's share dialog.
  async function share(req) {
    const user = await requireUser(req);
    if (Date.now() - (lastShare.get(user.id) ?? 0) < 5000) throw new HttpError(429, 'One moment…');
    const image = await readBody(req, MAX_SHARE_BYTES);
    if (image.length < PNG.length || !image.subarray(0, PNG.length).equals(PNG)) throw new HttpError(400, 'Expected a PNG image');
    lastShare.set(user.id, Date.now());
    if (lastShare.size > 5000) lastShare.clear();
    const form = new FormData();
    form.append('file', new Blob([image], { type: 'image/png' }), 'daily-red.png');
    const response = await fetch(`${discordApi}/applications/${clientId}/attachment`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer(req)}` },
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.attachment?.url) {
      console.warn(`Discord image upload failed (HTTP ${response.status}): ${data.message ?? ''}`);
      throw new HttpError(502, "Discord didn't take the image");
    }
    return { url: data.attachment.url };
  }

  // --- Routing ------------------------------------------------------------------

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    let result;
    if (route === 'GET /api/config') {
      result = { clientId: clientId || null };
    } else if (route === 'GET /api/web/session') {
      // The website: is sign-in on, and who is signed in (no Discord call).
      // Each page load renews the session (at most once a day), so regular
      // players stay signed in.
      const session = readSession(req);
      if (session && session.exp - now().getTime() < (SESSION_DAYS - 1) * DAY_MS) res.setHeader('Set-Cookie', sessionCookie(session));
      const user = webUser(req);
      result = {
        available: webSignIn,
        user: user && { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
        rooms: user?.rooms ?? [],
      };
    } else if (route === 'POST /api/token') {
      result = await exchangeCode((await readJson(req)).code);
    } else if (route === 'GET /api/me') {
      result = me(await requireUser(req), url.searchParams);
    } else if (route === 'POST /api/battle') {
      const user = await requireUser(req);
      result = battle(user, await readJson(req));
    } else if (route === 'POST /api/shop') {
      const user = await requireUser(req);
      result = shop(user, await readJson(req));
    } else if (route === 'POST /api/bag/use') {
      const user = await requireUser(req);
      result = useFromBag(user, await readJson(req));
    } else if (route === 'GET /api/board') {
      result = board(await requireUser(req), url.searchParams);
    } else if (route === 'POST /api/reminder') {
      const user = await requireUser(req);
      result = reminder(user, await readJson(req));
    } else if (route === 'POST /api/share') {
      result = await share(req);
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
        bot: status.posting ? 'On: posts the live card, recaps, Monday leaderboards and reminders.' : 'Off: DISCORD_BOT_TOKEN isn\'t set.',
        websiteSignIn: webSignIn
          ? `On: the app's only OAuth2 redirect must be ${redirectUri}`
          : 'Off: set PUBLIC_URL (and DISCORD_CLIENT_SECRET) to let friends play in the browser.',
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
      } else if (url.pathname === '/auth/login' && req.method === 'GET') {
        login(req, res, url);
      } else if (url.pathname === '/auth/callback' && req.method === 'GET') {
        await callback(req, res, url);
      } else if (/^\/card\/\d{4}-\d{2}-\d{2}\.png$/.test(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
        // Days from the first one up to tomorrow (time zones), never later:
        // the team would be a spoiler.
        const date = url.pathname.slice(6, 16);
        const tomorrow = addDays(now().toISOString().slice(0, 10), 1);
        if (!cardPicture || !(dayNumber(date) >= 1) || date > tomorrow || Number.isNaN(Date.parse(date))) throw new HttpError(404, 'Not found');
        if (!pictures.has(date)) {
          if (pictures.size >= 8) pictures.delete(pictures.keys().next().value);
          pictures.set(date, cardPicture(date));
        }
        const png = pictures.get(date);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=86400' });
        res.end(req.method === 'HEAD' ? undefined : png);
      } else if (url.pathname === '/auth/logout' && req.method === 'GET') {
        redirect(res, '/', [cookie(SESSION_COOKIE, '', 0)]);
      } else {
        await serveStatic(req, res, url.pathname);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      // A body cut off half-read (too large) leaves the connection unusable.
      if (status === 413 && !res.headersSent) res.setHeader('Connection', 'close');
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
