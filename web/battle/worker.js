// The battle engine, run in a Web Worker (bundled into web/vendor/
// battle-worker.js by activity/build-battle.mjs) so the page stays smooth.
//
// It generates the teams, runs the battle on Pokémon Showdown's simulator
// (@pkmn/sim, Gen 3 rules), plays RED (ai.js), and turns the battle log into
// what the page shows: lines of text, each with a snapshot of the screen
// (@pkmn/client tracks the state as the player sees it, line by line).
//
// Messages in (from battle/engine.js):
//   { type: 'team', seed }                 -> { type: 'team', team, red }
//   { type: 'start', seed, order, name }   -> events / request / end messages
//   { type: 'choose', choice }             e.g. "move 2", "switch 3"
//   { type: 'forfeit' }
// Messages out:
//   { type: 'events', events: [{ text?, state, anim? }] }
//   { type: 'request', request }           what the player can do now
//   { type: 'end', won, tie }    a tie (both last Pokémon down at once) isn't a win
//   { type: 'error', message }

import { Dex, BattleStreams, Teams } from '@pkmn/sim';
import { Generations } from '@pkmn/data';
import { Battle as ClientBattle } from '@pkmn/client';
import { Protocol } from '@pkmn/protocol';
import { LogFormatter } from '@pkmn/view';
import * as calc from '@smogon/calc';
import { generateTeam, statsFor, isPhysicalType } from './team.js';
import { itemHelp } from './items.js';
import { RED_TEAM } from './red.js';
import { chooseForRed } from './ai.js';

const dex = Dex.forGen(3);
const gens = new Generations(Dex); // the client shares the simulator's data

const post = (message) => postMessage(message);

// --- Teams for the page ------------------------------------------------------------

function describeMove(name, set) {
  const move = dex.moves.get(name);
  const type = move.id === 'hiddenpower' ? hiddenPowerType(set.ivs) : move.type;
  return {
    name: move.name,
    type,
    category: move.category === 'Status' ? 'Status' : isPhysicalType(type) ? 'Physical' : 'Special',
    power: move.basePower || null,
    accuracy: move.accuracy === true ? null : move.accuracy,
    pp: Math.floor(move.pp * 8 / 5), // 3 PP Ups, like the FireRed version's teams
    desc: move.shortDesc,
  };
}

// Gen 3 Hidden Power type from the IVs.
function hiddenPowerType(ivs) {
  const types = ['Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
    'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];
  const bit = (s, n) => (ivs[s] >> n) & 1;
  const index = ['hp', 'atk', 'def', 'spe', 'spa', 'spd'].reduce((sum, s, i) => sum + (bit(s, 0) << i), 0);
  return types[Math.floor((index * 15) / 63)];
}

function describe(set) {
  const species = dex.species.get(set.species);
  return {
    species: species.name,
    num: species.num,
    types: species.types,
    item: set.item,
    ability: set.ability,
    abilityDesc: dex.abilities.get(set.ability).shortDesc,
    itemDesc: itemHelp(dex.items.get(set.item)),
    nature: set.nature,
    gender: set.gender || species.gender || '',
    shiny: Boolean(set.shiny),
    level: set.level,
    stats: statsFor(dex, set),
    baseStats: species.baseStats,
    moves: set.moves.map((m) => describeMove(m, set)),
  };
}

// --- Text ---------------------------------------------------------------------------

// The Showdown text, FireRed style: no markdown or exact HP lines, "Foe" for
// RED's Pokémon.
function cleanText(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('||') && !line.startsWith('==') && !line.startsWith('['))
    .map((line) => line
      .replace(/\*\*/g, '')
      .replace(/^\((.*)\)$/, '$1')
      .replace(/\bThe opposing /g, 'Foe ')
      .replace(/\bthe opposing /g, 'foe '))
    .filter((line) => !/^Battle started between/.test(line));
}

// --- Battle -------------------------------------------------------------------------

let current = null;

function pokemonState(mon, own) {
  if (!mon) return null;
  const species = dex.species.get(mon.speciesForme);
  return {
    name: mon.name,
    species: species.name,
    num: species.num,
    level: mon.level,
    gender: mon.gender === 'N' ? '' : mon.gender,
    shiny: Boolean(mon.shiny),
    hp: mon.hp,
    maxhp: mon.maxhp,
    // RED's HP is only known as a percentage (maxhp 100), like on the GBA.
    exact: own,
    status: mon.status || '',
  };
}

