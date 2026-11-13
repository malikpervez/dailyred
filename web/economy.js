// Money and items, from No. 16 (Monday, Nov 16, 2026): prize money for every
// official battle, a PokéMart, and a free bag that refills every Monday. The
// same rules run on the page (the plain website keeps the wallet in this
// browser) and on the activity server (Discord sign-in: the server keeps it
// and checks every purchase and use). Pure functions on a plain object, like
// the stats in daily.js.
//
// A wallet:
//   month              'YYYY-MM' the money and bought items belong to; on the
//                      1st both start over (with streaks and the Master race)
//   cash, earned, spent   this month's ₽
//   bought             { item: count } bought this month and not used yet
//   week               the Monday of the week the free bag belongs to
//   freeUsed           { item: count } used from this week's free bag
//   battle             { date, used }: items used in that day's official battle
//
// Picked from a simulated month (30 players, 900 battles): with the free bag
// and these prices, about 1 win in 5 against RED (1 in 7 without items).

export const ECONOMY_START = '2026-11-16';
export const CARRY_LIMIT = 4; // items per battle
export const WEEKLY_BAG = { fullrestore: 3, revive: 2, maxrevive: 1 };

// FireRed's PokéMart prices (Max Revive isn't sold there; priced to match).
// `use`: what it does in battle (battle/worker.js).
export const ITEMS = {
  fullrestore: { name: 'Full Restore', price: 3000, use: 'heal', desc: 'Heals all HP and cures any status.' },
  maxpotion: { name: 'Max Potion', price: 2500, use: 'heal', desc: 'Heals all HP.' },
  hyperpotion: { name: 'Hyper Potion', price: 1200, use: 'heal', desc: 'Heals 200 HP.' },
  fullheal: { name: 'Full Heal', price: 600, use: 'cure', desc: 'Cures sleep, poison, burn, paralysis, freezing and confusion.' },
  revive: { name: 'Revive', price: 1500, use: 'revive', desc: 'Brings a fainted Pokémon back with half its HP.' },
  maxrevive: { name: 'Max Revive', price: 4000, use: 'revive', desc: 'Brings a fainted Pokémon back with all its HP.' },
  xattack: { name: 'X Attack', price: 500, use: 'boost', stat: 'atk', desc: 'Raises the Attack of your Pokémon in battle until it switches out.' },
  xdefend: { name: 'X Defend', price: 550, use: 'boost', stat: 'def', desc: 'Raises the Defense of your Pokémon in battle until it switches out.' },
  xspeed: { name: 'X Speed', price: 350, use: 'boost', stat: 'spe', desc: 'Raises the Speed of your Pokémon in battle until it switches out.' },
  xspecial: { name: 'X Special', price: 350, use: 'boost', stat: 'spa', desc: 'Raises the Sp. Atk of your Pokémon in battle until it switches out.' },
};

export const NO_EFFECT = "It won't have any effect.";

// Why `item` can't be used on `mon` right now ('' if it can), like the games:
// no Potions on full HP, no Revives on the standing. `mon` as the battle
// screen has it: { hp, maxhp, status ('fnt' when fainted), active, confused, boosts }.
export function itemProblem(item, mon) {
  const info = itemInfo(item);
  if (!info) return 'There is no such item.';
  if (!mon) return NO_EFFECT;
  const fainted = mon.status === 'fnt' || !(mon.hp > 0);
  const ailing = Boolean(mon.status && mon.status !== 'fnt') || Boolean(mon.active && mon.confused);
  switch (info.use) {
    case 'revive': return fainted ? '' : NO_EFFECT;
    case 'heal': return !fainted && (mon.hp < mon.maxhp || (item === 'fullrestore' && ailing)) ? '' : NO_EFFECT;
    case 'cure': return !fainted && ailing ? '' : NO_EFFECT;
    case 'boost':
      if (!mon.active) return 'It can only be used on the POKéMON in battle.';
      return (mon.boosts?.[info.stat] ?? 0) < 6 ? '' : NO_EFFECT;
    default: return NO_EFFECT;
  }
}

// Prize money for an official battle's result: { won, gaveUp, monsLeft, redLeft }.
export const PRIZE = { win: 1000, perLeft: 70, loss: 270, perKO: 100 };
export function prizeFor({ won, gaveUp, monsLeft, redLeft }) {
  if (won) return PRIZE.win + PRIZE.perLeft * (monsLeft ?? 0);
  if (gaveUp) return 0;
  return PRIZE.loss + PRIZE.perKO * (6 - (redLeft ?? 6));
}

