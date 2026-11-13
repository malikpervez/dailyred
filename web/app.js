// Website controller: today's page (your six, the lead picker, RED's team,
// your stats) and the battle. The battle itself runs on Pokémon Showdown's
// simulator in a Web Worker (battle/worker.js); battle/view.js draws it.
// Inside a Discord Activity, discord.js adds sign-in, stats kept on the
// server and the "Today in this server" list.
import {
  today, addDays, dailySeed, dayNumber, msUntilTomorrow, loadStats, resultFor, currentStreaks,
  markBattleStarted, recordResult, settleAbandonedGame, useStatsStorage,
} from './daily.js';
import {
  inDiscord, connectDiscord, webSession, connectWeb, renderBoard, renderHallOfFame, standingText,
} from './discord.js';
import { loadTeams, startBattle, choose, forfeit, detach } from './battle/engine.js';
import { createBattleView, spriteUrl } from './battle/view.js';
import { drawShareImage, canvasToBlob } from './share.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const ui = {
  loadingText: $('loading-text'),
  errorText: $('error-text'),
  dayLabel: $('day-label'),
  nextTeam: $('next-team'),
  play: $('play'),
  played: $('played'),
  playedResult: $('played-result'),
  playedNext: $('played-next'),
  practice: $('practice'),
  practiceNote: $('practice-note'),
  practiceLocked: $('practice-locked'),
  signin: $('signin'),
  signinLink: $('signin-link'),
  account: $('account'),
  redLeadSprite: $('red-lead-sprite'),
  redLeadName: $('red-lead-name'),
  yourLeadSprite: $('your-lead-sprite'),
  yourLeadName: $('your-lead-name'),
  teamList: $('team-list'),
  redList: $('red-list'),
  redDetails: $('red-details'),
  board: $('board'),
  boardHeading: $('board-heading'),
  boardList: $('board-list'),
  boardNote: $('board-note'),
  practiceChip: $('practice-chip'),
  turnLabel: $('turn-label'),
  battleDone: $('battle-done'),
  doneTitle: $('done-title'),
  doneStanding: $('done-standing'),
  shareText: $('share-text'),
  shareImage: $('share-image'),
  shareButton: $('share-result'),
  shareNote: $('share-note'),
  reminder: $('reminder'),
  reminderBox: $('reminder-box'),
  reminderTime: $('reminder-time'),
  hall: $('hall'),
  hallList: $('hall-list'),
};

// ?seed=123 shows the team for that seed instead of today's, for testing and
// for fun: nothing is recorded and there's no daily limit. Not the daily
// teams around today, though (somewhere in the world it's already up to two
// days later), or it would be a way to practice the real battle first.
const practiceSeed = (() => {
  const seed = parseSeed(new URLSearchParams(location.search).get('seed'));
  const daily = [-2, -1, 0, 1, 2].map((d) => dailySeed(addDays(today(), d)));
  return daily.includes(seed) ? null : seed;
})();

function parseSeed(text) {
  if (text == null || !/^\d{1,10}$/.test(String(text).trim())) return null;
  const seed = Number(text);
  return seed >= 1 && seed <= 0xFFFFFFFF ? seed : null;
}

// Per-browser preferences (the lead and text speed). Storage can be blocked.
const prefs = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* not remembered */ } },
};

let stats = null; // loaded in start(), once we know where they're kept
let discord = null; // the Discord session (discord.js): the Activity, or signed in on the website
let signInFirst = false; // the website can sign in with Discord, and the player hasn't
let date = null; // the day the page shows
let seed = null;
let teams = null; // { team, red } from the engine
let lead = 0;
let battle = null; // { official, date, done }
let speed = prefs.get('dailyred-speed') === 'fast' ? 'fast' : 'normal';
let animations = prefs.get('dailyred-anims') !== 'off';

function setState(state) {
  app.dataset.state = state;
  if (state !== 'battle') document.title = 'Daily Red';
}

// --- Header ------------------------------------------------------------------------

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

function renderHeader() {
  const label = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  ui.dayLabel.textContent = practiceSeed ? `Practice team #${practiceSeed}` : `No. ${dayNumber(date)}, ${label}`;
}

