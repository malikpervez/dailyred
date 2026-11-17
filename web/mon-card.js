// A Pokémon's card: sprite, name, types, item, ability, nature, moves and
// level 100 stats. Today's page (app.js) and the Cup's draft room
// (cup-hub.js) both show Pokémon this way.
import { spriteUrl } from './battle/view.js';

export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export function typeBadges(types) {
  const row = el('span', 'types');
  for (const type of types) {
    const badge = el('span', 'type-badge', type);
    badge.dataset.type = type;
    row.append(badge);
  }
  return row;
}

export function sprite(mon, className) {
  const img = el('img', className);
  img.src = spriteUrl(mon.num, { shiny: mon.shiny });
  img.alt = '';
  img.width = img.height = 64;
  img.loading = 'lazy';
  return img;
}

const STAT_NAMES = [['hp', 'HP'], ['atk', 'Atk'], ['def', 'Def'], ['spa', 'SpA'], ['spd', 'SpD'], ['spe', 'Spe']];
const genderSymbol = (g) => (g === 'M' ? '♂' : g === 'F' ? '♀' : '');

// The card (an <li class="mon-card">); `head`: more things for the top row
// (a badge, a button).
export function monCard(mon, { head: extra = [] } = {}) {
  const item = el('li', 'mon-card');
  const head = el('div', 'mon-head');
  head.append(sprite(mon, 'mon-sprite'));
  const title = el('div', 'mon-title');
  const name = el('h3', 'mon-name', mon.species);
  const gender = el('span', 'mon-gender', genderSymbol(mon.gender));
  gender.dataset.gender = mon.gender;
  name.append(gender);
  if (mon.shiny) name.append(el('span', 'mon-shiny', '★'));
  title.append(name, typeBadges(mon.types));
  head.append(title, ...extra);
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
