# Daily Red in Discord

Daily Red can run as a **Discord Activity**: you start it from a voice
channel, a text channel or a DM and play the day's battle inside Discord. It's
the same game as the website. On top of that, inside Discord:

- **You sign in with your Discord account**, and your wins, losses and streaks
  are kept on your server instead of in the browser. That way they follow you
  from the desktop app to your phone, and you still get one battle a day across
  all your devices.
- **"Today in this server"** lists everyone in the server who has played, with
  today's result (Beat RED / Lost to RED / Battling RED / Not yet) and their streaks.
- **Your Discord status** shows how today's battle went, e.g. "Beat RED today".
- **With the bot (step 6), in #general:** a live card for the day that fills in
  as people play (result, Pokémon left, turns, streak), a recap of yesterday
  every morning at 6:00 Eastern with a leaderboard, like Wordle, and the
  Pokémon Master of the Month (most wins) on the 1st.

It all runs in one Docker container on your own machine, here a Raspberry Pi
running OpenMediaVault. The container bundles the battle engine and fetches
the sprites while it builds. Nothing gets uploaded anywhere else.

```
Discord app ──▶ <app id>.discordsays.com (Discord's proxy) ──HTTPS──▶ your hostname
                                                                        │ Cloudflare Tunnel
                                                                        │ or your reverse proxy
                                                                        ▼
                                              Pi: dailyred container (activity/server.mjs)
                                                    web/ (site, battle engine, sprites)
                                                    /api (Discord sign-in, stats, board)
                                                    /data/dailyred.sqlite
```