function tick() {
  const left = formatTime(msUntilTomorrow());
  ui.nextTeam.textContent = left;
  if (!ui.played.hidden) ui.playedNext.textContent = `Next battle in ${left}`;
  // At midnight a new team arrives: reload today's page (not mid-battle).
  if (date && date !== today() && app.dataset.state === 'home' && !practiceSeed) loadDay();
}
setInterval(tick, 1000);

// --- Today's page ----------------------------------------------------------------------

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const leadKey = () => `dailyred-lead:${practiceSeed ?? date}`;

function battleOrder() {
  return [lead, ...teams.team.map((_, i) => i).filter((i) => i !== lead)];
}

function typeBadges(types) {
  const row = el('span', 'types');
  for (const type of types) {
    const badge = el('span', 'type-badge', type);
    badge.dataset.type = type;
    row.append(badge);
  }
  return row;
}

function sprite(mon, className) {
  const img = el('img', className);
  img.src = spriteUrl(mon.num, { shiny: mon.shiny });
  img.alt = '';
  img.width = img.height = 64;
  img.loading = 'lazy';
  return img;
}

const STAT_NAMES = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
const genderSymbol = (g) => (g === 'M' ? '♂' : g === 'F' ? '♀' : '');

function monCard(mon, index, { red = false } = {}) {
  const item = el('li', 'mon-card');
  if (!red && index === lead) item.classList.add('is-lead');

  const head = el('div', 'mon-head');
  head.append(sprite(mon, 'mon-sprite'));
  const title = el('div', 'mon-title');
  const name = el('h3', 'mon-name', mon.species);
  const gender = el('span', 'mon-gender', genderSymbol(mon.gender));
  gender.dataset.gender = mon.gender;
  name.append(gender);
  if (mon.shiny) name.append(el('span', 'mon-shiny', '★'));
  title.append(name, typeBadges(mon.types));
  head.append(title);
  if (!red) {
    if (index === lead) {
      head.append(el('span', 'lead-badge', 'LEAD'));
    } else {
      const button = el('button', 'button button-small set-lead', 'Set as lead');
      button.type = 'button';
      button.addEventListener('click', () => setLead(index));
      head.append(button);
    }
  }
  item.append(head);

  const facts = el('dl', 'mon-facts');
  for (const [label, value, title] of [['Item', mon.item, mon.itemDesc], ['Ability', mon.ability, mon.abilityDesc], ['Nature', mon.nature]]) {
    const row = el('div');
    const dd = el('dd', '', value);
    if (title) dd.title = title;
    row.append(el('dt', '', label), dd);
    facts.append(row);
  }
  item.append(facts);
  if (mon.itemDesc) {
    const help = el('p', 'mon-item-desc');
    help.append(el('strong', '', `${mon.item}: `), mon.itemDesc);
    item.append(help);
  }

  const moves = el('ul', 'mon-moves');
  for (const move of mon.moves) {
    const row = el('li', 'mon-move');
    row.dataset.type = move.type;
    row.title = move.desc ?? '';
    row.append(el('span', 'move-type'), el('span', 'mon-move-name', move.name));
    const detail = [move.type, move.category === 'Status' ? 'Status' : `${move.power ?? '—'} ${move.category}`].join(' · ');
    row.append(el('span', 'mon-move-detail', detail));
    moves.append(row);
  }
  item.append(moves);

  const statList = el('dl', 'mon-stats');
  const total = Object.values(mon.baseStats).reduce((a, b) => a + b, 0);
  for (const [key, label] of STAT_NAMES) {
    const row = el('div', 'stat-row');
    const bar = el('span', 'stat-bar');
    const fill = el('span', 'stat-fill');
    fill.style.width = `${Math.min(100, (mon.stats[key] / (key === 'hp' ? 450 : 400)) * 100)}%`;
    bar.append(fill);
    row.append(el('dt', '', label), el('dd', 'stat-value', String(mon.stats[key])), bar);
    statList.append(row);
  }
  const bst = el('p', 'mon-bst', `Base stat total ${total}`);
  item.append(statList, bst);
  return item;
}

