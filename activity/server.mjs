// Daily Red's Discord Activity server: the website plus the activity API (app.mjs).
//
//   DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... node activity/server.mjs
//
// Environment:
//   DISCORD_CLIENT_ID      the application's ID (Developer Portal > OAuth2)
//   DISCORD_CLIENT_SECRET  its client secret (same page; keep it private)
//   PORT                   default 8080
//   DATA_DIR               where dailyred.sqlite goes, default ./data
//   WEB_ROOT               the site to serve, default ../web next to this file
import { createServer } from 'node:http';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { openStore } from './store.mjs';

const env = process.env;
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
const handle = createApp({
  webRoot,
  store,
  clientId: env.DISCORD_CLIENT_ID,
  clientSecret: env.DISCORD_CLIENT_SECRET,
});

const server = createServer(handle);
server.listen(port, () => {
  console.log(`Daily Red activity server on http://localhost:${server.address().port} (site: ${webRoot}, data: ${dataDir})`);
});

// docker stop sends SIGTERM: finish open requests and close the database cleanly.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
