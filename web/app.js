// Website controller: today's page (your six, the lead picker, RED's team,
// your stats) and the battle. The battle itself runs on Pokémon Showdown's
// simulator in a Web Worker (battle/worker.js); battle/view.js draws it.
// Inside a Discord Activity, discord.js adds sign-in, stats kept on the
// server and the "Today in this server" list.
import {
  today, dailySeed, msUntilTomorrow, loadStats, resultFor, currentStreaks,
  markBattleStarted, recordResult, settleAbandonedGame, useStatsStorage,
} from './daily.js';
import { inDiscord, connectDiscord, renderBoard } from './discord.js';
import { loadTeams, startBattle, choose, forfeit, detach } from './battle/engine.js';
import { createBattleView, spriteUrl } from './battle/view.js';

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
  shareText: $('share-text'),
};

// The first day of Daily Red, for the "No." in the header.
const FIRST_DAY = '2026-11-01';

// ?seed=123 shows the team for that seed instead of today's, for testing and
// for fun: nothing is recorded and there's no daily limit.
const practiceSeed = parseSeed(new URLSearchParams(location.search).get('seed'));

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
let discord = null; // the Discord session (discord.js) inside an activity
let date = null; // the day the page shows
let seed = null;
let teams = null; // { team, red } from the engine
let lead = 0;
let battle = null; // { official, date, done }
let speed = prefs.get('dailyred-speed') === 'fast' ? 'fast' : 'normal';

function setState(state) {
  app.dataset.state = state;
  if (state !== 'battle') document.title = 'Daily Red';
}

// --- Header ------------------------------------------------------------------------

const DAY = 86400000;

function dayNumber(day) {
  return Math.round((new Date(`${day}T12:00:00`) - new Date(`${FIRST_DAY}T12:00:00`)) / DAY) + 1;
}

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
  ui.play.hidden = Boolean(result);
  ui.played.hidden = !result;
  ui.practiceNote.hidden = !practiceSeed;
  ui.practice.hidden = Boolean(practiceSeed);
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

async function refreshBoard() {
  if (!discord?.room) return;
  clearTimeout(boardTimer);
  try {
    const { players } = await discord.board(today());
    renderBoard(ui.boardList, players);
    ui.boardNote.textContent = players.length ? '' : 'Nobody has played here yet. Be the first to battle RED!';
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
});

function renderSpeed() {
  for (const button of document.querySelectorAll('[data-speed]')) {
    button.setAttribute('aria-pressed', String(button.dataset.speed === speed));
  }
}
for (const button of document.querySelectorAll('[data-speed]')) {
  button.addEventListener('click', () => {
    speed = button.dataset.speed;
    prefs.set('dailyred-speed', speed);
    renderSpeed();
  });
}

async function beginBattle({ practice }) {
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
      if (turn) ui.turnLabel.textContent = `Turn ${turn}`;
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
    discord?.report('result', battle.date, won);
  }
  const text = won ? 'You defeated RED!'
    : tie ? 'Both last Pokémon fell at once. A draw counts as a loss.'
    : battle.ran ? 'You gave up. RED wins.'
    : 'Your team was wiped out. RED wins.';
  view.end(text, () => showDone(won));
}

function shareText(won) {
  const left = (view.state?.p1.party ?? []).map((p) => (p === 'fnt' ? '⬛' : '🟥'));
  const redLeft = (view.state?.p2.party ?? []).filter((p) => p !== 'fnt').length;
  const head = practiceSeed || !battle.official ? 'Daily Red (practice)' : `Daily Red No. ${dayNumber(battle.date)}`;
  const line = won
    ? `Beat RED with ${left.filter((x) => x === '🟥').length} left`
    : `Lost to RED (he had ${redLeft} left)`;
  return `${head}\n${line}\n${left.join('')}`;
}

function showDone(won) {
  ui.doneTitle.textContent = won ? 'You beat RED!' : 'RED won this time.';
  ui.shareText.textContent = shareText(won);
  ui.battleDone.hidden = false;
  ui.battleDone.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  }
  stats = settleAbandonedGame(loadStats());
  await loadDay();
}

if (inDiscord) document.documentElement.dataset.host = 'discord';
renderSpeed();
start();
