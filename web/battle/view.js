import { createFx } from './fx.js';

// The battle screen: a FireRed-style scene (RED's Pokémon top right, yours
// bottom left, an info box for each), the message box and move menu under it,
// and the battle log. It plays the engine's events one at a time (text types
// out, HP bars drain) and shows the menus when the engine asks for a choice.

const SPEEDS = {
  normal: { perChar: 22, hold: 750, bar: 650, anim: 1 },
  fast: { perChar: 6, hold: 260, bar: 320, anim: 0.6 },
};

const STATUS_LABEL = { par: 'PAR', slp: 'SLP', psn: 'PSN', tox: 'PSN', brn: 'BRN', frz: 'FRZ', fnt: 'FNT' };
const EFFECT_LABEL = { super: 'Super effective', weak: 'Not very effective', none: 'No effect', normal: 'Normal damage' };
// Shorter, for the move buttons.
const EFFECT_SHORT = { super: 'Effective', weak: 'Weak', none: 'No effect', normal: '' };

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export const spriteUrl = (num, { back = false, shiny = false } = {}) =>
  `sprites/${back ? 'back' : 'front'}${shiny ? '-shiny' : ''}/${num}.png`;

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));


function infoBox(side) {
  const box = el('div', `infobox infobox-${side}`);
  box.hidden = true;
  const top = el('div', 'ib-top');
  const name = el('span', 'ib-name');
  const gender = el('span', 'ib-gender');
  const level = el('span', 'ib-level');
  top.append(name, gender, level);
  const hp = el('div', 'hp');
  const track = el('div', 'hp-track');
  const fill = el('div', 'hp-fill');
  track.append(fill);
  hp.append(el('span', 'hp-label', 'HP'), track);
  const bottom = el('div', 'ib-bottom');
  const status = el('span', 'status-badge');
  const balls = el('ol', 'balls');
  balls.setAttribute('aria-label', 'Party');
  for (let i = 0; i < 6; i++) balls.append(el('li', 'ball'));
  const numbers = el('span', 'hp-numbers');
  bottom.append(status, balls, numbers);
  box.append(top, hp, bottom);
  return { box, name, gender, level, fill, status, balls, numbers, shown: null, hpShown: null };
}

