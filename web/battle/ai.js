// RED's decisions. He sees the real battle (both sides' exact stats, moves and
// HP, like FireRed's trainer AI does) and scores each option:
//   - a move that knocks the target out beats everything (priority moves get
//     a bonus when he'd otherwise move second);
//   - otherwise damaging moves score their expected damage as a share of the
//     target's HP, times accuracy;
//   - status moves score when they're worth it (sleep or paralysis on a
//     healthy target, healing when hurt, Calm Mind while it's safe...);
//   - he never switches by choice; when a Pokémon faints he sends in the one
//     that matches up best against the player's.
// A little randomness keeps him from being completely predictable.
//
// `calc` is @smogon/calc, `dex` the simulator's Dex.forGen(3), `battle` the
// simulator's live Battle (from BattleStream.battle).

// How sharp RED is. NOISE is the random spread added to each move's score
// (scores run about 0-100 for damage, 100+ for a KO); MISTAKE_CHANCE is how
// often he picks a random sensible move instead of the best one. Raise them to
// make him easier. Measured against a bot that plays the player's random team
// greedily (about 1 win in 10 with these settings; see the README).
export const DIFFICULTY = { NOISE: 12, MISTAKE_CHANCE: 0.1 };

const WEATHER = { raindance: 'Rain', sunnyday: 'Sun', sandstorm: 'Sand', hail: 'Hail' };

function calcPokemon(calc, gen, mon) {
  return new calc.Pokemon(gen, mon.species.name, {
    level: mon.level,
    item: mon.item ? mon.getItem().name : undefined,
    ability: mon.getAbility().name,
    nature: mon.set.nature,
    evs: mon.set.evs,
    ivs: mon.set.ivs,
    boosts: { ...mon.boosts },
    curHP: mon.hp,
    status: mon.status || '',
    gender: mon.gender || 'N',
  });
}

function calcField(calc, battle, defender) {
  const conditions = defender.side.sideConditions;
  return new calc.Field({
    weather: WEATHER[battle.field.weather] || undefined,
    defenderSide: { isReflect: Boolean(conditions.reflect), isLightScreen: Boolean(conditions.lightscreen) },
  });
}

// Damage stats for `moveName` from attacker to defender: average and minimum
// as a share of the defender's current HP, and the chance one hit KOs.
export function damageOf(calc, battle, attacker, defender, moveName) {
  const gen = calc.Generations.get(3);
  let result;
  try {
    result = calc.calculate(gen, calcPokemon(calc, gen, attacker), calcPokemon(calc, gen, defender),
      new calc.Move(gen, moveName), calcField(calc, battle, defender));
  } catch {
    return { avg: 0, ko: 0 };
  }
  const rolls = Array.isArray(result.damage) ? result.damage.flat() : [result.damage];
  const hp = Math.max(1, defender.hp);
  const avg = rolls.reduce((a, b) => a + b, 0) / rolls.length;
  return { avg: Math.min(1, avg / hp), ko: rolls.filter((d) => d >= hp).length / rolls.length };
}

const accuracyOf = (move) => (move.accuracy === true ? 1 : move.accuracy / 100);

function immuneToStatus(dex, target, move) {
  if (target.status) return true;
  if (move.id === 'thunderwave') return target.hasType('Ground') || target.hasType('Electric');
  if (move.status === 'psn' || move.status === 'tox') return target.hasType('Poison') || target.hasType('Steel');
  if (move.status === 'brn') return target.hasType('Fire');
  return false;
}