function renderTeams() {
  const yourLead = teams.team[lead];
  const redLead = teams.red[0];
  ui.yourLeadSprite.src = spriteUrl(yourLead.num, { shiny: yourLead.shiny });
  ui.yourLeadName.textContent = yourLead.species;
  ui.redLeadSprite.src = spriteUrl(redLead.num);
  ui.redLeadName.textContent = redLead.species;

  ui.teamList.replaceChildren(...teams.team.map((mon, i) => monCard(mon, i)));
  ui.redList.replaceChildren(...teams.red.map((mon, i) => {
    const row = el('li', 'red-mon');
    row.append(el('span', 'red-index', String(i + 1)), sprite(mon, 'red-sprite'), el('span', 'red-name', mon.species), typeBadges(mon.types));
    return row;
  }));
  ui.redDetails.replaceChildren(...teams.red.map((mon, i) => monCard(mon, i, { red: true })));
}

function setLead(index) {
  lead = index;
  prefs.set(leadKey(), String(index));
  renderTeams();
  document.querySelector('.leads')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderHome() {
  const { winStreak, dayStreak } = currentStreaks(stats, date);
  const played = stats.wins + stats.losses;
  $('stat-played').textContent = played;
  $('stat-win-rate').textContent = played ? Math.round((stats.wins / played) * 100) : 0;
  $('stat-win-streak').textContent = winStreak;
  $('stat-day-streak').textContent = dayStreak;

  const result = practiceSeed ? null : resultFor(stats, date);
  // On a website that can sign in with Discord, the battle that counts needs
  // it (and playing signed out first would be a free practice run).
  const needSignIn = signInFirst && !practiceSeed;
  ui.signin.hidden = !needSignIn;
  ui.play.hidden = Boolean(result) || needSignIn;
  ui.played.hidden = !result || needSignIn;
  ui.practiceNote.hidden = !practiceSeed;
  // Today's team can only be practised once today's battle is done, so the
  // battle that counts is everyone's first try with it.
  ui.practice.hidden = Boolean(practiceSeed) || !result;
  ui.practiceLocked.hidden = Boolean(practiceSeed) || Boolean(result);
  ui.play.textContent = practiceSeed ? 'Battle RED (practice)' : 'Battle RED';
  if (result) ui.playedResult.textContent = result === 'won' ? 'You beat RED today!' : 'RED won today.';
  tick();

  const record = `${stats.wins}W ${stats.losses}L`;
  if (result === 'won') discord?.setPresence('Beat RED today', `${record} · ${winStreak} win streak`);
  else if (result === 'lost') discord?.setPresence('Lost to RED today', record);
  else discord?.setPresence("Today's battle: not yet", record);
  refreshBoard();
}

async function loadDay() {
  date = today();
  seed = practiceSeed ?? dailySeed(date);
  renderHeader();
  setState('loading');
  ui.loadingText.textContent = "Loading today's team…";
  try {
    teams = await loadTeams(seed);
  } catch (err) {
    showError(err);
    return;
  }
  const saved = Number(prefs.get(leadKey()));
  lead = Number.isInteger(saved) && saved >= 0 && saved < teams.team.length ? saved : 0;
  renderTeams();
  renderHome();
  setState('home');
}

function showError(err) {
  console.error(err);
  ui.errorText.textContent = err?.message || String(err);
  setState('error');
}

// --- Today in this server (Discord only) ---------------------------------------

let boardTimer = null;

let boardTab = 'today';
let boardPlayers = [];

for (const button of document.querySelectorAll('[data-board]')) {
  button.addEventListener('click', () => {
    boardTab = button.dataset.board;
    for (const b of document.querySelectorAll('[data-board]')) b.setAttribute('aria-pressed', String(b === button));
    renderBoard(ui.boardList, boardPlayers, boardTab);
    if (boardPlayers.length) {
      ui.boardNote.textContent = boardTab === 'month' ? 'Most wins this month becomes the Pokémon Master of the Month. Streaks start over on the 1st.' : '';
    }
  });
}

ui.reminderBox.addEventListener('change', async () => {
  const on = ui.reminderBox.checked;
  ui.reminderBox.disabled = true;
  try {
    ui.reminderBox.checked = (await discord.setReminder(on)).on;
  } catch (err) {
    console.warn("Couldn't change the reminder", err);
    ui.reminderBox.checked = !on;
  } finally {
    ui.reminderBox.disabled = false;
  }
});

async function refreshBoard() {
  if (!discord?.room) return;
  clearTimeout(boardTimer);
  try {
    const { players, hallOfFame = [], reminders = null } = await discord.board(today());
    boardPlayers = players;
    renderBoard(ui.boardList, players, boardTab);
    ui.hall.hidden = !hallOfFame.length;
    renderHallOfFame(ui.hallList, hallOfFame);
    ui.reminder.hidden = !reminders;
    if (reminders) {
      ui.reminderBox.checked = reminders.on;
      ui.reminderTime.textContent = reminders.time;
    }
    ui.boardNote.textContent = !players.length ? 'Nobody has played here yet. Be the first to battle RED!'
      : boardTab === 'month' ? 'Most wins this month becomes the Pokémon Master of the Month. Streaks start over on the 1st.' : '';
  } catch (err) {
    console.warn("Couldn't load today's players", err);
  }
  // Keep it fresh while today's page is up; others play meanwhile.
  boardTimer = setTimeout(() => {
    if (app.dataset.state === 'home' && !document.hidden) refreshBoard();
  }, 30000);
}

// --- The battle --------------------------------------------------------------------------

const view = createBattleView($('battle-root'), {
  onChoose: (choice) => choose(choice),
  onRun: () => askToRun(),
  getSpeed: () => speed,
  getAnimations: () => animations,
});

function renderSpeed() {
  for (const button of document.querySelectorAll('[data-speed]')) {
    button.setAttribute('aria-pressed', String(button.dataset.speed === speed));
  }
  for (const button of document.querySelectorAll('[data-anims]')) {
    button.setAttribute('aria-pressed', String((button.dataset.anims === 'on') === animations));
  }
}
for (const button of document.querySelectorAll('[data-anims]')) {
  button.addEventListener('click', () => {
    animations = button.dataset.anims === 'on';
    prefs.set('dailyred-anims', animations ? 'on' : 'off');
    renderSpeed();
  });
}
for (const button of document.querySelectorAll('[data-speed]')) {
  button.addEventListener('click', () => {
    speed = button.dataset.speed;
    prefs.set('dailyred-speed', speed);
    renderSpeed();
  });
}

async function beginBattle({ practice }) {
  if (signInFirst && !practiceSeed) return;
  if (practice && !practiceSeed && !resultFor(stats, date)) {
    renderHome(); // practice unlocks after today's battle
    return;
  }
  const official = !practice && !practiceSeed;
  if (official) {
    // Another tab (or, in Discord, another device) may have played meanwhile.
    await discord?.refreshStats().catch((err) => console.warn("Couldn't refresh stats", err));
    stats = loadStats();
    if (date !== today()) {
      loadDay();
      return;
    }
    if (resultFor(stats, date)) {
      renderHome();
      return;
    }
  }
  battle = { official, date, ran: false, done: false };
  const name = discord?.user?.name ?? 'You';
  ui.practiceChip.hidden = official;
  ui.battleDone.hidden = true;
  ui.turnLabel.textContent = '';
  view.reset({ name });
  setState('battle');
  document.title = 'Daily Red: battling RED';
  window.scrollTo({ top: 0 });

  if (official) {
    markBattleStarted(stats, date);
    discord?.report('start', date);
    discord?.setPresence('Battling RED', `${stats.wins}W ${stats.losses}L`);
  }

  startBattle({ seed, order: battleOrder(), name }, {
    onEvents: (events) => {
      const turn = events.findLast((e) => e.turn)?.turn;
      if (turn) {
        ui.turnLabel.textContent = `Turn ${turn}`;
        if (battle) battle.turns = turn;
      }
      view.play(events);
    },
    onRequest: (request) => view.request(request),
    onEnd: (won, tie) => endBattle(won, tie),
    onError: (err) => {
      battle = null;
      showError(err);
    },
  });
}

function endBattle(won, tie = false) {
  if (!battle || battle.done) return;
  battle.done = true;
  if (battle.official) {
    recordResult(stats, battle.date, won);
    // How it went, for the server's board and the Discord bot's card.
    const alive = (side) => (view.state?.[side].party ?? []).filter((p) => p !== 'fnt').length;
    battle.reported = discord?.report('result', battle.date, won, {
      monsLeft: alive('p1'), redLeft: alive('p2'), turns: battle.turns ?? 0, gaveUp: !won && battle.ran,
    });
  }
  const text = won ? 'You defeated RED!'
    : tie ? 'Both last Pokémon fell at once. A draw counts as a loss.'
    : battle.ran ? 'You gave up. RED wins.'
    : 'Your team was wiped out. RED wins.';
  view.end(text, () => showDone(won));
}

// How the battle went, for the share text and picture.
function outcome(won) {
  const state = view.state;
  const left = (side) => (state?.[side].party ?? []).filter((p) => p !== 'fnt').length;
  const fainted = (side) => new Set(state?.[side].fainted ?? []);
  const practice = Boolean(practiceSeed) || !battle.official;
  return {
    won,
    ran: !won && battle.ran,
    practice,
    title: practice ? 'Daily Red (practice)' : `Daily Red No. ${dayNumber(battle.date)}`,
    turns: battle.turns ?? 0,
    left: left('p1'),
    redLeft: left('p2'),
    grid: (state?.p1.party ?? []).map((p) => (p === 'fnt' ? '⬛' : '🟥')).join(''),
    // The day's order (not the battle order, which would show the lead).
    team: teams.team.map((m) => ({ num: m.num, shiny: m.shiny, fainted: fainted('p1').has(m.num) })),
    red: teams.red.map((m) => ({ num: m.num, fainted: fainted('p2').has(m.num) })),
  };
}

function shareText(o) {
  const line = o.won ? `Beat RED with ${o.left} left`
    : o.ran ? `Ran from RED on turn ${o.turns || 1}`
    : `Lost to RED (he had ${o.redLeft} left)`;
  return `${o.title}\n${line}\n${o.grid}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function makeShareImage(o) {
  const streak = o.practice ? 0 : currentStreaks(stats, battle.date).winStreak;
  const detail = [
    o.won ? `${o.left} of 6 left` : o.ran ? null : `RED had ${o.redLeft} left`,
    o.turns ? plural(o.turns, 'turn') : null,
    streak > 1 ? `${streak}-day win streak` : null,
  ].filter(Boolean).join(' · ');
  const label = new Date(`${battle.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const canvas = await drawShareImage({
    title: o.title,
    date: o.practice ? '' : label,
    outcome: o.won ? 'won' : o.ran ? 'ran' : 'lost',
    headline: o.won ? 'Beat RED!' : o.ran ? `Ran from RED on turn ${o.turns || 1}` : 'Lost to RED',
    detail: detail || (o.ran ? 'Live to battle another day' : ''),
    team: o.team,
    red: o.red,
    footer: discord?.user?.name ?? 'Daily Red',
  });
  // A data: URL for the preview (Discord's Activity frame may not allow blob: images).
  return { blob: await canvasToBlob(canvas), url: canvas.toDataURL('image/png') };
}

let shareBlob = null;

// In a Discord server: where the battle leaves you in the month's race,
// once the server has the result.
async function showStanding(current) {
  ui.doneStanding.hidden = true;
  if (!current.official || !current.reported || !discord?.room) return;
  try {
    await current.reported;
    const { players } = await discord.board(current.date);
    if (battle !== current) return; // already left
    boardPlayers = players;
    const month = new Date(`${current.date}T12:00:00`).toLocaleDateString('en-US', { month: 'long' });
    ui.doneStanding.textContent = standingText(players, month);
    ui.doneStanding.hidden = !ui.doneStanding.textContent;
  } catch (err) {
    console.warn("Couldn't load the month's standings", err);
  }
}

async function showDone(won) {
  const o = outcome(won);
  ui.doneTitle.textContent = won ? 'You beat RED!' : 'RED won this time.';
  ui.shareText.textContent = shareText(o);
  ui.shareNote.hidden = true;
  ui.shareImage.hidden = true;
  ui.shareButton.hidden = true;
  ui.battleDone.hidden = false;
  ui.battleDone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showStanding(battle);
  shareBlob = null;
  try {
    const { blob, url } = await makeShareImage(o);
    if (ui.battleDone.hidden) return; // already left
    shareBlob = blob;
    ui.shareImage.src = url;
    ui.shareImage.alt = ui.shareText.textContent.replace(/\n/g, '. ');
    ui.shareImage.hidden = false;
    ui.shareButton.hidden = false;
  } catch (err) {
    console.warn("Couldn't draw the share picture", err);
  }
}

// Discord: its share dialog (desktop and web). Elsewhere: the phone's share
// sheet, or a download.
async function shareImage() {
  if (!shareBlob) return;
  const note = (text) => { ui.shareNote.textContent = text; ui.shareNote.hidden = !text; };
  const name = `daily-red-${battle?.date ?? 'result'}.png`;
  note('');
  ui.shareButton.disabled = true;
  try {
    if (discord?.shareImage) {
      await discord.shareImage(shareBlob);
      return;
    }
    const file = new File([shareBlob], name, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: ui.shareText.textContent });
      return;
    }
    const link = document.createElement('a');
    link.href = ui.shareImage.src;
    link.download = name;
    link.click();
  } catch (err) {
    if (err?.name === 'AbortError') return; // closed the share sheet
    console.warn('Sharing failed', err);
    note(inDiscord
      ? "Discord's share dialog isn't available here. Press and hold the picture to save it, or copy the text."
      : "Couldn't share the picture. Press and hold (or right-click) it to save it.");
  } finally {
    ui.shareButton.disabled = false;
  }
}

