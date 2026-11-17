// The Daily Red Cup's page for a server: cup.html?g=<server id>. Sign-ups on
// Monday, then the pool (with your wish list) and the live draft at 8 PM New
// York time. Everything comes from the server (activity/cup-week.mjs), which
// sends the whole Cup again whenever anything changes.
import { el, sprite, typeBadges, monCard } from './mon-card.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const params = new URLSearchParams(location.search);

let guild = params.get('g') ?? '';
let cup = null; // the server's view (cup-week.mjs view())
let offset = 0; // server clock - this clock
let sort = 'bst';
let hideTaken = false;
let shown = null; // pool index in the dialog

const prefs = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* not remembered */ } },
};
sort = prefs.get('dailyred-cup-sort') === 'dex' ? 'dex' : 'bst';

async function call(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { 'X-Daily-Red': '1', ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

function fail(heading, text, { signIn = false } = {}) {
  $('error-heading').textContent = heading;
  $('error-text').textContent = text;
  $('error-signin').hidden = !signIn;
  $('error-signin').href = `auth/login?g=${guild}&next=${encodeURIComponent(location.pathname + location.search)}`;
  app.dataset.state = 'error';
}

// A change: the server answers with the Cup as it is now.
async function act(path, body = {}) {
  try {
    show(await call('POST', `api/cup/${path}`, { g: guild, ...body }));
  } catch (err) {
    toast(err.message);
  }
}

let toastTimer = null;
function toast(text) {
  const box = $('cup-toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}

// --- Times -------------------------------------------------------------------------------

const serverNow = () => Date.now() + offset;
const clockTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const dayLabel = (week) => new Date(`${week}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// What the big clock counts down to.
function clockTarget() {
  if (!cup) return null;
  if (cup.next) return { at: cup.next.signupsOpen, label: 'Sign-ups open in' };
  if (cup.stage === 'signup') return { at: cup.times.signupsClose, label: 'Sign-ups close in' };
  if (cup.stage === 'pool') return { at: cup.times.draft, label: 'The draft starts in' };
  if (cup.stage === 'draft' && cup.deadline) return { at: cup.deadline, label: cup.onClock === cup.me.id ? 'Your pick: time left' : 'Time left for this pick' };
  return null;
}

function renderClock() {
  const target = clockTarget();
  $('cup-clock').hidden = !target;
  if (!target) return;
  const left = target.at - serverNow();
  $('cup-clock-label').textContent = target.label;
  $('cup-clock-time').textContent = countdown(left);
  $('cup-clock').dataset.urgent = String(cup.stage === 'draft' && left < 15000);
}
setInterval(renderClock, 250);

// --- The page ----------------------------------------------------------------------------

const player = (id) => cup.players.find((p) => p.id === id);
const nameOf = (id) => player(id)?.name ?? 'Someone';
const takenBy = () => new Map(cup.picks.map((p) => [p.pool, p.player]));
const myTurn = () => cup.stage === 'draft' && cup.onClock === cup.me.id;
const inDraft = () => cup.me.joined && ['pool', 'draft'].includes(cup.stage);

function show(next) {
  // Before sign-ups open there's only the schedule.
  cup = { players: [], picks: [], pool: null, ...next, me: { id: null, joined: false, wishlist: [], autodraft: false, ...next.me } };
  offset = cup.now - Date.now();
  app.dataset.state = 'hub';
  render();
}

function render() {
  const { stage, me } = cup;
  document.title = myTurn() ? 'Your pick! · Daily Red Cup' : 'Daily Red Cup';
  $('cup-label').textContent = `Week of ${dayLabel(cup.week)}`;
  const banner = {
    none: ['No Cup yet this week', 'Sign-ups open Monday at 6 AM ET: up to 8 players, then a live draft that night.'],
    signup: ['Sign-ups are open', `Up to ${cup.max} players (at least ${cup.min}). Sign-ups close at ${clockTime(cup.times?.signupsClose)} ET and the draft is tonight at ${clockTime(cup.times?.draft)} ET.`],
    cancelled: ['No Cup this week', cup.reason === 'too-few' ? `Only ${cup.players?.length} signed up, and the Cup needs ${cup.min}. Try again next Monday!` : 'Nobody signed up. Try again next Monday!'],
    pool: ['The pool is out', `The draft starts at ${clockTime(cup.times?.draft)} ET, ${cup.pickSeconds} seconds a pick. Look over the pool and rank a wish list: if your time runs out, the draft picks from it for you.`],
    draft: [myTurn() ? 'Your pick!' : `${cup.onClock ? nameOf(cup.onClock) : 'Someone'} is picking`, cup.pick ? `Round ${cup.pick.round} of 6 · pick ${cup.pick.overall} of ${cup.totalPicks}` : ''],
    drafted: ['The teams are set', 'Everyone has their six. The bracket starts Tuesday.'],
  }[stage] ?? ['Daily Red Cup', ''];
  if (cup.next && stage !== 'none') {
    banner[0] = `Last week: ${banner[0].toLowerCase()}`;
    banner[1] = 'Sign-ups for this week open Monday at 6 AM ET.';
  }
  $('cup-title').textContent = banner[0];
  $('cup-note').textContent = banner[1];
  // The pick just made, at the top (on a phone the board is further down).
  const last = cup.picks.at(-1);
  $('cup-last').hidden = !(last && stage === 'draft');
  if (last) $('cup-last').textContent = `Last pick: ${nameOf(last.player)} took ${cup.pool[last.pool].species}${last.auto ? ' (auto)' : ''}`;
  $('cup-hub').dataset.stage = stage;
  $('cup-hub').dataset.myTurn = String(myTurn());

  // Join / Leave / Autodraft.
  const actions = $('cup-actions');
  actions.replaceChildren();
  if (stage === 'signup' && !cup.next) {
    if (me.joined) {
      actions.append(el('span', 'cup-in', "✓ You're in"));
      const leave = el('button', 'button button-small', 'Leave');
      leave.type = 'button';
      leave.addEventListener('click', () => act('leave'));
      actions.append(leave);
    } else if (cup.players.length < cup.max) {
      const join = el('button', 'button button-primary', 'Join this week’s Cup');
      join.type = 'button';
      join.id = 'cup-join';
      join.addEventListener('click', () => act('join'));
      actions.append(join);
    } else {
      actions.append(el('span', 'cup-in', `Full: ${cup.max} players`));
    }
  }
  if (inDraft()) {
    const label = el('label', 'cup-autodraft');
    const box = el('input');
    box.type = 'checkbox';
    box.id = 'cup-autodraft';
    box.checked = me.autodraft;
    box.addEventListener('change', () => act('autodraft', { on: box.checked }));
    label.append(box, ' Autodraft: pick from my wish list straight away (for when you can’t be here)');
    actions.append(label);
  }
  actions.hidden = !actions.childElementCount;

  renderPlayers();
  renderWishlist();
  renderPool();
  renderLog();
  renderClock();
  if (shown != null) renderDialog();
}

// Sign-ups (in the order they joined), then the draft order with each
// player's picks so far.
function renderPlayers() {
  const list = $('cup-players');
  list.replaceChildren();
  const drafting = Boolean(cup.pool);
  $('cup-players-title').textContent = drafting ? 'Draft order' : `Players (${cup.players?.length ?? 0} of ${cup.max})`;
  $('cup-players-section').hidden = !cup.players?.length;
  for (const [i, p] of (cup.players ?? []).entries()) {
    const row = el('li', 'cup-player');
    if (p.id === cup.me.id) row.classList.add('is-you');
    if (cup.onClock === p.id) row.classList.add('on-clock');
    const avatar = el('img', 'board-avatar');
    avatar.alt = '';
    if (p.avatarUrl) avatar.src = p.avatarUrl;
    const name = el('span', 'cup-player-name', `${drafting ? `${i + 1}. ` : ''}${p.name}`);
    if (p.autodraft) name.append(el('span', 'cup-tag', 'AUTO'));
    if (cup.onClock === p.id) name.append(el('span', 'cup-tag cup-tag-clock', 'PICKING'));
    row.append(avatar, name);
    if (drafting) {
      const slots = el('span', 'cup-slots');
      const mine = cup.picks.filter((pick) => pick.player === p.id);
      for (let n = 0; n < 6; n++) {
        const pick = mine[n];
        if (pick) {
          const mon = cup.pool[pick.pool];
          const img = sprite(mon, 'cup-slot');
          img.width = img.height = 40;
          const open = el('button', 'cup-slot-button');
          open.type = 'button';
          open.title = mon.species;
          open.setAttribute('aria-label', `${p.name}'s ${mon.species}`);
          open.addEventListener('click', () => openMon(pick.pool));
          open.append(img);
          slots.append(open);
        } else {
          slots.append(el('span', 'cup-slot cup-slot-empty'));
        }
      }
      row.append(slots);
    }
    list.append(row);
  }
}

