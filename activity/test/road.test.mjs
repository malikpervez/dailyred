// Tests for the Road to RED (web/road.js, web/battle/trainers.js):
//   cd activity && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dex, TeamValidator } from '@pkmn/sim';
import { ROAD, ROAD_START, TRAINERS, trainerOn, roadOpen } from '../../web/road.js';
import { TRAINER_TEAMS } from '../../web/battle/trainers.js';
import { RED_TEAM } from '../../web/battle/red.js';
import { DIFFICULTY } from '../../web/battle/ai.js';

const dex = Dex.forGen(3);

test('a new trainer every Monday from Nov 23, building up to RED, then round again; RED before that', () => {
  assert.equal(ROAD_START, '2026-11-23');
  assert.equal(new Date(`${ROAD_START}T12:00:00Z`).getUTCDay(), 1, 'a Monday');
  assert.deepEqual(ROAD, ['blue', 'steven', 'giovanni', 'lance', 'wallace', 'red']);
  const week = (d) => { const t = trainerOn(d); return `${t.id} ${t.week} ${t.from}..${t.to} next ${t.next.id} ${t.next.from}`; };
  assert.equal(week('2026-11-01'), 'red 0 null..null next blue 2026-11-23');
  assert.equal(week('2026-11-22'), 'red 0 null..null next blue 2026-11-23');
  assert.equal(week('2026-11-23'), 'blue 1 2026-11-23..2026-11-29 next steven 2026-11-30');
  assert.equal(week('2026-11-29'), 'blue 1 2026-11-23..2026-11-29 next steven 2026-11-30');
  assert.equal(week('2026-12-07'), 'giovanni 3 2026-12-07..2026-12-13 next lance 2026-12-14');
  assert.equal(week('2026-12-28'), 'red 6 2026-12-28..2027-01-03 next blue 2027-01-04');
  assert.equal(week('2027-01-04'), 'blue 1 2027-01-04..2027-01-10 next steven 2027-01-11');
  assert.ok(!roadOpen('2026-11-22') && roadOpen('2026-11-23'));
  assert.equal(trainerOn('2026-11-30').name, 'Steven');
});

test('every trainer has a legal level 100 team the AI can play, and RED is the sharpest', () => {
  const validator = new TeamValidator('gen3ou'); // real Gen 3 learnsets, egg moves and abilities
  const SETUP = new Set(['dragondance', 'swordsdance', 'bulkup', 'curse', 'agility', 'spikes', 'bellydrum', 'cosmicpower', 'irondefense']);
  for (const id of ROAD) {
    const { team, mistakes } = TRAINER_TEAMS[id];
    assert.ok(TRAINERS[id].name && TRAINERS[id].title && TRAINERS[id].style, id);
    assert.equal(team.length, 6, id);
    assert.equal(validator.validateTeam(team), null, id);
    for (const set of team) {
      assert.equal(set.level, 100, `${id} ${set.species}`);
      assert.deepEqual(Object.values(set.ivs), [31, 31, 31, 31, 31, 31]);
      assert.ok(Object.values(set.evs).reduce((a, b) => a + b, 0) <= 510);
      for (const move of set.moves) assert.ok(!SETUP.has(dex.toID(move)), `${id} ${set.species}: the AI wouldn't use ${move}`);
    }
    assert.ok(mistakes >= DIFFICULTY.MISTAKE_CHANCE, `${id} slips up at least as often as RED`);
  }
  assert.equal(TRAINER_TEAMS.red.team, RED_TEAM);
  assert.equal(TRAINER_TEAMS.red.mistakes, DIFFICULTY.MISTAKE_CHANCE);
});