export function createBattleView(root, { onChoose, onRun, getSpeed, getAnimations = () => true }) {
  root.replaceChildren();
  root.classList.add('battle-view');

  // --- Scene ---------------------------------------------------------------------
  const scene = el('div', 'scene');
  scene.append(el('div', 'scene-sky'), el('div', 'scene-mountains'), el('div', 'scene-ground'));
  const foePlatform = el('div', 'platform platform-foe');
  const youPlatform = el('div', 'platform platform-you');
  const foeSprite = el('img', 'sprite sprite-foe');
  const youSprite = el('img', 'sprite sprite-you');
  for (const img of [foeSprite, youSprite]) {
    img.alt = '';
    img.width = img.height = 64;
    img.hidden = true;
    img.decoding = 'async';
  }
  const foe = infoBox('foe');
  const you = infoBox('you');
  scene.append(foePlatform, youPlatform, foeSprite, youSprite, foe.box, you.box, el('div', 'scene-snow'));

  // --- Panel: message box / commands / party ---------------------------------------
  const panel = el('div', 'panel');
  const message = el('div', 'message');
  message.setAttribute('aria-live', 'polite');
  const messageText = el('p', 'message-text');
  message.append(messageText);

  const commands = el('div', 'commands');
  commands.hidden = true;
  const commandsHead = el('div', 'commands-head');
  const prompt = el('span', 'prompt');
  const abilityLabel = el('span', 'ability');
  commandsHead.append(prompt, abilityLabel);
  const moveGrid = el('div', 'moves');
  commands.append(commandsHead, moveGrid);

  const actions = el('div', 'actions');
  actions.hidden = true;
  const pokemonButton = el('button', 'action', 'POKéMON');
  const runButton = el('button', 'action', 'RUN');
  pokemonButton.type = runButton.type = 'button';
  actions.append(pokemonButton, runButton);

  const party = el('div', 'party');
  party.hidden = true;
  const partyHead = el('p', 'party-head');
  const partyList = el('ol', 'party-list');
  const partyCancel = el('button', 'action party-cancel', 'CANCEL');
  partyCancel.type = 'button';
  party.append(partyHead, partyList, partyCancel);

  // One Pokémon's summary: moves, item, ability, stats (yours or RED's).
  const summary = el('div', 'summary');
  summary.hidden = true;

  panel.append(message, commands, actions, party, summary);

  const frame = el('div', 'battle-frame');
  frame.append(scene, panel);

  // --- Log ---------------------------------------------------------------------------
  const log = el('section', 'battle-log');
  const logHead = el('div', 'log-head');
  const logTitle = el('h2', 'log-title', 'Battle log');
  const remaining = el('span', 'log-remaining');
  logHead.append(logTitle, remaining);
  const logList = el('ol', 'log-list');
  log.append(logHead, logList);

  root.append(frame, log);

  // --- State -------------------------------------------------------------------------
  const queue = [];
  let playing = false;
  let request = null;
  let ending = null;
  let skip = null; // resolves the current text/hold early
  let lastState = null;

  const speed = () => SPEEDS[getSpeed()] ?? SPEEDS.normal;
  const fx = createFx(scene, { sprites: { p1: youSprite, p2: foeSprite }, getScale: () => speed().anim });
  const FX_EVENTS = new Set(['stat', 'status', 'cant', 'residual', 'heal', 'crit', 'protect', 'enter']);

  // Tapping the scene or the message box hurries the text along.
  for (const target of [scene, message]) {
    target.addEventListener('click', () => skip?.());
  }

  let panelMode = 'message';
  function setPanel(mode) {
    panelMode = mode;
    message.hidden = mode !== 'message';
    commands.hidden = actions.hidden = mode !== 'commands';
    party.hidden = mode !== 'party';
    summary.hidden = mode !== 'summary';
    frame.dataset.panel = mode;
  }

  function showText(text) {
    messageText.textContent = text;
  }

  async function typeText(text) {
    const { perChar, hold } = speed();
    let done = false;
    const hurry = new Promise((ok) => { skip = () => { done = true; ok(); }; });
    for (let i = 1; i <= text.length && !done; i++) {
      showText(text.slice(0, i));
      await Promise.race([wait(perChar), hurry]);
    }
    showText(text);
    done = false;
    const held = new Promise((ok) => { skip = ok; });
    await Promise.race([wait(hold), held]);
    skip = null;
  }

  function addLog(text, kind) {
    const item = el('li', kind ? `log-${kind}` : '', text);
    logList.append(item);
    logList.scrollTop = logList.scrollHeight;
  }

  // --- Rendering the state -------------------------------------------------------------

  function renderSide(boxParts, sprite, sideState, back) {
    const mon = sideState?.active;
    const balls = boxParts.balls.children;
    sideState?.party.forEach((p, i) => { if (balls[i]) balls[i].dataset.state = p; });
    if (!mon) {
      if (!sprite.classList.contains('is-fainting')) sprite.hidden = true;
      boxParts.box.hidden = true;
      boxParts.shown = null;
      return;
    }
    const key = `${mon.num}:${mon.shiny}:${mon.name}`;
    if (boxParts.shown !== key) {
      sprite.src = spriteUrl(mon.num, { back, shiny: mon.shiny });
      sprite.alt = mon.species;
      boxParts.shown = key;
      boxParts.hpShown = null;
    }
    sprite.hidden = false;
    sprite.classList.remove('is-fainting');
    boxParts.box.hidden = false;
    boxParts.name.textContent = back ? mon.name : mon.name;
    boxParts.gender.textContent = mon.gender === 'M' ? '♂' : mon.gender === 'F' ? '♀' : '';
    boxParts.gender.dataset.gender = mon.gender;
    boxParts.level.textContent = `Lv${mon.level}`;
    const share = mon.maxhp ? Math.max(0, Math.min(1, mon.hp / mon.maxhp)) : 0;
    boxParts.fill.style.transitionDuration = `${speed().bar}ms`;
    boxParts.fill.style.width = `${share * 100}%`;
    boxParts.fill.dataset.level = share > 0.5 ? 'high' : share > 0.2 ? 'mid' : 'low';
    boxParts.status.textContent = STATUS_LABEL[mon.status] ?? '';
    boxParts.status.dataset.status = mon.status;
    if (mon.exact) tweenNumbers(boxParts, mon.hp, mon.maxhp);
  }

  function tweenNumbers(boxParts, hp, maxhp) {
    const from = boxParts.hpShown ?? hp;
    boxParts.hpShown = hp;
    const start = performance.now();
    const duration = from === hp ? 0 : speed().bar;
    const step = (now) => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      const value = Math.round(from + (hp - from) * t);
      boxParts.numbers.textContent = `${value}/ ${maxhp}`;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function render(state) {
    if (!state) return;
    renderSide(foe, foeSprite, state.p2, false);
    renderSide(you, youSprite, state.p1, true);
    const left = (s) => s.party.filter((p) => p !== 'fnt').length;
    remaining.textContent = `You ${left(state.p1)}, RED ${left(state.p2)}`;
    if (state.turn) frame.dataset.turn = state.turn;
    lastState = state;
  }

  const hpOf = (state, side) => state?.[side]?.active ? `${state[side].active.name}:${state[side].active.hp}` : '';

  async function animate(anim) {
    const sprite = anim.side === 'p1' ? youSprite : foeSprite;
    const scale = speed().anim;
    const run = async (cls, ms) => {
      sprite.classList.remove(cls);
      void sprite.offsetWidth; // restart the animation
      sprite.style.setProperty('--anim-scale', scale);
      sprite.classList.add(cls);
      await wait(ms * scale);
      if (cls !== 'is-fainting') sprite.classList.remove(cls);
    };
    if (anim.kind === 'attack') run('is-attacking', 300);
    else if (anim.kind === 'hit') await run('is-hit', 450);
    else if (anim.kind === 'faint') await run('is-fainting', 450);
    else if (anim.kind === 'enter') run('is-entering', 350);
  }

  // The move or effect animation for an event (fx.js), if animations are on.
  function playFx(anim) {
    if (!anim) return null;
    if (anim.kind === 'weather') return fx.event(anim); // the weather overlay is shown either way
    if (!getAnimations()) return anim.kind === 'move' ? animate({ kind: 'attack', side: anim.side }) : null;
    if (anim.kind === 'move') return anim.miss ? animate({ kind: 'attack', side: anim.side }) : fx.move(anim).catch(() => {});
    if (FX_EVENTS.has(anim.kind)) return fx.event(anim).catch(() => {});
    return null;
  }

  async function show(event) {
    const before = lastState;
    if (event.anim?.kind === 'faint') await animate(event.anim);
    render(event.state);
    if (event.anim?.kind === 'hit' || event.anim?.kind === 'enter') animate(event.anim);
    const effect = playFx(event.anim);
    if (event.turn) {
      addLog(`Turn ${event.turn}`, 'turn');
      return;
    }
    if (event.text) {
      addLog(event.text);
      await Promise.all([typeText(event.text), effect]);
    } else if (hpOf(before, 'p1') !== hpOf(event.state, 'p1') || hpOf(before, 'p2') !== hpOf(event.state, 'p2')) {
      await Promise.all([wait(speed().bar), effect]);
    } else {
      await effect;
    }
  }

  async function drain() {
    if (playing) return;
    playing = true;
    setPanel('message');
    while (queue.length) await show(queue.shift());
    playing = false;
    if (ending) finish();
    else if (request) showRequest();
  }

  // --- Commands --------------------------------------------------------------------------

  function showRequest() {
    const req = request;
    if (!req || req.kind === 'wait') return;
    if (req.kind === 'switch') {
      showParty(req, true);
      return;
    }
    // Choice Band: every move but the first one used is greyed out until the
    // Pokémon switches out. Say so, or it looks broken.
    const holder = req.party?.find((p) => p.active);
    const usable = req.moves.filter((m) => !m.disabled);
    const locked = holder?.item === 'Choice Band' && usable.length === 1 && req.moves.length > 1 ? usable[0] : null;
    prompt.textContent = locked
      ? `CHOICE BAND locks ${req.species.toUpperCase()} into ${locked.name.toUpperCase()}. Switch out to pick another move.`
      : `What will ${req.species.toUpperCase()} do?`;
    prompt.classList.toggle('prompt-locked', Boolean(locked));
    abilityLabel.textContent = req.ability.toUpperCase();
    moveGrid.replaceChildren(...req.moves.map((move) => {
      const button = el('button', 'move');
      button.type = 'button';
      button.disabled = move.disabled;
      button.dataset.type = move.type;
      button.dataset.effect = move.effect || '';
      // Everything about the move on the button itself (no hovering or
      // holding needed on a phone): name; type, power and PP; how it hits.
      const label = el('span', 'move-label');
      label.append(el('span', 'move-name', move.name.toUpperCase()));
      const facts = el('span', 'move-sub');
      const type = el('span', 'move-type-badge', move.type.toUpperCase());
      type.dataset.type = move.type;
      facts.append(type);
      facts.append(el('span', 'move-power', move.category === 'Status' ? 'Status' : move.power ? `${move.power} pow` : '—'));
      facts.append(el('span', 'move-pp', move.maxpp != null ? `PP ${move.pp}/${move.maxpp}` : ''));
      label.append(facts);
      const effect = move.category === 'Status' || !move.effect ? '' : EFFECT_SHORT[move.effect] || 'Neutral';
      if (effect) label.append(el('span', 'move-effect', effect));
      button.append(label);
      button.setAttribute('aria-label', [move.name, move.type, move.category === 'Status' ? 'status move' : `${move.power ?? ''} power`,
        move.maxpp != null ? `${move.pp} of ${move.maxpp} PP` : '', EFFECT_LABEL[move.effect] ?? ''].filter(Boolean).join(', '));
      button.addEventListener('click', () => submit(`move ${move.slot}`));
      return button;
    }));
    pokemonButton.disabled = !req.canSwitch || !req.party.some((p) => !p.active && p.status !== 'fnt');
    setPanel('commands');
  }

  function showParty(req, forced) {
    partyHead.textContent = forced ? 'Choose a POKéMON to send out.' : 'Choose a POKéMON.';
    partyList.replaceChildren(...req.party.map((p) => {
      const item = el('li');
      const button = el('button', 'party-mon');
      button.type = 'button';
      button.disabled = p.active || p.status === 'fnt';
      const icon = el('img', 'party-icon');
      icon.src = spriteUrl(p.num, { shiny: p.shiny });
      icon.alt = '';
      icon.width = icon.height = 64;
      const text = el('span', 'party-text');
      const top = el('span', 'party-name', p.species);
      const hpRow = el('span', 'party-hp');
      const track = el('span', 'hp-track');
      const fill = el('span', 'hp-fill');
      const share = p.maxhp ? p.hp / p.maxhp : 0;
      fill.style.width = `${share * 100}%`;
      fill.dataset.level = share > 0.5 ? 'high' : share > 0.2 ? 'mid' : 'low';
      track.append(fill);
      hpRow.append(track, el('span', 'party-numbers', `${p.hp}/${p.maxhp}`));
      text.append(top, hpRow);
      const tag = el('span', 'party-tag', p.status === 'fnt' ? 'FNT' : p.active ? 'IN BATTLE' : STATUS_LABEL[p.status] ?? '');
      button.append(icon, text, tag);
      button.addEventListener('click', () => showSummary(p, { forced, canShift: forced || req.canSwitch }));
      item.append(button);
      return item;
    }));
    partyCancel.hidden = forced;
    setPanel('party');
  }

  // A Pokémon's summary. Yours: moves (with how they'd hit RED's Pokémon),
  // item, ability, stats, and SHIFT to send it out. RED's: the same, with how
  // its moves would hit yours.
  function showSummary(mon, { foe = false, forced = false, canShift = false } = {}) {
    const back = () => (foe ? showRequest() : showParty(request, forced));
    const head = el('div', 'sum-head');
    const icon = el('img', 'sum-sprite');
    icon.src = spriteUrl(mon.num, { shiny: mon.shiny });
    icon.alt = '';
    icon.width = icon.height = 64;
    const title = el('div', 'sum-title');
    const name = el('p', 'sum-name');
    if (foe) name.append(el('span', 'sum-owner', "RED's "));
    name.append(mon.species);
    const gender = el('span', 'sum-gender', mon.gender === 'M' ? '♂' : mon.gender === 'F' ? '♀' : '');
    gender.dataset.gender = mon.gender;
    name.append(gender, el('span', 'sum-level', `Lv${mon.level}`));
    const types = el('span', 'sum-types');
    for (const type of mon.types) {
      const badge = el('span', 'type-badge', type);
      badge.dataset.type = type;
      types.append(badge);
    }
    const hp = el('div', 'hp');
    const track = el('div', 'hp-track');
    const fill = el('div', 'hp-fill');
    const share = mon.maxhp ? mon.hp / mon.maxhp : 0;
    fill.style.width = `${share * 100}%`;
    fill.dataset.level = share > 0.5 ? 'high' : share > 0.2 ? 'mid' : 'low';
    fill.style.transition = 'none';
    track.append(fill);
    hp.append(el('span', 'hp-label', 'HP'), track,
      el('span', 'sum-hp', mon.status === 'fnt' ? 'FNT' : foe ? `${mon.hp}%` : `${mon.hp}/${mon.maxhp}`));
    title.append(name, types, hp);
    head.append(icon, title);

    const facts = el('dl', 'sum-facts');
    for (const [label, value, hint] of [['ITEM', mon.item || 'None', mon.itemDesc], ['ABILITY', mon.ability, mon.abilityDesc], ['NATURE', mon.nature]]) {
      const row = el('div');
      const dd = el('dd', '', value);
      if (hint) dd.title = hint;
      row.append(el('dt', '', label), dd);
      facts.append(row);
    }
    // What the item does, in words (not just a tooltip, which phones can't show).
    const itemHelp = mon.item && mon.itemDesc ? el('p', 'sum-item-desc') : null;
    itemHelp?.append(el('strong', '', `${mon.item}: `), mon.itemDesc);

    const against = request?.foe && !foe ? `RED's ${request.foe.species}` : request?.party?.find((p) => p.active)?.species;
    const note = el('p', 'sum-note', against ? `Effectiveness against ${against}` : '');
    const moves = el('ul', 'sum-moves');
    for (const move of mon.moves) {
      const row = el('li', 'sum-move');
      row.dataset.type = move.type;
      row.dataset.effect = move.effect || '';
      row.title = move.desc ?? '';
      const detail = [move.type, move.category === 'Status' ? 'Status' : `${move.power ?? '—'} ${move.category}`];
      if (move.accuracy) detail.push(`${move.accuracy}% acc`);
      row.append(
        el('span', 'move-type'),
        el('span', 'sum-move-name', move.name.toUpperCase()),
        el('span', 'sum-move-pp', foe ? '' : `PP ${move.pp}/${move.maxpp}`),
        el('span', 'sum-move-detail', detail.join(' · ')),
        el('span', 'move-effect', move.category === 'Status' ? '' : EFFECT_LABEL[move.effect] ?? ''),
      );
      moves.append(row);
    }

    const stats = el('dl', 'sum-stats');
    for (const [key, label] of [['hp', 'HP'], ['atk', 'ATK'], ['def', 'DEF'], ['spa', 'SP.ATK'], ['spd', 'SP.DEF'], ['spe', 'SPEED']]) {
      const row = el('div');
      row.append(el('dt', '', label), el('dd', '', String(mon.stats[key])));
      stats.append(row);
    }

    const buttons = el('div', 'sum-buttons');
    if (!foe) {
      const shift = el('button', 'action sum-shift', mon.status === 'fnt' ? 'FAINTED' : mon.active ? 'IN BATTLE' : 'SHIFT');
      shift.type = 'button';
      shift.disabled = mon.active || mon.status === 'fnt' || !canShift;
      shift.addEventListener('click', () => submit(`switch ${mon.slot}`));
      buttons.append(shift);
    }
    const backButton = el('button', 'action', foe ? 'BACK' : 'BACK');
    backButton.type = 'button';
    backButton.addEventListener('click', back);
    buttons.append(backButton);

    summary.replaceChildren(...[head, facts, itemHelp, note, moves, stats, buttons].filter(Boolean));
    setPanel('summary');
    summary.scrollIntoView({ block: 'nearest' });
  }

  // Tapping RED's info box shows his Pokémon's summary while choosing.
  foe.box.addEventListener('click', (event) => {
    if (!request?.foe || (panelMode !== 'commands' && panelMode !== 'party')) return;
    event.stopPropagation();
    showSummary(request.foe, { foe: true });
  });
  foe.box.title = "Tap to see RED's Pokémon";

  pokemonButton.addEventListener('click', () => request && showParty(request, false));
  partyCancel.addEventListener('click', () => showRequest());
  runButton.addEventListener('click', () => onRun());

  function submit(choice) {
    request = null;
    setPanel('message');
    showText('');
    onChoose(choice);
  }

  // --- Ending ----------------------------------------------------------------------------

  async function finish() {
    const { text, done } = ending;
    ending = null;
    setPanel('message');
    addLog(text, 'result');
    await typeText(text);
    done?.();
  }

  return {
    reset({ name }) {
      queue.length = 0;
      request = null;
      ending = null;
      lastState = null;
      logList.replaceChildren();
      remaining.textContent = '';
      foe.shown = you.shown = null;
      for (const sprite of [foeSprite, youSprite]) {
        sprite.hidden = true;
        sprite.className = sprite.className.replace(/\bis-\S+/g, '').trim();
      }
      foe.box.hidden = you.box.hidden = true;
      fx.clear();
      frame.dataset.player = name;
      showText('RED wants to battle!');
      addLog('RED wants to battle!');
      setPanel('message');
    },
    play(events) {
      queue.push(...events);
      drain();
    },
    request(req) {
      request = req;
      if (!playing && !queue.length) showRequest();
    },
    end(text, done) {
      request = null;
      ending = { text, done };
      if (!playing && !queue.length) finish();
    },
    // The party left at the end, for the result: 'ok' / 'fnt' per slot.
    get state() { return lastState; },
    // Plays one animation (worker.js animFor's format), for debugging.
    preview: (anim) => playFx(anim),
  };
}