// The screen as the player sees it. A Pokémon knocked out stays on screen at
// 0 HP until its "fainted!" line (the client clears it from active then), so
// its HP bar drains all the way first.
function snapshot(client) {
  const side = (s, own) => {
    const active = s.active[0] ? pokemonState(s.active[0], own) : null;
    // Only `fainted` counts: the client starts the bench it learns from the
    // first request at 0 HP until it sees their real HP.
    const party = s.team.map((p) => (p.fainted ? 'fnt' : p.status ? 'status' : 'ok'));
    while (party.length < 6) party.push('unknown');
    // Which Pokémon fainted, by Pokédex number (for the share image).
    const fainted = s.team.filter((p) => p.fainted).map((p) => p.species.num);
    return { name: s.name, active, party, fainted };
  };
  return { p1: side(client.p1, true), p2: side(client.p2, false), turn: client.turn };
}

const STATE_LINES = new Set(['switch', 'drag', 'replace', 'faint', '-damage', '-heal', '-sethp', '-status',
  '-curestatus', '-cureteam', 'detailschange', '-transform', '-formechange']);

// Moves aimed at the user or its own side (the animation plays on the user).
const SELF_TARGETS = new Set(['self', 'adjacentAllyOrSelf', 'allySide', 'allyTeam', 'allies', 'all']);
const toId = (text) => String(text || '').toLowerCase().replace(/^(item|ability|move):\s*/, '').replace(/[^a-z0-9]/g, '');

// What the battle screen should animate for a protocol line (fx.js and the
// sprite effects in view.js), or null.
function animFor(args, kwArgs) {
  const side = (ident) => (ident || '').slice(0, 2);
  const other = (s) => (s === 'p1' ? 'p2' : 'p1');
  switch (args[0]) {
    case 'move': {
      if (kwArgs.still) return null;
      const move = dex.moves.get(args[2]);
      const user = side(args[1]);
      const self = SELF_TARGETS.has(move.target);
      return {
        kind: 'move',
        side: user,
        target: self ? user : side(args[3]) || other(user),
        self,
        id: move.id,
        type: move.type,
        category: move.category,
        contact: Boolean(move.flags?.contact),
        status: move.status || null,
        boosts: Boolean(move.boosts || move.self?.boosts),
        miss: Boolean(kwArgs.miss),
      };
    }
    case '-damage': return kwArgs.from ? { kind: 'residual', side: side(args[1]), from: toId(kwArgs.from) } : { kind: 'hit', side: side(args[1]) };
    case '-heal': return { kind: 'heal', side: side(args[1]) };
    case '-boost': return { kind: 'stat', side: side(args[1]), up: true };
    case '-unboost': return { kind: 'stat', side: side(args[1]), up: false };
    case '-status': return { kind: 'status', side: side(args[1]), status: args[2] };
    case 'cant': return { kind: 'cant', side: side(args[1]), reason: toId(args[2]) };
    case '-activate':
      if (/confusion/i.test(args[2])) return { kind: 'status', side: side(args[1]), status: 'confusion' };
      if (/protect|detect/i.test(args[2])) return { kind: 'protect', side: side(args[1]) };
      return null;
    case '-start': return /confusion/i.test(args[2]) ? { kind: 'status', side: side(args[1]), status: 'confusion' } : null;
    case '-crit': return { kind: 'crit', side: side(args[1]) };
    case '-weather': return { kind: 'weather', weather: args[1] };
    case 'faint': return { kind: 'faint', side: side(args[1]) };
    case 'switch': case 'drag': return { kind: 'enter', side: side(args[1]) };
    default: return null;
  }
}

// A Pokémon's moves for the menus: type, power, PP and how each hits `foe`.
function movesOf(mon, foe) {
  return mon.moveSlots.map((slot) => {
    const info = dex.moves.get(slot.id);
    const type = info.id === 'hiddenpower' ? mon.hpType || info.type : info.type;
    const category = info.category === 'Status' ? 'Status' : isPhysicalType(type) ? 'Physical' : 'Special';
    return {
      name: info.id === 'hiddenpower' ? `Hidden Power ${type}` : info.name,
      type,
      category,
      power: info.basePower || (info.damage ? 'Lv' : null),
      accuracy: info.accuracy === true ? null : info.accuracy,
      pp: slot.pp,
      maxpp: slot.maxpp,
      desc: info.shortDesc,
      effect: category === 'Status' ? '' : effectiveness(type, foe),
    };
  });
}