function leaveBattle() {
  detach();
  battle = null;
  stats = loadStats();
  if (date !== today() && !practiceSeed) loadDay();
  else {
    renderHome();
    setState('home');
  }
  window.scrollTo({ top: 0 });
}

function askToRun() {
  const dialog = $('run-dialog');
  $('run-dialog-text').textContent = battle?.official
    ? "Give up today's battle? It counts as a loss."
    : 'Give up this practice run?';
  dialog.returnValue = '';
  dialog.showModal();
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'run' && battle && !battle.done) {
      battle.ran = true;
      forfeit();
    }
  }, { once: true });
}

$('back-home').addEventListener('click', leaveBattle);
ui.shareButton.addEventListener('click', shareImage);
$('copy-result').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(ui.shareText.textContent);
    button.textContent = 'Copied!';
  } catch {
    // Clipboard blocked (e.g. inside Discord): select the text to copy by hand.
    const range = document.createRange();
    range.selectNodeContents(ui.shareText);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    button.textContent = 'Select and copy';
  }
  setTimeout(() => { button.textContent = 'Copy result'; }, 2000);
});

ui.play.addEventListener('click', () => beginBattle({ practice: false }));
ui.practice.addEventListener('click', () => beginBattle({ practice: true }));
$('retry').addEventListener('click', () => location.reload());

