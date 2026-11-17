// The Cup's battles, run on the server: players battle each other, so the
// server is the referee (the browsers only show what they're sent).
//
// A battle is saved as its inputs: the random seed, the two players' teams
// and every choice in order. The simulator is deterministic for a seed, so
// replaying them rebuilds exactly the same battle, which is how battles
// survive a restart of the server (cup.mjs keeps the inputs in SQLite).
//
// build-battle.mjs bundles this file (with @pkmn/sim, @smogon/calc and RED's
// AI) into activity/dist/cup-engine.mjs, so the server image needs no npm
// packages.
import { Battle, Dex, Teams, PRNG, extractChannelMessages } from '@pkmn/sim';
import * as calc from '@smogon/calc';
import { chooseFor } from '../web/battle/ai.js';
import { draftPool as makePool } from '../web/battle/team.js';
import { describeSet } from '../web/battle/describe.js';

const dex = Dex.forGen(3);
const FORMAT = 'gen3customgame';
const SIDES = ['p1', 'p2'];
const CHANNEL = { spectator: 0, p1: 1, p2: 2 };

// saved: { seed, p1: { name, team }, p2: { name, team }, inputs: [[side, choice]] }
// (team: Showdown sets; a new battle gets a fresh seed). `onEvent(view,
// event)` hears what each view ('p1', 'p2', 'spectator') is sent as it
// happens: { kind: 'log', text } or { kind: 'request', request }.
export function openBattle(saved, onEvent = () => {}) {
  const state = {
    seed: saved.seed ?? PRNG.generateSeed(),
    p1: saved.p1,
    p2: saved.p2,
    inputs: [],
  };
  // Everything each view has been sent, in order, so a browser that
  // (re)connects can be brought up to date.
  const views = { p1: [], p2: [], spectator: [] };
  const requests = { p1: null, p2: null };
  // Each request gets a number (rqid), so a choice made for a turn that's
  // already over is turned down. Replays number them the same way.
  const numbers = { p1: 0, p2: 0 };
  let errors = { p1: null, p2: null };
  let replaying = true;

  const emit = (view, event) => {
    views[view].push(event);
    if (!replaying) onEvent(view, event, views[view].length);
  };

  const battle = new Battle({
    formatid: FORMAT,
    seed: state.seed,
    send(type, data) {
      if (type === 'update') {
        const lines = extractChannelMessages(Array.isArray(data) ? data.join('\n') : data, [0, 1, 2]);
        for (const [view, channel] of Object.entries(CHANNEL)) {
          const text = lines[channel].join('\n');
          if (text) emit(view, { kind: 'log', text });
        }
      } else if (type === 'sideupdate') {
        const [side, line] = String(data).split(/\n(.*)/s);
        if (line.startsWith('|request|')) {
          requests[side] = { ...JSON.parse(line.slice(9)), rqid: ++numbers[side] };
          emit(side, { kind: 'request', request: requests[side] });
        } else if (line.startsWith('|error|')) {
          errors[side] = line.slice(7);
        }
      }
    },
  });
  // Showdown's Custom Game formats run in debug mode, which shows everyone
  // both sides' exact HP and adds |debug| lines. Fine against RED; between
  // two players each must only see the other's HP as a percentage.
  battle.reportExactHP = false;
  battle.debugMode = false;
  for (const side of SIDES) {
    battle.setPlayer(side, { name: state[side].name, team: Teams.pack(state[side].team) });
  }
  battle.sendUpdates(); // the simulator sends what happened (and the requests) only when asked

  // One input: a choice ('move 2', 'switch 3') or 'forfeit'. Returns an
  // error message, or null when it was taken.
  function apply(side, choice) {
    if (!SIDES.includes(side)) return 'Not a player';
    if (battle.ended) return 'The battle is over';
    if (choice === 'forfeit') {
      battle.lose(side);
    } else {
      errors = { p1: null, p2: null };
      const taken = battle.choose(side, choice);
      battle.sendUpdates();
      if (!taken) return errors[side] || "That choice isn't possible right now";
    }
    battle.sendUpdates();
    state.inputs.push([side, choice]);
    return null;
  }

  for (const [side, choice] of saved.inputs ?? []) {
    const error = apply(side, choice);
    if (error) throw new Error(`Replaying ${side} ${choice}: ${error}`);
  }
  replaying = false;

  return {
    state, // what to save (after every input)
    views,
    get ended() { return battle.ended; },
    // 'p1', 'p2', '' for a tie, null while it's on.
    get winner() {
      if (!battle.ended) return null;
      return SIDES.find((s) => battle[s].name === battle.winner) ?? '';
    },
    get turn() { return battle.turn; },
    // The sides that still have to choose this turn.
    waitingOn() {
      if (battle.ended) return [];
      return SIDES.filter((s) => {
        const request = requests[s];
        return request && !request.wait && !battle[s].isChoiceDone();
      });
    },
    request: (side) => requests[side],
    choose: (side, choice) => apply(side, String(choice ?? '').slice(0, 40)),
    // RED's AI picks for a side (the Cup's autopilot after 24 hours).
    autopilot(side) {
      const request = requests[side];
      if (!request || request.wait) return 'Nothing to choose';
      let choice = 'default';
      try {
        choice = chooseFor(side, calc, dex, battle, request, Math.random, 0);
      } catch {
        // 'default' still moves the battle on
      }
      return apply(side, choice) && apply(side, 'default');
    },
  };
}

// The draft's pool (team.js): `count` sets, each with what the draft room
// shows of it (describe.js) and its base stat total (the autopick's last
// resort: the best Pokémon left).
export const draftPool = (seed, count) => makePool(dex, seed, count).map((set) => {
  const base = dex.species.get(set.species).baseStats;
  return { set, info: describeSet(dex, set), bst: Object.values(base).reduce((a, b) => a + b, 0) };
});

// The Showdown sets for a team, e.g. for tests and the draft: (re)exported so
// the server doesn't need the simulator itself.
export const packTeam = (team) => Teams.pack(team);