function renderWishlist() {
  const section = $('cup-wish-section');
  section.hidden = !inDraft();
  if (section.hidden) return;
  const list = $('cup-wish');
  list.replaceChildren();
  const taken = takenBy();
  const wish = cup.me.wishlist;
  $('cup-wish-empty').hidden = wish.length > 0;
  wish.forEach((index, i) => {
    const mon = cup.pool[index];
    const row = el('li', 'cup-wish-row');
    if (taken.has(index)) row.classList.add('is-taken');
    const img = sprite(mon, 'cup-wish-sprite');
    img.width = img.height = 40;
    const name = el('button', 'link-button cup-wish-name', mon.species);
    name.type = 'button';
    name.addEventListener('click', () => openMon(index));
    row.append(el('span', 'cup-wish-rank', String(i + 1)), img, name);
    if (taken.has(index)) row.append(el('span', 'cup-wish-gone', `→ ${nameOf(taken.get(index))}`));
    const tools = el('span', 'cup-wish-tools');
    for (const [label, title, move] of [['↑', 'Higher', -1], ['↓', 'Lower', 1], ['✕', 'Remove', 0]]) {
      const b = el('button', 'button button-small', label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', `${title}: ${mon.species}`);
      b.disabled = (move === -1 && i === 0) || (move === 1 && i === wish.length - 1);
      b.addEventListener('click', () => {
        const next = wish.slice();
        if (move === 0) next.splice(i, 1);
        else [next[i], next[i + move]] = [next[i + move], next[i]];
        saveWishlist(next);
      });
      tools.append(b);
    }
    row.append(tools);
    list.append(row);
  });
}

function saveWishlist(list) {
  cup.me.wishlist = list; // straight away; the server confirms
  render();
  act('wishlist', { list });
}

function toggleWish(index) {
  const wish = cup.me.wishlist;
  saveWishlist(wish.includes(index) ? wish.filter((i) => i !== index) : [...wish, index]);
}

function pick(index) {
  act('pick', { index });
}

// Buttons for a Pokémon in the pool: Draft (your pick) and the wish list.
function monButtons(index, { compact = false } = {}) {
  const taken = takenBy();
  const out = [];
  if (taken.has(index)) {
    out.push(el('span', 'cup-taken', `→ ${nameOf(taken.get(index))}`));
    return out;
  }
  if (myTurn()) {
    const b = el('button', 'button button-primary button-small cup-draft', 'Draft');
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); pick(index); closeDialog(); });
    out.push(b);
  }
  if (inDraft()) {
    const wished = cup.me.wishlist.includes(index);
    const b = el('button', 'button button-small cup-wish-toggle', wished ? (compact ? '★' : '★ On your list') : (compact ? '☆' : '☆ Wish list'));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(wished));
    b.setAttribute('aria-label', `${wished ? 'Remove from' : 'Add to'} wish list: ${cup.pool[index].species}`);
    b.addEventListener('click', (e) => { e.stopPropagation(); toggleWish(index); });
    out.push(b);
  }
  return out;
}