// An official battle in progress counts as a loss if the page closes.
window.addEventListener('beforeunload', (event) => {
  if (battle?.official && !battle.done) event.preventDefault();
});

// For debugging from the console and for the automated tests.
window.dailyRed = {
  get stats() { return { ...stats }; },
  get teams() { return teams; },
  get lead() { return lead; },
  setSpeed(next) { speed = next; renderSpeed(); },
  setAnimations(on) { animations = on; renderSpeed(); },
  // e.g. previewAnim({ kind: 'move', side: 'p1', target: 'p2', id: 'thunderbolt', type: 'Electric', category: 'Special' })
  previewAnim: (anim) => view.preview(anim),
};

// --- Inside Discord ----------------------------------------------------------------

// Links can't navigate the activity's frame: show our own text files in the
// page, and let Discord open the rest in the browser.
document.querySelector('.footer').addEventListener('click', async (event) => {
  const link = event.target.closest('a[href]');
  if (!inDiscord || !link) return;
  event.preventDefault();
  if (link.origin !== location.origin) {
    discord?.openLink(link.href);
    return;
  }
  const dialog = $('text-dialog');
  $('text-dialog-body').textContent = await fetch(link.href).then((r) => r.text()).catch(() => "Couldn't load it.");
  dialog.showModal();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && app.dataset.state === 'home') refreshBoard();
});

