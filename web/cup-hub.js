// The Daily Red Cup's page for a server: cup.html?g=<server id>. A Cup a
// month: sign-ups from the 25th, then on the 1st the pool (with your wish
// list) and the live draft at 8 PM New York time, then the bracket: your
// match and its Battle button, your lead, every round's results. Everything comes from the server (activity/cup-month.mjs), which
// sends the whole Cup again whenever anything changes.
import { el, sprite, typeBadges, monCard } from './mon-card.js';

const $ = (id) => document.getElementById(id);
const app = document.querySelector('.app');
const params = new URLSearchParams(location.search);

let guild = params.get('g') ?? '';
let cup = null; // the server's view (cup-month.mjs view())
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
const dayLabel = (ms) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const monthName = (month) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
const monthLabel = (month) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function countdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// What the big clock counts down to.
function clockTarget() {
  if (!cup) return null;
  if (['none', 'cancelled'].includes(cup.stage)) {
    const next = cup.times && serverNow() < cup.times.signupsOpen ? cup.times : cup.next;
    return next && { at: next.signupsOpen, label: `Sign-ups for ${monthName(next.month ?? cup.month)} open in` };
  }
  if (cup.stage === 'signup') return { at: cup.times.signupsClose, label: 'Sign-ups close in' };
  if (cup.stage === 'pool') return { at: cup.times.draft, label: 'The draft starts in' };
  if (cup.stage === 'draft' && cup.deadline) return { at: cup.deadline, label: cup.onClock === cup.me.id ? 'Your pick: time left' : 'Time left for this pick' };
  if (cup.stage === 'drafted' && serverNow() < cup.times.bracket) return { at: cup.times.bracket, label: 'The bracket starts in' };
  if (cup.stage === 'bracket') {
    const mine = cup.bracket.mine;
    if (mine) return { at: mine.deadline, label: 'Your match: time left' };
    const round = currentRound();
    return round && { at: round.ends, label: `Round ${round.slot} ends in` };
  }
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
const inBracket = () => Boolean(cup.bracket) && ['drafted', 'bracket', 'done'].includes(cup.stage);
// The round whose deadline is next.
const currentRound = () => cup.bracket?.slots.find((s) => s.ends > serverNow()) ?? null;
// "Fri, Dec 4" for a deadline at midnight starting Dec 5.
const lastDay = (ms) => dayLabel(ms - 60 * 1000);
const playBy = (ms) => `11:59 PM ET on ${lastDay(ms)}`;
const matchById = (id) => cup.bracket.matches.find((m) => m.id === id);

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
  $('cup-label').textContent = monthLabel(cup.month);
  const nextOpen = cup.next ? `Sign-ups for ${monthName(cup.next.month)} open ${dayLabel(cup.next.signupsOpen)} at 6 AM ET.` : '';
  const banner = {
    none: [`The ${monthName(cup.month)} Cup`, `Sign-ups open on the 25th of each month at 6 AM ET: up to ${cup.max} players, then a live draft on the 1st.`],
    signup: [`Sign-ups are open for ${monthName(cup.month)}`, `Up to ${cup.max} players (at least ${cup.min}). Sign-ups close ${dayLabel(cup.times?.signupsClose)} at ${clockTime(cup.times?.signupsClose)} ET, and the live draft is that night at ${clockTime(cup.times?.draft)} ET. Then a double-elimination bracket all month, a round every ${cup.roundDays} days.`],
    cancelled: [`No Cup in ${monthName(cup.month)}`, `${cup.reason === 'too-few' ? `Only ${cup.players?.length} signed up, and the Cup needs ${cup.min}.` : 'Nobody signed up.'} ${nextOpen}`],
    pool: ['The pool is out', `The draft starts tonight at ${clockTime(cup.times?.draft)} ET, ${cup.pickSeconds} seconds a pick. Look over the pool and rank a wish list: if your time runs out, the draft picks from it for you.`],
    draft: [myTurn() ? 'Your pick!' : `${cup.onClock ? nameOf(cup.onClock) : 'Someone'} is picking`, cup.pick ? `Round ${cup.pick.round} of 6 · pick ${cup.pick.overall} of ${cup.totalPicks}` : ''],
    drafted: ['The teams are set', `Everyone has their six for ${monthName(cup.month)}. The bracket starts ${dayLabel(cup.times?.bracket)}: a round every ${cup.roundDays} days. Pick your lead below.`],
    bracket: bracketBanner(),
    done: [`${nameOf(cup.champion)} wins the ${monthName(cup.month)} Cup! 🏆`, `They wear the 🏆 until the next champion. ${nextOpen}`],
  }[stage] ?? ['Daily Red Cup', ''];
  $('cup-title').textContent = banner[0];
  $('cup-note').textContent = banner[1];
  // The pick just made, at the top (on a phone the board is further down).
  const last = cup.picks.at(-1);
  $('cup-last').hidden = !(last && stage === 'draft');
  if (last) $('cup-last').textContent = `Last pick: ${nameOf(last.player)} took ${cup.pool[last.pool].species}${last.auto ? ' (auto)' : ''}`;
  $('cup-hub').dataset.stage = stage;
  $('cup-hub').dataset.myTurn = String(myTurn() || Boolean(stage === 'bracket' && cup.bracket?.mine));
  const reigning = cup.reigning && cup.reigning.month !== cup.month ? cup.reigning : null;
  $('cup-reigning').hidden = !reigning;
  if (reigning) $('cup-reigning').textContent = `🏆 Reigning champion: ${reigning.name} (${monthName(reigning.month)})`;

  // Join / Leave / Autodraft.
  const actions = $('cup-actions');
  actions.replaceChildren();
  if (stage === 'signup') {
    if (me.joined) {
      actions.append(el('span', 'cup-in', "✓ You're in"));
      const leave = el('button', 'button button-small', 'Leave');
      leave.type = 'button';
      leave.addEventListener('click', () => act('leave'));
      actions.append(leave);
    } else if (cup.players.length < cup.max) {
      const join = el('button', 'button button-primary', `Join the ${monthName(cup.month)} Cup`);
      join.type = 'button';
      join.id = 'cup-join';
      join.addEventListener('click', () => act('join'));
      actions.append(join);
    } else {
      actions.append(el('span', 'cup-in', `Full: ${cup.max} players`));
    }
  }
  if (stage === 'bracket' && cup.bracket.mine) {
    const { mine } = cup.bracket;
    const battle = el('button', 'button button-primary button-battle', mine.battleId ? 'Continue your battle' : `Battle ${nameOf(mine.opponent)}`);
    battle.type = 'button';
    battle.id = 'cup-battle';
    battle.addEventListener('click', () => play(battle));
    actions.append(battle);
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

  renderSignup();
  renderPlayers();
  renderTeam();
  renderBracket();
  renderWishlist();
  renderPool();
  renderLog();
  renderClock();
  if (shown != null) renderDialog();
}

// The banner during the bracket: your match, or where you stand.
function bracketBanner() {
  if (!cup.bracket) return ['', ''];
  const { mine, next, standings } = cup.bracket;
  const me = standings[cup.me.id];
  if (mine) {
    const again = mine.draws ? ` Your last battle was a draw: play it again.` : '';
    return [`Your match: vs ${nameOf(mine.opponent)}`, `${mine.label}, one battle. Play by ${playBy(mine.deadline)}: if time runs out, whoever's holding it up loses, and if it never started, a coin toss decides.${again}`];
  }
  if (next) {
    const feeder = next.waitingOn && matchById(next.waitingOn);
    const waiting = feeder?.players.every((p) => p && p !== 'bye') ? ` Waiting for ${nameOf(feeder.players[0])} vs ${nameOf(feeder.players[1])}.` : '';
    return [`You're through to the ${next.label}`, `${waiting} Your opponent's still being decided.`.trim()];
  }
  if (me?.status === 'out') return ["You're out", `${me.wins}–${me.losses} this month. Watch the rest of the bracket below.`];
  const round = currentRound();
  return [`The ${monthName(cup.month)} bracket`, round ? `Round ${round.slot} of ${cup.bracket.slots.length} ends at ${playBy(round.ends)}.` : ''];
}

async function play(button) {
  button.disabled = true;
  try {
    const { battleId } = await call('POST', 'api/cup/play', { g: guild });
    location.href = `cup.html?b=${battleId}&g=${guild}`;
  } catch (err) {
    button.disabled = false;
    toast(err.message);
  }
}

// Next month's sign-ups, while this month's bracket is still on.
function renderSignup() {
  const box = $('cup-signup');
  const next = cup.signup;
  box.hidden = !next || next.stage !== 'signup';
  if (box.hidden) return;
  $('cup-signup-text').textContent = `Sign-ups for the ${monthName(next.month)} Cup are open until ${dayLabel(next.times.signupsClose)} at ${clockTime(next.times.signupsClose)} ET (${next.players.length} of ${next.max} so far).`;
  const button = $('cup-signup-button');
  button.textContent = next.me.joined ? "✓ You're in · Leave" : `Join the ${monthName(next.month)} Cup`;
  button.classList.toggle('button-primary', !next.me.joined);
  button.onclick = () => act(next.me.joined ? 'leave' : 'join');
}

// Your six, and which one leads (for battles you start from now on).
function renderTeam() {
  const section = $('cup-team-section');
  const team = cup.me.team ?? [];
  section.hidden = !(inBracket() && cup.stage !== 'done' && team.length);
  if (section.hidden) return;
  const list = $('cup-team');
  list.replaceChildren();
  team.forEach((index, i) => {
    const mon = cup.pool[index];
    const tile = el('li', 'pool-mon');
    if (i === cup.me.lead) tile.classList.add('is-lead');
    const open = el('button', 'pool-open');
    open.type = 'button';
    open.setAttribute('aria-label', `${mon.species}: details`);
    open.addEventListener('click', () => openMon(index));
    const text = el('span', 'pool-text');
    text.append(el('span', 'pool-name', mon.species), typeBadges(mon.types), el('span', 'pool-facts', `${mon.item} · ${mon.ability}`));
    open.append(sprite(mon, 'pool-sprite'), text);
    const side = el('span', 'pool-buttons');
    if (i === cup.me.lead) {
      side.append(el('span', 'lead-badge', 'LEAD'));
    } else {
      const lead = el('button', 'button button-small set-lead', 'Lead');
      lead.type = 'button';
      lead.setAttribute('aria-label', `Lead with ${mon.species}`);
      lead.addEventListener('click', () => act('lead', { index: i }));
      side.append(lead);
    }
    tile.append(open, side);
    list.append(tile);
  });
}

// What happened in a match, in a few words.
function matchNote(m) {
  if (m.winner && m.winner !== 'bye') {
    const loser = nameOf(m.loser);
    return {
      battle: [m.details?.left != null && `${m.details.left} left`, m.details?.turns && `${m.details.turns} turns`].filter(Boolean).join(' · '),
      'gave up': `${loser} gave up`,
      timeout: `Time ran out on ${loser}`,
      'no-show': 'Nobody battled: coin toss',
    }[m.how] ?? '';
  }
  if (m.battleId) return 'Battling now';
  if (m.players.every((p) => p && p !== 'bye')) return m.draws ? 'A draw: playing again' : 'Not started yet';
  if (m.id === 'F2') return "Only if the losers' side wins the grand final";
  return '';
}

// Every round: its matches, who won, and links to watch.
function renderBracket() {
  const section = $('cup-bracket-section');
  section.hidden = !inBracket();
  if (section.hidden) return;
  const rounds = $('cup-bracket');
  rounds.replaceChildren();
  const source = (src) => {
    const m = src.match && matchById(src.match);
    if (src.reset) return 'From the grand final';
    return m ? `${src.take === 'winner' ? 'Winner' : 'Loser'} of ${m.label}` : 'To be decided';
  };
  for (const { slot, ends } of cup.bracket.slots) {
    const matches = cup.bracket.matches.filter((m) => m.slot === slot && m.how !== 'bye' && m.how !== 'not needed');
    if (!matches.length) continue;
    const round = el('section', 'bracket-round');
    const now = currentRound()?.slot === slot && cup.stage === 'bracket';
    round.append(el('h3', 'bracket-round-title', `Round ${slot}${now ? ' · now' : ''} · until ${playBy(ends)}`));
    const list = el('ul', 'bracket-matches');
    for (const m of matches) {
      const card = el('li', 'bracket-match');
      card.dataset.match = m.id;
      if (m.players.includes(cup.me.id)) card.classList.add('is-yours');
      if (m.battleId && !m.winner) card.classList.add('is-live');
      card.append(el('p', 'bracket-label', m.label));
      m.players.forEach((p, i) => {
        const row = el('p', 'bracket-player');
        if (p && p !== 'bye') {
          const who = player(p);
          const avatar = el('img', 'board-avatar');
          avatar.alt = '';
          if (who?.avatarUrl) avatar.src = who.avatarUrl;
          row.append(avatar, el('span', 'bracket-name', nameOf(p)));
          if (m.winner === p) row.classList.add('is-winner');
          if (m.winner && m.winner !== p) row.classList.add('is-loser');
        } else {
          row.append(el('span', 'bracket-tbd', source(m.from[i])));
        }
        card.append(row);
      });
      const note = matchNote(m);
      const foot = el('p', 'bracket-note', note);
      if (m.battleId) {
        const watch = el('a', 'bracket-watch', m.winner ? 'Replay' : 'Watch');
        watch.href = `cup.html?b=${m.battleId}&g=${guild}`;
        foot.append(' ', watch);
      }
      if (note || m.battleId) card.append(foot);
      list.append(card);
    }
    round.append(list);
    rounds.append(round);
  }
}

// Sign-ups (in the order they joined), then the draft order with each
// player's picks so far, then (in the bracket) the standings.
function renderPlayers() {
  const list = $('cup-players');
  list.replaceChildren();
  const drafting = Boolean(cup.pool);
  const table = inBracket() && cup.stage !== 'drafted' ? cup.bracket.standings : null;
  $('cup-players-title').textContent = table ? 'Standings' : drafting ? (cup.stage === 'drafted' ? 'Teams' : 'Draft order') : `Players (${cup.players?.length ?? 0} of ${cup.max})`;
  $('cup-players-section').hidden = !cup.players?.length;
  const rank = { champion: 0, winners: 1, losers: 2, out: 3 };
  const players = table
    ? [...cup.players].sort((x, y) => rank[table[x.id].status] - rank[table[y.id].status] || table[y.id].wins - table[x.id].wins || table[x.id].losses - table[y.id].losses)
    : cup.players ?? [];
  for (const [i, p] of players.entries()) {
    const row = el('li', 'cup-player');
    if (p.id === cup.me.id) row.classList.add('is-you');
    if (cup.onClock === p.id) row.classList.add('on-clock');
    const avatar = el('img', 'board-avatar');
    avatar.alt = '';
    if (p.avatarUrl) avatar.src = p.avatarUrl;
    const name = el('span', 'cup-player-name', `${drafting && !table ? `${i + 1}. ` : ''}${p.name}`);
    if (p.autodraft && !table) name.append(el('span', 'cup-tag', 'AUTO'));
    if (cup.onClock === p.id) name.append(el('span', 'cup-tag cup-tag-clock', 'PICKING'));
    if (table) {
      const row2 = table[p.id];
      const tag = el('span', `cup-tag cup-status-${row2.status}`, { champion: '🏆 CHAMPION', winners: 'WINNERS', losers: 'LOSERS', out: 'OUT' }[row2.status]);
      name.append(el('span', 'cup-record', ` ${row2.wins}–${row2.losses}`), tag);
    }
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
  section.hidden = !cup.pool || !['pool', 'draft'].includes(cup.stage); // all on teams after: see the board
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
  section.hidden = !cup.picks.length || !['draft', 'drafted'].includes(cup.stage);
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