function renderPool() {
  const section = $('cup-pool-section');
  section.hidden = !cup.pool || cup.stage === 'drafted'; // all on teams by then: see the board
  if (section.hidden) return;
  const taken = takenBy();
  $('cup-pool-count').textContent = `${cup.pool.length - taken.size} of ${cup.pool.length} left`;
  const order = cup.pool.map((_, i) => i);
  if (sort === 'bst') order.sort((a, b) => cup.pool[b].bst - cup.pool[a].bst || a - b);
  else order.sort((a, b) => cup.pool[a].num - cup.pool[b].num || a - b);
  const grid = $('cup-pool');
  grid.replaceChildren();
  for (const index of order) {
    if (hideTaken && taken.has(index)) continue;
    const mon = cup.pool[index];
    const tile = el('li', 'pool-mon');
    tile.dataset.index = String(index);
    if (taken.has(index)) tile.classList.add('is-taken');
    if (cup.me.wishlist.includes(index)) tile.classList.add('is-wished');
    const open = el('button', 'pool-open');
    open.type = 'button';
    open.setAttribute('aria-label', `${mon.species}: details`);
    open.addEventListener('click', () => openMon(index));
    const img = sprite(mon, 'pool-sprite');
    const text = el('span', 'pool-text');
    const name = el('span', 'pool-name', mon.species);
    if (mon.shiny) name.append(el('span', 'mon-shiny', '★'));
    text.append(name, typeBadges(mon.types), el('span', 'pool-facts', `${mon.item} · BST ${mon.bst}`));
    open.append(img, text);
    const buttons = el('span', 'pool-buttons');
    buttons.append(...monButtons(index, { compact: true }));
    tile.append(open, buttons);
    grid.append(tile);
  }
}