// --- Signed in on the website ---------------------------------------------------------

const linkedServer = /^\d{1,20}$/.test(new URLSearchParams(location.search).get('g') || '')
  ? new URLSearchParams(location.search).get('g') : null; // from the bot's "Play in browser"

// Which of the player's servers to play for: the bot's link, the last one
// picked, or the first.
function pickRoom(rooms) {
  const ids = rooms.map((r) => r.room);
  const room = [linkedServer && `g:${linkedServer}`, prefs.get('dailyred-room')].find((r) => r && ids.includes(r)) ?? ids[0] ?? null;
  if (room) prefs.set('dailyred-room', room);
  return room;
}

function showAccount(web, room) {
  ui.account.hidden = false;
  $('account-avatar').src = web.user.avatarUrl;
  $('account-name').textContent = web.user.name;
  $('account-note').hidden = web.rooms.length > 0;
  const select = $('account-room');
  select.hidden = web.rooms.length < 2;
  select.replaceChildren(...web.rooms.map((r) => {
    const option = el('option', '', r.name);
    option.value = r.room;
    option.selected = r.room === room;
    return option;
  }));
  select.onchange = () => {
    prefs.set('dailyred-room', select.value);
    location.href = `./?g=${select.value.slice(2)}`;
  };
}

// --- Start -------------------------------------------------------------------------