- [Before you start: Discord's limits](#before-you-start-discords-limits)
- [1. Build it on the Pi and try it in a browser](#1-build-it-on-the-pi-and-try-it-in-a-browser)
- [2. Create the Discord application](#2-create-the-discord-application)
- [3. Give the Pi a public HTTPS address](#3-give-the-pi-a-public-https-address)
- [4. Connect it to Discord](#4-connect-it-to-discord)
- [5. Play](#5-play)
- [6. Post the day's battles in #general (the bot)](#6-post-the-days-battles-in-general-the-bot)
- [Updating and backups](#updating-and-backups)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Developing it](#developing-it)

## Before you start: Discord's limits

An Activity that Discord hasn't verified is a **private Activity**:

- It can only be launched in **servers with fewer than 25 members** (and in DMs).
- Only **you, your developer team and up to 50 App Testers** can see it. Testers
  have to be your Discord friends and accept an email invitation.

For a group of friends that's usually fine. Keep it that way: don't apply for
verification or Discovery. Every Activity serves the game to whoever opens it.
That's why Daily Red itself is meant for local play and the public website
went offline.

## 1. Build it on the Pi and try it in a browser

You don't need Discord for this part. You need a **64-bit** OS on the Pi
(Raspberry Pi 4 or 5; OMV 7/8 on 64-bit Raspberry Pi OS or Debian is fine),
OMV's **compose** plugin (it installs Docker), about **3 GB free disk** for
the build and ideally 2 GB+ of RAM.

### In OpenMediaVault's web interface

1. **Services > Compose > Files**, then the **Add (+)** menu > **Add from URL**:
   - URL: `https://raw.githubusercontent.com/malikpervez/dailyred/main/omv/dailyred.yml`
   - Name: `dailyred`
2. Select the new `dailyred` row and press **Up** (the arrow). Docker downloads
   the code from GitHub and builds the image, which takes a minute or two on a
   Pi 4. Leave the output window open, or close it and check later in
   **Tools > logs**.
3. When it's done, open **`http://<nas-ip>:8380/`** on a computer on your
   network. You should see today's Daily Red page, and **Battle RED** should
   start a battle, with stats kept in that browser as usual.
   `http://<nas-ip>:8380/healthz` should say `ok`.

The file ([omv/dailyred.yml](../omv/dailyred.yml)) builds straight from this
repository on GitHub. The log's warning that `DISCORD_CLIENT_ID /
DISCORD_CLIENT_SECRET are not set` is expected until step 4. Every **Up**
rebuilds from GitHub (`pull_policy: build`), so pressing it again picks up new
versions; unchanged steps come from Docker's cache.

### Or over SSH

```sh
sudo apt install git          # if the Pi doesn't have git yet
git clone https://github.com/malikpervez/dailyred.git
cd dailyred
docker compose up -d --build
docker compose logs -f dailyred    # Ctrl+C stops watching; the container keeps running
```

This uses the repository's `docker-compose.yml`, which builds from the
checkout instead of GitHub (port 8380 too).

### If the game won't start in the browser

If the page loads but the game won't start, try it as `localhost` through an
SSH tunnel: `ssh -L 8380:localhost:8380 <user>@<nas-ip>`, then open
`http://localhost:8380/`. Browsers allow some features only on HTTPS or
localhost. The game shouldn't need any of them, but this rules that out.

Stats are kept in a Docker volume (`dailyred-data`), so they survive
rebuilds.

## 2. Create the Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application**, name it "Daily Red", accept the terms.
2. **General Information**: copy the **Application ID**. That's your
   `DISCORD_CLIENT_ID`. You can also set the icon and description people see.
3. **OAuth2**: click **Reset Secret** and copy it. That's your
   `DISCORD_CLIENT_SECRET`; keep it private. Under **Redirects** add
   `https://127.0.0.1`. Discord needs a redirect for the sign-in to work,
   even though the Activity never uses it.
4. **Bot**: turn **Public Bot** off, so only you can add the app to servers.
5. **Installation**: leave **Guild Install** ticked. Add **User Install** too
   if you want to start it in DMs. Install link: **Discord Provided Link**.
6. **Activities > Settings**: turn on **Enable Activities**. Supported
   platforms: Desktop/Web, iOS and Android. For phones, choose **portrait**
   (the touch controls sit under the screen).
7. **Activities > URL Mappings**: set the root mapping **`/`** to your
   public hostname from step 3, **without** `https://`, e.g.
   `dailyred.example.com`. One mapping is all it needs.
8. **App Testers**: invite the friends who'll play. They need to accept the email.
9. Add the app to your server: **Installation**, copy the install link, open
   it and pick your server.

## 3. Give the Pi a public HTTPS address

Discord's proxy fetches the Activity from a public HTTPS hostname, so the Pi
has to be reachable from the internet on one. Pick one of these:

### Option A: Cloudflare Tunnel (no ports opened on your router)

This needs a domain on Cloudflare (the free plan is enough).

1. Cloudflare dashboard > **Zero Trust > Networks > Tunnels > Create a tunnel**,
   type **Cloudflared**, name it e.g. `dailyred`.
2. On the install step, copy the token: the long string after `--token`.
   It's your `CLOUDFLARE_TUNNEL_TOKEN`. You don't need to install anything
   by hand; the compose file runs `cloudflared` for you.
3. Add a **Public Hostname**: subdomain `dailyred`, your domain, service
   type **HTTP**, URL **`dailyred:8080`** (the container's name on the
   compose network).
4. Use that hostname (`dailyred.example.com`) for the URL mapping in step 2.7.

### Option B: a reverse proxy you already run

If you already have Nginx Proxy Manager, SWAG, Traefik or Caddy on the NAS with
a Let's Encrypt certificate, add a proxy host:

- `dailyred.example.com` → `http://<pi-ip>:8380` (`DAILYRED_PORT` in `.env`)
- No websockets, authentication or caching rules needed. The server sends
  `Cache-Control: no-cache` and gzips what's worth gzipping.

You also need ports 80/443 forwarded to the proxy and DNS pointing at your
home IP, which is the usual setup for these proxies.

## 4. Connect it to Discord

Give the container the app's ID and secret (step 2). It's the same image, so
nothing needs rebuilding.

**In OMV:** Services > Compose > Files, select `dailyred`, **Edit**, tick
**Show environment file** and put this in the **Environment** box:

```
DISCORD_CLIENT_ID=your application id
DISCORD_CLIENT_SECRET=your client secret
```

With a Cloudflare Tunnel (option A), also add
`CLOUDFLARE_TUNNEL_TOKEN=your tunnel token` and uncomment the `cloudflared`
service in the file. **Save**, then press **Up**.

**Over SSH:**

```sh
cd dailyred
cp .env.example .env
nano .env                     # DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET (+ CLOUDFLARE_TUNNEL_TOKEN)

# Option A (Cloudflare Tunnel):
docker compose --profile tunnel up -d
# Option B (your own reverse proxy):
docker compose up -d
```

**Check it:** `https://dailyred.example.com/` in a normal browser should show
the website, and `https://dailyred.example.com/healthz` should say `ok`. The
log no longer warns about missing Discord settings.

## 5. Play

- **Voice channel:** click the rocket (Activities) button and pick Daily Red.
- **Text channel or DM:** open the App Launcher (the shapes icon next to the
  message box) and pick Daily Red.
- The first time, Discord asks to let Daily Red see your username and avatar
  and update your activity status. After that it signs you in by itself.

Private Activities only show up for the people allowed to see them:

- **You (the owner):** User Settings > Advanced > **Developer Mode** on.
- **App Testers:** User Settings > Advanced > **Application Test Mode**,
  paste the Application ID, **Activate**.

Everyone gets the same team on the same calendar day, like on the website. The
day changes at each player's local midnight. Start the battle and it counts:
closing the Activity mid-battle is a loss the next time you open it, exactly
like reloading the website.

## 6. Post the day's battles in #general (the bot)

The bot posts two kinds of message in each server's **#general**:

- **The live card**: one message per day, posted when the first battle of the
  day starts and edited as people start and finish. Each player shows their
  result, how many Pokémon they had left, turns and streak, with 🟥⬛ squares.
  Nobody's team or lead is shown.
- **The morning recap**: at 6:00 AM Eastern, yesterday's results ranked (wins
  first, then Pokémon left, then fewest turns), win streak leaders, the
  month's Master race, how many days in a row the server has played, and who
  didn't play.
- **Pokémon Master of the Month**: on the 1st, right after the recap, the
  player with the most wins last month, with the runners-up. Ties go to fewer
  losses, then more Pokémon left over the month, then fewer turns; if it's
  still a tie they share the title. Everyone's streaks start over that day
  (the best win streak is kept).

Both have a **Battle RED** button that opens the Activity and a **Leaderboard**
button that shows the server's leaderboard to whoever presses it. Mentions in
the messages never ping anyone.

1. **Developer Portal > your app > Bot**: press **Reset Token** and copy it.
   Leave the privileged intents off; the bot doesn't need them.
2. **General Information**: copy the **Public Key**.
3. **In OMV**, edit the `dailyred` file. If its `environment:` list doesn't
   have the `DISCORD_BOT_TOKEN` lines yet (files added before the bot existed
   don't), add these under `DISCORD_CLIENT_SECRET`:

   ```yaml
         DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:-}
         DISCORD_PUBLIC_KEY: ${DISCORD_PUBLIC_KEY:-}
         PUBLIC_URL: ${PUBLIC_URL:-}
         DAILYRED_CHANNEL: ${DAILYRED_CHANNEL:-general}
         RECAP_TIME: ${RECAP_TIME:-06:00}
         RECAP_TIMEZONE: ${RECAP_TIMEZONE:-America/New_York}
   ```

   Then in the environment box add `DISCORD_BOT_TOKEN=` (step 1),
   `DISCORD_PUBLIC_KEY=` (step 2) and `PUBLIC_URL=` your public address from
   step 3, e.g. `https://nas.tailxxxx.ts.net` (optional: it adds Pikachu to
   the messages). Save and press **Up**.
4. **Invite the bot to your server.** The container's log prints the link
   (**Tools > logs**: "Add it to a server: …"). It's
   `https://discord.com/oauth2/authorize?client_id=<your client ID>&scope=bot%20applications.commands&permissions=84992`
   and asks for View Channel, Send Messages, Embed Links and Read Message
   History. Check that the bot can post in #general.
5. **General Information > Interactions Endpoint URL**:
   `https://<your public address>/api/interactions`, then **Save**. Discord
   checks it straight away, so the container must already be running with
   `DISCORD_PUBLIC_KEY` set (step 3). This is what makes the buttons work.

   If the portal says *"The specified interactions endpoint url could not be
   verified"*, open that same address in a browser. It shows what the server
   sees: `"publicKey": "ok"` means Discord can verify it (check the address in
   the portal matches exactly, with `https://` and `/api/interactions`);
   `"missing"` means the key isn't reaching the container (step 3: the
   `environment:` list in the file, then **Up**); `"invalid"` means it was
   copied wrong. A page that doesn't load means the address itself is wrong.

Play a battle in the server: the card appears in #general within a second or
two. Change the channel with `DAILYRED_CHANNEL` (without the `#`), or the time
with `RECAP_TIME` / `RECAP_TIMEZONE` (an IANA name such as `America/Chicago`).
If a server has no #general, the bot uses its system channel (where "welcome"
messages go). The recap is skipped on days nobody in the server played.

## Updating and backups

**In OMV:** select `dailyred` and press **Up**. The file's `pull_policy: build`
makes every Up fetch the latest code from GitHub and rebuild.

**Over SSH:**

```sh
cd dailyred
git pull
docker compose up -d --build      # add --profile tunnel for option A
```

Stats survive rebuilds (they're in the volume). For a backup over SSH, stop
the container briefly so the database is consistent:

```sh
docker compose stop dailyred
docker compose cp dailyred:/data/dailyred.sqlite ./dailyred-backup.sqlite
docker compose start dailyred
```

## How it works

- **No separate app:** the Activity *is* the website (`web/`). `web/discord.js`
  only runs when Discord opens the page (its URL carries a `frame_id`).
  Everywhere else the site behaves exactly as before and keeps stats in
  localStorage.
- **The battle runs in a Web Worker** loaded from the same origin
  (`vendor/battle-worker.js`), which Discord's sandbox allows, like avatars
  from `cdn.discordapp.com`. Every file is same-origin, so a single URL
  mapping covers everything.
- **Sign-in:** the Embedded App SDK's `authorize` gives a one-time code; the
  server exchanges it for an access token with the client secret
  (`POST /api/token`); the page passes the token to `authenticate` and uses it
  for the API. The server checks each token with Discord (`/users/@me`, cached
  for 10 minutes) and never stores it.
- **Stats** use the same rules as the website (`web/daily.js`, shared by the
  server): the page reports when RED's battle starts and how it ends
  (`POST /api/battle`), and the server applies them to your record. Dates
  have to be within a day of the server's date, and a day can't be recorded
  twice or out of order. As on the website, the game is the referee: a player
  who edits the page could still report a win they didn't earn. It's a
  friendly daily game, not a ranked ladder.
- **What's stored** (`/data/dailyred.sqlite`): for each player, their Discord
  user ID, display name, avatar URL and stats, plus which servers or DMs
  they've played in (for "Today in this server"). Nothing else.
- **Layout:** inside Discord the page drops the big title and sizes the
  screen to fit the Activity window. On phones it shows the touch controls as
  usual. Links open in the browser through Discord, and the licenses open in
  a dialog.

## Troubleshooting

**The OMV build stops with `"git": executable file not found`.** Docker
needs git on the NAS to fetch the code from GitHub. Install it once over SSH
(`sudo apt install git`) and press **Up** again.

**The Activity doesn't show up.** Turn on Developer Mode (owner) or
Application Test Mode (testers), and check the server has fewer than 25
members and the app is installed in it.

**A blank or white Activity.** Usually the URL mapping. It has to be just
the hostname (`dailyred.example.com`), no `https://`, no path, no trailing
slash. Also check that the hostname loads in a normal browser. With
Cloudflare, if the site loads in your browser but not in Discord, look for a
challenge page: Bot Fight Mode or other bot protection on that hostname can
block Discord's proxy.

**"Couldn't sign in with Discord" under the screen.** The game still works
(stats stay on that device). Check the server's log:
`docker compose logs dailyred`.

- `invalid_client`: the client ID or secret in `.env` is wrong. Fix it and
  run `docker compose up -d`.
- `DISCORD_CLIENT_ID ... not set`: `.env` isn't next to `docker-compose.yml`.
- Nothing in the log: the page couldn't reach `/api`. Check the proxy or tunnel
  forwards everything under the hostname, not just `/`.

Also check the `https://127.0.0.1` redirect from step 2.3.

**Seeing the browser console.** The easiest way is to open Discord in a web
browser (discord.com/app), start the Activity there and use the browser's dev
tools.

**After an update you still get the old version.** Close the Activity
completely and start it again.

## Developing it

```sh
cd activity
npm ci
npm run build           # web/vendor/discord-sdk.js and battle-worker.js
npm test                # the server's API tests (fake Discord) and the battle rules
cd ..
DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... node activity/server.mjs   # http://localhost:8080
```

Outside Discord the page is the normal website, so most work needs no Discord
at all. To try a change inside Discord without rebuilding the image, run the
server on your computer, start a quick tunnel with
`cloudflared tunnel --url http://localhost:8080`, and point the URL mapping at
the `*.trycloudflare.com` hostname it prints. Put it back afterwards.

| File | What it does |
|---|---|
| `web/discord.js` | Discord sign-in, server-side stats, status, "Today in this server" |
| `activity/server.mjs` | Entry point: env, database, HTTP server |
| `activity/app.mjs` | Static files and the `/api` routes |
| `activity/store.mjs` | SQLite storage (`node:sqlite`, no npm packages) |
| `activity/bot.mjs` | The bot: live card, morning recap, leaderboard, button presses |
| `activity/build-sdk.mjs` | Bundles Discord's SDK into `web/vendor/` |
| `activity/build-battle.mjs` | Bundles the battle engine into `web/vendor/` |
| `scripts/get-sprites.sh` | The Pokémon sprites into `web/sprites/` |
| `Dockerfile`, `docker-compose.yml` | Vendor files, battle engine, sprites, server image; optional tunnel |
