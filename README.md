# Daily Red

A daily Pokémon battle in the browser, like Wordle. Every day everyone gets
the same six level 100 Pokémon from Generations 1–3. You look them over, pick
your lead, and get one official battle against RED's Mt. Silver team. Practice
runs are unlimited and not recorded. Your wins, losses, win streak and daily
play streak are kept in your browser (or, inside Discord, on the server).

Battles run on [Pokémon Showdown](https://pokemonshowdown.com)'s simulator
with Gen 3 rules ([`@pkmn/sim`](https://github.com/pkmn/ps), MIT), inside a
Web Worker. The battle screen is drawn in the page in a FireRed style, with
the FireRed sprites. RED's decisions come from a small AI that uses the
standard damage calculator ([`@smogon/calc`](https://github.com/smogon/damage-calc), MIT).

Earlier versions ran the real FireRed game (the pret/pokefirered decompilation
with Daily Red's changes) in an mGBA emulator. That's in the git history
before the "Showdown" change; it was too slow on phones and made every build
compile the whole game.

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Team generation](#team-generation)
- [RED and his AI](#red-and-his-ai)
- [Testing](#testing)
- [Discord Activity](#discord-activity)
- [Copyright and licenses](#copyright-and-licenses)
- [Project layout](#project-layout)

## Quick start

You need Node.js 22.13+ and git.

```sh
scripts/fetch-vendor.sh            # the font into web/vendor/
(cd activity && npm ci && npm run build)   # Discord SDK + battle engine into web/vendor/
scripts/get-sprites.sh             # Pokémon sprites and animation graphics into web/sprites/ (a few MB from pret/pokefirered)
node scripts/serve.mjs             # open http://localhost:8080
```

After changing anything in `web/battle/` other than `engine.js` and `view.js`
(which the page loads directly), run `npm run build-battle` in `activity/`
again. Everything else in `web/` is plain files: edit and reload.

## How it works

```
web/index.html + app.js            today's page, the lead picker, stats (daily.js), Discord (discord.js)
   │
   ├─ battle/engine.js  ──postMessage──▶  vendor/battle-worker.js  (bundled from web/battle/worker.js)
   │                                         ├─ team.js     the day's six, from the date's seed
   │                                         ├─ red.js      RED's team
   │                                         ├─ @pkmn/sim   Pokémon Showdown's simulator, Gen 3 rules
   │                                         ├─ ai.js       RED's choices (with @smogon/calc)
   │                                         └─ @pkmn/client + @pkmn/view   what the player sees, as text
   │                                               and a snapshot of the screen after each line
   └─ battle/view.js    the FireRed-style battle screen: plays the text and
                        HP bars one line at a time, shows the move and party menus
```

- **The day's team:** the seed is a hash of today's date in the player's own
  time zone (`dailySeed` in `web/daily.js`), so everyone gets the same team on
  the same calendar day. `?seed=123` shows the team for another seed as a
  practice team.
- **One official battle a day:** it counts as played from the moment it
  starts, so closing the page halfway is a loss (`settleAbandonedGame`).
  Giving up (RUN) is a loss too. A draw (both last Pokémon down at once)
  counts as a loss.
- **Monthly seasons:** win and play streaks start over on the 1st of each
  month (`currentStreaks` / `recordResult` in `web/daily.js`); the best win
  streak is kept for all time. In Discord the bot announces the Pokémon
  Master of the Month that morning.
- **The lead** is remembered per day in the browser. The other five follow in
  the team's order, and you can switch at any time.
- **In battle**, each move button says how it hits RED's Pokémon (Effective,
  Weak or No effect, by type). POKéMON lists your party; tapping one shows
  its summary (moves with type, power, PP and effectiveness, held item,
  ability, nature, stats) with SHIFT to send it out. Tapping RED's info box
  shows his Pokémon's summary, with how its moves hit yours.
- **Text speed:** Normal or Fast, remembered in the browser. Tapping the
  battle screen skips ahead.
- **Move animations** (`web/battle/fx.js`) use FireRed's own animation
  graphics (`web/battle/fx-sprites.js` lists them). They aren't a port of
  FireRed's animation scripts: about 80 moves have their own short recipe
  (Thunderbolt's lightning, Surf's wave, Earthquake's shake, Giga Drain's orbs
  flowing back...), and every other move gets one for its type and kind
  (contact moves lunge and hit, ranged ones fire a projectile in their type's
  style, status moves sprinkle powder, glow or raise stats). Stat changes,
  status conditions, healing, critical hits, Protect and weather have their
  own effects. They can be turned off under the battle.

## Team generation

`web/battle/team.js`, using Showdown's Gen 3 data:

- **Species:** 6 different Pokémon from the 386, whose base stat totals add up
  to at least `TEAM_RULES.MIN_TEAM_BASE_STAT_TOTAL` (2900; RED's team is 2954).
  1 team in 8 includes exactly one legendary, the rest none. FireRed's Deoxys
  is its Attack Forme.
- **Moves:** a real moveset from what the species learns in Gen 3 (level-up,
  TM/HM, tutor): its best attacks of its own types, attacks of other types for
  coverage, and about 40% of the time one support move (sleep, paralysis, a
  stat boost, healing). Moves that need a second turn, recharge, knock out the
  user or depend on something else (Solar Beam, Hyper Beam, Explosion, Focus
  Punch, Dream Eater...) are left out.
- **The rest:** random IVs from `TEAM_RULES.MIN_TEAM_IV` (28) to 31, 252 EVs
  in its two best stats, a nature that suits how it attacks, a random held
  item (battle items plus the type booster for its attacks), and FireRed's
  own personality rules for gender, ability and the 1 in 8192 shiny chance.

Raise `TEAM_RULES` to make the game easier.

## RED and his AI

RED's team is in `web/battle/red.js`: Red's Mt. Silver six from
HeartGold/SoulSilver with Gen 3 movesets, level 100, perfect IVs and full EV
spreads. His AI (`web/battle/ai.js`) sees the real battle, like FireRed's
trainer AI does:

- a move that knocks your Pokémon out comes first (priority moves when he'd
  move second), otherwise the most expected damage, with recoil counted;
- status moves when they're worth it (sleep or paralysis on a healthy target,
  Rest or Morning Sun when hurt, Calm Mind while it's safe, Leech Seed);
- he never switches by choice, and when one of his Pokémon faints he sends in
  the one that matches up best against yours;
- `DIFFICULTY.NOISE` and `DIFFICULTY.MISTAKE_CHANCE` keep him from being
  perfect. Raise them to make him easier.

With these settings a bot that plays your team greedily (best move each turn,
never switching by choice) beats him in about 1 battle in 10. People who
switch well do better.

## Testing

```sh
cd activity && npm test            # server tests, team rules, RED's team, AI battles to the end
cd tests && npm install && npm test   # the site in headless Chrome (CHROME_PATH=... if needed)
```

The site test plays a practice run (giving up), an official battle to the
end, checks the stats, the daily lock, the next day's team and that leaving
halfway counts as a loss. Screenshots go to `tests/output/`.

In the browser console, `dailyRed.teams`, `dailyRed.stats` and
`dailyRed.setSpeed('fast')` help with debugging.

## Discord Activity

Daily Red can also run inside Discord as an Activity, with Discord sign-in,
stats that follow you across devices, a "Today in this server" board with
Today / This month / Streaks / All time tabs, and (with the bot) a live card
in #general that fills in as people play, a recap of yesterday every morning
at 6:00 Eastern like Wordle, and the Pokémon Master of the Month (most wins)
on the 1st. It's
one Docker image that runs on an x86_64 or arm64 machine, e.g. a Raspberry Pi
NAS, and builds in a minute or two. Setup:
[docs/discord-activity.md](docs/discord-activity.md).

## Copyright and licenses

Daily Red is a free, unofficial fan project. It isn't affiliated with or
endorsed by Nintendo, Creatures Inc., GAME FREAK inc. or The Pokémon Company.
Pokémon and all related names, characters and game content are © Nintendo,
Creatures Inc. and GAME FREAK inc.

This repository contains Daily Red's own work. The sprites aren't in it: the
build fetches them from pret/pokefirered's `graphics/pokemon/` and
`graphics/battle_anims/sprites/`. The battle
engine's packages are all MIT-licensed; `web/licenses.txt` lists every
third-party component, and the build writes the bundled packages' license
texts to `web/vendor/battle-worker.LICENSE.txt`. The page footer links to both.

## Project layout

```
web/                          the website (plain files, no build step except the worker)
web/battle/                   the battle: team.js, red.js, ai.js, worker.js (bundled),
                              engine.js, view.js and fx.js (loaded by the page)
web/vendor/, web/sprites/     built or fetched (not in git)
activity/                     the server (Discord sign-in, stats, server list) and build scripts:
                              build-battle.mjs, build-sdk.mjs, build-sprites.mjs
scripts/fetch-vendor.sh       the font (pinned, checksummed)
scripts/get-sprites.sh        pret/pokefirered's Pokémon and animation graphics at a pinned commit → web/sprites/
scripts/serve.mjs             local static server
tests/site.mjs                the site in headless Chrome
Dockerfile, docker-compose.yml, omv/   the Discord Activity image
docs/discord-activity.md      Discord Activity setup
```