async function start() {
  if (inDiscord) {
    setState('loading');
    ui.loadingText.textContent = 'Signing in with Discord…';
    try {
      discord = await connectDiscord();
      useStatsStorage(discord.storage);
      ui.board.hidden = !discord.room;
      ui.boardHeading.textContent = discord.inServer ? 'Today in this server' : 'Today in this chat';
    } catch (err) {
      // Still playable: the stats stay in this browser, like on the website.
      console.error('Discord sign-in failed', err);
      ui.board.hidden = false;
      ui.boardNote.textContent = `Couldn't sign in with Discord (${err?.message || err}). Your stats are kept on this device for now.`;
    }
  } else if (!practiceSeed) {
    // The website: signed in with Discord (a cookie), or offer it.
    const web = await webSession().catch(() => null); // no server API: a plain website
    // The ▶️ link is for a server this sign-in doesn't know (the bot joined it
    // after you signed in): sign in again to pick it up. Discord remembers
    // you said yes, so it only takes a moment. Once per visit.
    const relogin = `dailyred-relogin:${linkedServer}`;
    let tried = true;
    try { tried = sessionStorage.getItem(relogin) === '1'; } catch { /* blocked: don't loop */ }
    if (web?.user && linkedServer && !web.rooms.some((r) => r.room === `g:${linkedServer}`) && !tried) {
      try { sessionStorage.setItem(relogin, '1'); } catch { /* fine */ }
      location.replace(`auth/login?g=${linkedServer}`);
      return;
    }
    if (web?.user) {
      setState('loading');
      ui.loadingText.textContent = 'Loading your stats…';
      try {
        const room = pickRoom(web.rooms);
        discord = await connectWeb(web, room);
        useStatsStorage(discord.storage);
        showAccount(web, room);
        ui.board.hidden = !room;
        const name = web.rooms.find((r) => r.room === room)?.name;
        ui.boardHeading.textContent = name ? `Today in ${name}` : 'Today in this server';
      } catch (err) {
        console.error('Signing in failed', err);
        signInFirst = web.available;
      }
    } else if (web?.available) {
      signInFirst = true;
      ui.signinLink.href = `auth/login${linkedServer ? `?g=${linkedServer}` : ''}`;
    }
  }
  stats = settleAbandonedGame(loadStats());
  await loadDay();
}

if (inDiscord) document.documentElement.dataset.host = 'discord';
renderSpeed();
start();