export const economyOpen = (date) => Boolean(date) && date >= ECONOMY_START;

// The Monday of `date`'s week.
export function weekOf(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export class EconomyError extends Error {}

// Item ids come from the page (and the network): only our own items count,
// never inherited names like "constructor".
const itemInfo = (item) => (typeof item === 'string' && Object.hasOwn(ITEMS, item) ? ITEMS[item] : null);

// { item: count } with only real items and whole positive counts.
function counts(saved) {
  const out = {};
  for (const id of Object.keys(ITEMS)) {
    const n = Math.floor(Number(saved?.[id]));
    if (n > 0) out[id] = n;
  }
  return out;
}

// The wallet as it stands on `date`: a new month empties it, a new week
// refills the free bag. Only a later month or week starts over, so a device
// a time zone behind still sees the same wallet.
export function walletFor(saved, date) {
  const w = {
    month: date.slice(0, 7), cash: 0, earned: 0, spent: 0, bought: {},
    week: weekOf(date), freeUsed: {}, battle: null,
  };
  if (!saved || typeof saved !== 'object') return w;
  const whole = (n) => Math.max(0, Math.floor(Number(n)) || 0);
  if (typeof saved.month === 'string' && saved.month >= w.month) {
    w.month = saved.month;
    w.cash = whole(saved.cash);
    w.earned = whole(saved.earned);
    w.spent = whole(saved.spent);
    w.bought = counts(saved.bought);
  }
  if (typeof saved.week === 'string' && saved.week >= w.week) {
    w.week = saved.week;
    w.freeUsed = counts(saved.freeUsed);
  }
  if (typeof saved.battle?.date === 'string') w.battle = { date: saved.battle.date, used: whole(saved.battle.used) };
  return w;
}

// What's in the bag: { item: { free, bought, total } } for items you have.
export function bagOf(wallet) {
  const bag = {};
  for (const id of Object.keys(ITEMS)) {
    const free = Math.max(0, (WEEKLY_BAG[id] ?? 0) - (wallet.freeUsed[id] ?? 0));
    const bought = Math.max(0, wallet.bought[id] ?? 0);
    if (free + bought) bag[id] = { free, bought, total: free + bought };
  }
  return bag;
}

// Items used so far in `date`'s official battle.
export const usedIn = (wallet, date) => (wallet.battle?.date === date ? wallet.battle.used : 0);

// Pays out an official battle's result; returns the prize (0 before No. 16).
export function earn(wallet, date, result) {
  if (!economyOpen(date)) return 0;
  const prize = prizeFor(result);
  wallet.cash += prize;
  wallet.earned += prize;
  return prize;
}

export function buy(wallet, item, quantity = 1) {
  const info = itemInfo(item);
  const n = Math.floor(Number(quantity));
  if (!info) throw new EconomyError('There is no such item');
  if (!(n >= 1 && n <= 20)) throw new EconomyError('Buy between 1 and 20');
  if (wallet.cash < info.price * n) throw new EconomyError(`Not enough money: ${info.name} costs ₽${(info.price * n).toLocaleString('en-US')}`);
  wallet.cash -= info.price * n;
  wallet.spent += info.price * n;
  wallet.bought[item] = (wallet.bought[item] ?? 0) + n;
}

// Uses an item in `date`'s official battle: this week's free bag first.
export function useItem(wallet, date, item) {
  if (!itemInfo(item)) throw new EconomyError('There is no such item');
  if (usedIn(wallet, date) >= CARRY_LIMIT) throw new EconomyError(`Only ${CARRY_LIMIT} items per battle`);
  if ((WEEKLY_BAG[item] ?? 0) - (wallet.freeUsed[item] ?? 0) > 0) {
    wallet.freeUsed[item] = (wallet.freeUsed[item] ?? 0) + 1;
  } else if ((wallet.bought[item] ?? 0) > 0) {
    wallet.bought[item] -= 1;
  } else {
    throw new EconomyError(`No ${ITEMS[item].name} left`);
  }
  wallet.battle = { date, used: usedIn(wallet, date) + 1 };
}