function scoreStatusMove(dex, battle, user, target, move) {
  const hpShare = user.hp / user.maxhp;
  switch (move.id) {
    case 'rest':
      if (user.status === 'slp') return -100;
      return hpShare < 0.35 || (user.status && hpShare < 0.6) ? 95 : -50;
    case 'morningsun':
    case 'recover':
    case 'softboiled':
    case 'synthesis':
    case 'moonlight':
      return hpShare < 0.5 ? 90 : -50;
    case 'calmmind':
      if (user.boosts.spa >= 4 || hpShare < 0.6) return -20;
      return 72 - 18 * user.boosts.spa;
    case 'leechseed':
      return target.hasType('Grass') || target.volatiles.leechseed ? -100 : 55;
    default:
      if (move.status) return immuneToStatus(dex, target, move) ? -100 : move.status === 'slp' ? 85 : 70;
      return 10;
  }
}

function scoreMove(calc, dex, battle, user, target, moveId) {
  const move = dex.moves.get(moveId);
  if (move.category === 'Status') return scoreStatusMove(dex, battle, user, target, move);
  const { avg, ko } = damageOf(calc, battle, user, target, move.name);
  if (avg <= 0) return -100; // immune
  const acc = accuracyOf(move);
  if (ko > 0) {
    const outsped = target.getStat('spe') > user.getStat('spe');
    const recoilKO = move.recoil && (target.hp * move.recoil[0]) / move.recoil[1] >= user.hp;
    return 100 + 60 * ko * acc + (move.priority > 0 && outsped ? 40 : 0) - (recoilKO ? 30 : 0);
  }
  let score = 100 * avg * acc;
  // Recoil (Volt Tackle): the share of his own HP he'd lose, weighed in.
  if (move.recoil) {
    const recoil = (avg * target.hp * move.recoil[0]) / move.recoil[1];
    score -= 70 * Math.min(1, recoil / Math.max(1, user.hp));
  }
  return score;
}

// How well `mon` would do against `foe`: its best expected damage minus the
// foe's best against it.
export function matchup(calc, dex, battle, mon, foe) {
  const best = (a, b) => Math.max(0, ...a.moveSlots.map((slot) => {
    const move = dex.moves.get(slot.id);
    if (move.category === 'Status') return 0;
    const { avg, ko } = damageOf(calc, battle, a, b, move.name);
    return avg + ko;
  }));
  return best(mon, foe) - best(foe, mon);
}

// The choice string for RED's side ("move 2", "switch 3", "default").
export function chooseForRed(calc, dex, battle, request, random = Math.random) {
  return chooseFor('p2', calc, dex, battle, request, random);
}

// The same reasoning for either side (the tests use it to play for p1 too).
export function chooseFor(sideId, calc, dex, battle, request, random = Math.random) {
  const side = battle[sideId];
  const foe = battle[sideId === 'p1' ? 'p2' : 'p1'].active[0];

  if (request.forceSwitch) {
    let bestSlot = 0;
    let bestScore = -Infinity;
    request.side.pokemon.forEach((p, i) => {
      if (p.active || p.condition.endsWith(' fnt')) return;
      const mon = side.pokemon[i];
      const score = foe && !foe.fainted ? matchup(calc, dex, battle, mon, foe) + random() * 0.05 : -i;
      if (score > bestScore) {
        bestScore = score;
        bestSlot = i + 1;
      }
    });
    return bestSlot ? `switch ${bestSlot}` : 'default';
  }

  if (request.active) {
    const user = side.active[0];
    const options = request.active[0].moves
      .map((m, i) => ({ id: m.id, slot: i + 1, disabled: m.disabled || m.pp === 0 }))
      .filter((m) => !m.disabled);
    if (!options.length || !foe || foe.fainted) return 'move 1';
    const scored = options.map((option) => ({
      ...option,
      score: scoreMove(calc, dex, battle, user, foe, option.id) + random() * DIFFICULTY.NOISE,
    }));
    if (sideId === 'p2' && random() < DIFFICULTY.MISTAKE_CHANCE) {
      const sensible = scored.filter((o) => o.score > 0);
      if (sensible.length) return `move ${sensible[Math.floor(random() * sensible.length)].slot}`;
    }
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    return `move ${best.slot}`;
  }
  return 'default';
}
