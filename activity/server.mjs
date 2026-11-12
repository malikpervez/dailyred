// Daily Red's Discord Activity server: the website plus the activity API (app.mjs).
//
//   DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... node activity/server.mjs
//
// Environment:
//   DISCORD_CLIENT_ID      the application's ID (Developer Portal > OAuth2)
//   DISCORD_CLIENT_SECRET  its client secret (same page; keep it private)
//   DISCORD_BOT_TOKEN      the bot's token (Bot page), for the live card and recaps in
//                          #general (bot.mjs); without it nothing is posted
//   DISCORD_PUBLIC_KEY     the app's public key (General Information), for the
//                          Battle RED / Leaderboard buttons (POST /api/interactions)
//   DAILYRED_CHANNEL       the channel the bot posts in, default general
//   RECAP_TIME             when the morning recap goes out, default 06:00
//   RECAP_TIMEZONE         ...in this time zone, default America/New_York (Monday
//                          leaderboards and reminders use it too)
//   REMINDER_TIME          when players who asked for it get their daily reminder, default 17:00
//   PUBLIC_URL             this site's public address, for the picture in the bot's
//                          messages (optional), e.g. https://nas.example.ts.net
//   PORT                   default 8080
//   DATA_DIR               where dailyred.sqlite goes, default ./data
//   WEB_ROOT               the site to serve, default ../web next to this file
import { createServer } from 'node:http';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { createBot, inviteUrl } from './bot.mjs';
import { openStore } from './store.mjs';

// Values pasted into OMV's environment box can pick up spaces or quotes.
const env = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, String(v).trim().replace(/^["'](.*)["']$/, '$1').trim()]));
const port = Number(env.PORT || 8080);
const dataDir = resolve(env.DATA_DIR || 'data');
const webRoot = resolve(env.WEB_ROOT || fileURLToPath(new URL('../web', import.meta.url)));

try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
} catch {
  console.error(`Can't write to ${dataDir}. If it's a mounted folder, give the container's user`
    + ` (uid ${process.getuid?.() ?? '?'}) access, e.g.: sudo chown -R ${process.getuid?.() ?? 1000} <folder>`);
  process.exit(1);
}

if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
  console.warn('DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET are not set: the site works, but Discord sign-in will fail.');
}

const store = openStore(join(dataDir, 'dailyred.sqlite'));

let bot = null;
if ((env.DISCORD_BOT_TOKEN || env.DISCORD_PUBLIC_KEY) && env.DISCORD_CLIENT_ID) {
  bot = createBot({
    token: env.DISCORD_BOT_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
    publicKey: env.DISCORD_PUBLIC_KEY || null,
    store,
    channelName: env.DAILYRED_CHANNEL || 'general',
    recapTime: env.RECAP_TIME || '06:00',
    recapTimeZone: env.RECAP_TIMEZONE || 'America/New_York',
    reminderTime: env.REMINDER_TIME || '17:00',
    publicUrl: env.PUBLIC_URL || null,
  });
  bot.start();
  if (env.DISCORD_BOT_TOKEN) {
    console.log(`Daily Red bot on: posts in #${env.DAILYRED_CHANNEL || 'general'}, recap at ${env.RECAP_TIME || '06:00'} (leaderboard on Mondays),`
      + ` reminders at ${env.REMINDER_TIME || '17:00'}, ${env.RECAP_TIMEZONE || 'America/New_York'}.`
      + ` Add it to a server: ${inviteUrl(env.DISCORD_CLIENT_ID)}`);
  } else {
    console.log('DISCORD_BOT_TOKEN is not set: nothing is posted in Discord (the buttons endpoint still works).');
  }
  console.log(`Interactions endpoint (Battle RED / Leaderboard buttons): ${bot.status().publicKey === 'ok' ? 'ready' : `not ready, DISCORD_PUBLIC_KEY is ${bot.status().publicKey}`}.`
    + ' Open /api/interactions in a browser to check.');
} else {
  console.log('DISCORD_BOT_TOKEN / DISCORD_PUBLIC_KEY are not set (or DISCORD_CLIENT_ID is missing): the bot is off.');
}

const handle = createApp({
  webRoot,
  store,
  clientId: env.DISCORD_CLIENT_ID,
  clientSecret: env.DISCORD_CLIENT_SECRET,
  bot,
});

const server = createServer(handle);
server.listen(port, () => {
  console.log(`Daily Red activity server on http://localhost:${server.address().port} (site: ${webRoot}, data: ${dataDir})`);
});

// docker stop sends SIGTERM: finish open requests and close the database cleanly.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    bot?.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