// Everything the summary screen shows about one of the simulator's Pokémon.
function details(mon, foe, own) {
  const item = mon.item ? dex.items.get(mon.item) : null;
  const ability = mon.getAbility();
  return {
    species: mon.species.name,
    num: mon.species.num,
    shiny: Boolean(mon.set.shiny),
    level: mon.level,
    gender: mon.gender || '',
    types: mon.getTypes(),
    item: item?.name ?? '',
    itemDesc: itemHelp(item),
    ability: ability.name,
    abilityDesc: ability.shortDesc,
    nature: mon.set.nature,
    // RED's exact HP shows as a percentage, like in his info box.
    hp: own ? mon.hp : Math.ceil((mon.hp / mon.maxhp) * 100),
    maxhp: own ? mon.maxhp : 100,
    status: mon.fainted ? 'fnt' : mon.status || '',
    stats: { hp: mon.maxhp, ...mon.storedStats },
    moves: movesOf(mon, foe),
  };
}

function summarizeRequest(request) {
  if (!request || request.wait) return { kind: 'wait' };
  const battle = current.stream.battle;
  const team = battle.p1.pokemon; // request order = the simulator's party order
  const foe = battle.p2.active[0] && !battle.p2.active[0].fainted ? battle.p2.active[0] : null;
  const yours = battle.p1.active[0];
  const party = request.side.pokemon.map((p, i) => ({
    slot: i + 1,
    active: Boolean(p.active),
    ...details(team[i], foe, true),
  }));
  // RED's Pokémon on the field, with how its moves hit yours.
  const foeInfo = foe ? details(foe, yours && !yours.fainted ? yours : null, false) : null;
  if (request.forceSwitch) return { kind: 'switch', forced: true, party, foe: foeInfo };
  const active = request.active[0];
  const activeMon = battle.p1.active[0];
  const moves = active.moves.map((m, i) => {
    const info = dex.moves.get(m.move.replace(/ \d+$/, ''));
    const type = info.id.startsWith('hiddenpower') ? activeMon.hpType || info.type : info.type;
    const category = info.category === 'Status' ? 'Status' : isPhysicalType(type) ? 'Physical' : 'Special';
    return {
      slot: i + 1,
      name: info.exists ? info.name : m.move,
      type,
      category,
      power: info.basePower || null,
      pp: m.pp ?? null,
      maxpp: m.maxpp ?? null,
      disabled: Boolean(m.disabled) || m.pp === 0,
      effect: category === 'Status' ? '' : effectiveness(type, foe),
    };
  });
  return {
    kind: 'move',
    species: activeMon.species.name,
    ability: activeMon.getAbility().name,
    moves,
    canSwitch: !active.trapped && !active.maybeTrapped,
    party,
    foe: foeInfo,
  };
}

// How a move of this type hits RED's Pokémon, by type alone: 'super',
// 'weak', 'none' or 'normal' (abilities like Levitate aren't counted).
function effectiveness(type, foe) {
  if (!foe || foe.fainted) return '';
  const types = foe.getTypes();
  if (!dex.getImmunity(type, types)) return 'none';
  const e = dex.getEffectiveness(type, types);
  return e > 0 ? 'super' : e < 0 ? 'weak' : 'normal';
}

// --- Shift ------------------------------------------------------------------------
// FireRed's "Shift" battle style: when one of RED's Pokémon faints, he says
// which one comes out next and the player may switch first, for free. The
// simulator has no such step, so when RED has to replace a fainted Pokémon
// (and yours is still standing), his pick is held back and the player is
// asked. A yes becomes the same free switch U-turn gives (the active
// Pokémon's switchFlag, then a fresh switch request for both sides); then
// RED's held pick goes in.

function canShift(sim) {
  const yours = sim.p1.active[0];
  return Boolean(yours && !yours.fainted && sim.p1.pokemon.some((p) => !p.isActive && !p.fainted));
}

// The question for the page: RED's next Pokémon, and your party as it is now.
function shiftOffer(sim, slot) {
  const next = sim.p2.pokemon[slot - 1];
  const foe = details(next, sim.p1.active[0], false);
  return {
    kind: 'shift',
    next: next.species.name,
    canSwitch: true,
    party: sim.p1.pokemon.map((mon, i) => ({ slot: i + 1, active: Boolean(mon.isActive), ...details(mon, next, true) })),
    foe,
  };
}

// The player's answer: 'switch <slot>' to shift, anything else to stay in.
function answerShift(battle, choice) {
  const sim = battle.stream.battle;
  const slot = Number(/^switch (\d+)$/.exec(choice)?.[1]);
  const mon = sim.p1.pokemon[slot - 1];
  if (!mon || mon.isActive || mon.fainted) {
    const held = battle.shift.choice;
    battle.shift = null;
    battle.streams.p2.write(held);
    return;
  }
  battle.shift.state = 'switching';
  battle.shiftSlot = slot;
  sim.p1.active[0].switchFlag = true;
  sim.makeRequest('switch');
  for (const side of sim.sides) side.emitRequest();
  sim.sentRequests = true;
}