function renderLog() {
  const section = $('cup-log-section');
  section.hidden = !cup.picks.length;
  const list = $('cup-log');
  list.replaceChildren();
  const players = cup.players.length;
  [...cup.picks].reverse().forEach((p, i) => {
    const n = cup.picks.length - i;
    const mon = cup.pool[p.pool];
    const row = el('li', 'cup-log-row', `${Math.ceil(n / players)}.${((n - 1) % players) + 1}  ${nameOf(p.player)} took ${mon.species}${p.auto ? ' (auto)' : ''}`);
    list.append(row);
  });
}

// The full card of one Pokémon in the pool.
function openMon(index) {
  shown = index;
  renderDialog();
  const dialog = $('mon-dialog');
  if (!dialog.open) dialog.showModal();
}

function renderDialog() {
  const mon = cup.pool?.[shown];
  if (!mon) return closeDialog();
  $('mon-dialog-card').replaceChildren(monCard(mon));
  $('mon-dialog-buttons').replaceChildren(...monButtons(shown));
}

function closeDialog() {
  shown = null;
  if ($('mon-dialog').open) $('mon-dialog').close();
}
$('mon-dialog').addEventListener('close', () => { shown = null; });
$('mon-dialog-close').addEventListener('click', closeDialog);

$('cup-sort').value = sort;
$('cup-sort').addEventListener('change', () => {
  sort = $('cup-sort').value;
  prefs.set('dailyred-cup-sort', sort);
  renderPool();
});
$('cup-hide-taken').addEventListener('change', () => {
  hideTaken = $('cup-hide-taken').checked;
  renderPool();
});

// Live: the server sends the whole Cup on every change.
function listen() {
  const source = new EventSource(`api/cup/events?g=${guild}`);
  source.onmessage = (message) => show(JSON.parse(message.data));
  // EventSource reconnects by itself; the next message brings it up to date.
}

export async function startHub() {
  if (!/^\d{1,20}$/.test(guild)) {
    // No server in the link: the one you're in, if there's just one.
    const session = await call('GET', 'api/web/session').catch(() => null);
    const rooms = (session?.rooms ?? []).filter((r) => r.room?.startsWith('g:'));
    if (rooms.length === 1) {
      guild = rooms[0].room.slice(2);
      history.replaceState(null, '', `?g=${guild}`);
    } else if (!session?.user) {
      fail('Sign in for the Cup', 'The Daily Red Cup is for your Discord server: sign in to join.', { signIn: true });
      return;
    } else {
      fail('Which server?', "Open the Cup from the link in your server's Discord channel.");
      return;
    }
  }
  try {
    show(await call('GET', `api/cup?g=${guild}`));
  } catch (err) {
    if (err.status === 401) fail('Sign in for the Cup', 'The Daily Red Cup is for your Discord server: sign in to join.', { signIn: true });
    else if (err.status === 403) fail("You're not in that server", 'Sign in with the Discord account that’s in the server.', { signIn: true });
    else fail('Something went wrong', err.message);
    return;
  }
  listen();
}

// For the automated tests.
window.dailyRedCupHub = { get cup() { return cup; } };
