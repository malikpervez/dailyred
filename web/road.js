// The Road to RED: from Monday, Nov 23, 2026, a new trainer every week, each
// a little harder, building up to RED, then round again. Before that every
// day is RED. Like the daily team, the week goes by the player's own date,
// so everyone faces the same trainer on the same calendar day.
//
// Shared by the page, the battle engine (battle/trainers.js has the teams),
// the activity server and the bot. Order and difficulty were picked from a
// simulation (300 battles per trainer on the same daily teams): a simple bot
// that never switches wins about 32% against Blue, 25% Steven, 22% Giovanni,
// 19% Lance, 16% Wallace and 14% RED.

export const ROAD_START = '2026-11-23'; // a Monday
export const ROAD = ['blue', 'steven', 'giovanni', 'lance', 'wallace', 'red'];

export const TRAINERS = {
  blue: { name: 'Blue', title: 'Champion', style: 'A bit of everything: his six from the Indigo Plateau rematch.' },
  steven: { name: 'Steven', title: 'Champion', style: 'Steel and Rock walls that are hard to break, then Metagross.' },
  giovanni: { name: 'Giovanni', title: 'Team Rocket Boss', style: "Ground types, and a Dugtrio you can't switch away from." },
  lance: { name: 'Lance', title: 'Dragon Master', style: 'Dragons that hit hard and fast, and his red Gyarados.' },
  wallace: { name: 'Wallace', title: 'Champion', style: 'Water types that wear you down, ending with Milotic.' },
  red: { name: 'RED', title: 'Pokémon Trainer', style: 'The one at the top of Mt. Silver.' },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const dayIndex = (date) => Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${ROAD_START}T12:00:00Z`)) / DAY_MS);
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export const roadOpen = (date) => Boolean(date) && date >= ROAD_START;

// The trainer for `date` ('YYYY-MM-DD'): { id, name, title, style, week (1-6
// on the road, 0 before it), from and to (the week's Monday and Sunday),
// next: { id, name, from } (the trainer after this one) }.
export function trainerOn(date) {
  if (!roadOpen(date)) {
    return { id: 'red', ...TRAINERS.red, week: 0, from: null, to: null, next: { id: ROAD[0], ...TRAINERS[ROAD[0]], from: ROAD_START } };
  }
  const weeks = Math.floor(dayIndex(date) / 7);
  const id = ROAD[weeks % ROAD.length];
  const from = shift(ROAD_START, weeks * 7);
  const nextId = ROAD[(weeks + 1) % ROAD.length];
  return {
    id, ...TRAINERS[id], week: (weeks % ROAD.length) + 1, from, to: shift(from, 6),
    next: { id: nextId, ...TRAINERS[nextId], from: shift(from, 7) },
  };
}