async function readPlayer(battle) {
  const { client, formatter, streams } = battle;
  for await (const chunk of streams.p1) {
    if (battle !== current) return;
    if (chunk.startsWith('|request|')) {
      const request = Protocol.parseRequest(chunk.slice(9));
      client.update(request);
      if (request.forceSwitch && battle.shiftSlot) {
        // The free switch the player already picked.
        const slot = battle.shiftSlot;
        battle.shiftSlot = null;
        streams.p1.write(`switch ${slot}`);
        continue;
      }
      // "Wait for RED" while he's asking the Shift question: keep the question up.
      if (request.wait && battle.shift) continue;
      post({ type: 'request', request: summarizeRequest(request) });
      continue;
    }
    const events = [];
    let winner = null;
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('|')) continue;
      const { args, kwArgs } = Protocol.parseBattleLine(line);
      const text = cleanText(formatter.formatText(args, kwArgs));
      client.add(args, kwArgs);
      if (args[0] === 'win') winner = args[1];
      if (args[0] === 'tie') winner = '';
      if (args[0] === 'win' || args[0] === 'tie') continue;
      const anim = animFor(args, kwArgs);
      if (text.length) {
        text.forEach((t, i) => events.push({ text: t, state: snapshot(client), anim: i === 0 ? anim : null }));
      } else if (STATE_LINES.has(args[0]) || anim) {
        events.push({ state: snapshot(client), anim });
      }
      if (args[0] === 'turn') events.push({ turn: client.turn, state: snapshot(client) });
    }
    if (events.length) post({ type: 'events', events });
    if (winner !== null) post({ type: 'end', won: winner !== '' && winner === client.p1.name, tie: winner === '' });
  }
}

async function readRed(battle) {
  for await (const chunk of battle.streams.p2) {
    if (battle !== current) return;
    if (!chunk.startsWith('|request|')) continue;
    const request = JSON.parse(chunk.slice(9));
    if (request.wait || request.teamPreview) continue;
    if (request.forceSwitch && battle.shift?.state === 'switching') {
      // Asked again after the player's free switch: the Pokémon he announced.
      const held = battle.shift.choice;
      battle.shift = null;
      battle.streams.p2.write(held);
      continue;
    }
    let choice = 'default';
    try {
      choice = chooseForRed(calc, dex, battle.stream.battle, request);
    } catch (err) {
      console.error('RED AI failed', err);
    }
    const slot = Number(/^switch (\d+)$/.exec(choice)?.[1]);
    if (request.forceSwitch && slot && canShift(battle.stream.battle)) {
      battle.shift = { choice, state: 'asking' };
      post({ type: 'request', request: shiftOffer(battle.stream.battle, slot) });
      continue;
    }
    battle.streams.p2.write(choice);
  }
}

// The player's name in the battle log: Showdown takes up to 18 characters
// and no protocol separators, and it mustn't match RED's (that's how the
// winner is told apart).
function playerName(name) {
  const clean = String(name || '').replace(/[|\n\r,]/g, '').trim().slice(0, 18);
  return clean && clean.toLowerCase() !== 'red' ? clean : 'You';
}

function start({ seed, version, order, name }) {
  const team = generateTeam(dex, seed, version);
  const ordered = order && order.length === team.length ? order.map((i) => team[i]) : team;
  const stream = new BattleStreams.BattleStream();
  const streams = BattleStreams.getPlayerStreams(stream);
  const client = new ClientBattle(gens);
  const battle = { stream, streams, client, formatter: new LogFormatter('p1', client) };
  current = battle;
  readPlayer(battle).catch((err) => post({ type: 'error', message: String(err?.message || err) }));
  readRed(battle).catch((err) => post({ type: 'error', message: String(err?.message || err) }));
  const player = (who, sets) => JSON.stringify({ name: who, team: Teams.pack(sets) });
  streams.omniscient.write([
    `>start ${JSON.stringify({ formatid: 'gen3customgame' })}`,
    `>player p1 ${player(playerName(name), ordered)}`,
    `>player p2 ${player('RED', RED_TEAM)}`,
  ].join('\n'));
}

onmessage = ({ data }) => {
  try {
    switch (data.type) {
      case 'team':
        post({ type: 'team', seed: data.seed, version: data.version, team: generateTeam(dex, data.seed, data.version).map(describe), red: RED_TEAM.map(describe) });
        break;
      case 'start':
        start(data);
        break;
      case 'choose':
        if (current?.shift?.state === 'asking') answerShift(current, data.choice);
        else current?.streams.p1.write(data.choice);
        break;
      case 'forfeit':
        current?.streams.omniscient.write('>forcelose p1');
        break;
      default:
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String(err?.message || err) });
  }
};
