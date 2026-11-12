// Move animations for the battle screen, made from FireRed's own animation
// graphics (fx-sprites.js). Not a port of FireRed's animation scripts: each
// move has a short recipe built from a few effects (bursts, projectiles,
// falling or rising particles, lightning, lunges, shakes, tints), with a
// default per type and kind of move for everything without its own recipe.
//
// Sizes are in GBA pixels (the screen is 240 wide), so the effects keep the
// game's proportions however big the battle screen is drawn.

import { FX_SPRITES } from './fx-sprites.js';

const GBA_WIDTH = 240;
const rand = (min, max) => min + Math.random() * (max - min);
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

export function createFx(scene, { sprites, getScale }) {
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  const overlay = document.createElement('div');
  overlay.className = 'fx-overlay';
  const weatherLayer = document.createElement('div');
  weatherLayer.className = 'fx-weather';
  scene.append(weatherLayer, overlay, layer);

  const px = () => scene.clientWidth / GBA_WIDTH; // CSS pixels per GBA pixel
  const ms = (n) => n * getScale();

  // Where a side's Pokémon is, in scene pixels.
  function spot(side) {
    const sprite = sprites[side];
    const box = scene.getBoundingClientRect();
    const r = sprite.getBoundingClientRect();
    if (!r.width) {
      const k = px();
      return side === 'p1' ? { x: 64 * k, y: 120 * k, w: 64 * k, h: 64 * k } : { x: 176 * k, y: 52 * k, w: 64 * k, h: 64 * k };
    }
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height * 0.55, w: r.width, h: r.height };
  }

  // A sprite sheet element centred on (x, y).
  function make(name, x, y, { scale = 1, frame = null } = {}) {
    const fx = FX_SPRITES[name];
    const k = px() * scale;
    const node = document.createElement('div');
    node.className = 'fx';
    const w = fx.w * k;
    const h = fx.h * k;
    Object.assign(node.style, {
      width: `${w}px`,
      height: `${h}px`,
      left: `${x - w / 2}px`,
      top: `${y - h / 2}px`,
      backgroundImage: `url(sprites/fx/${name}.png)`,
      backgroundSize: `${w}px ${h * fx.frames}px`,
      backgroundPositionY: frame == null ? '0px' : `${-frame * h}px`,
    });
    layer.append(node);
    let frames = null;
    const play = (duration, loop = false) => {
      if (fx.frames < 2 || frame != null) return;
      frames = node.animate(
        [{ backgroundPositionY: '0px' }, { backgroundPositionY: `${-h * fx.frames}px` }],
        { duration, iterations: loop ? Infinity : 1, easing: `steps(${fx.frames})`, fill: 'forwards' },
      );
    };
    const remove = () => { frames?.cancel(); node.remove(); };
    return { node, w, h, play, remove };
  }

  // --- Effects ------------------------------------------------------------------------

  // Plays a sheet once in place.
  async function burst(name, at, { duration = 420, scale = 1, dx = 0, dy = 0, frame = null, fade = true } = {}) {
    const s = make(name, at.x + dx * px(), at.y + dy * px(), { scale, frame });
    const d = ms(duration);
    s.play(d);
    const keys = fade ? [{ opacity: 1 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }] : [{ opacity: 1 }, { opacity: 1 }];
    await s.node.animate(keys, { duration: d, fill: 'forwards' }).finished.catch(() => {});
    s.remove();
  }

  // Flies a sprite from one point to another, optionally in an arc.
  async function projectile(name, from, to, { duration = 380, arc = 0, scale = 1, frame = null, spin = false, grow = 1 } = {}) {
    const s = make(name, from.x, from.y, { scale, frame });
    const d = ms(duration);
    s.play(d / 2, true);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lift = -arc * px();
    // Shots going right to left (RED's) face the other way; the mirroring
    // comes last so it doesn't reverse the movement.
    const mirror = to.x < from.x && !spin ? ' scaleX(-1)' : '';
    const keys = [
      { transform: `translate(0, 0) rotate(0) scale(1)${mirror}` },
      { transform: `translate(${dx / 2}px, ${dy / 2 + lift}px) rotate(${spin ? 180 : 0}deg) scale(${(1 + grow) / 2})${mirror}` },
      { transform: `translate(${dx}px, ${dy}px) rotate(${spin ? 360 : 0}deg) scale(${grow})${mirror}` },
    ];
    await s.node.animate(keys, { duration: d, easing: 'linear', fill: 'forwards' }).finished.catch(() => {});
    s.remove();
  }

  // Several projectiles one after another (Flamethrower, Ice Beam...).
  async function stream(name, from, to, { count = 6, gap = 70, ...options } = {}) {
    const all = [];
    for (let i = 0; i < count; i++) {
      all.push(projectile(name, from, to, options));
      await wait(ms(gap));
    }
    await Promise.all(all);
  }

  // Particles dropping onto a point from above (powders, rocks, hail).
  async function fall(name, at, { count = 8, spread = 36, height = 70, duration = 520, gap = 45, scale = 1, frame = null } = {}) {
    const k = px();
    const all = [];
    for (let i = 0; i < count; i++) {
      const x = at.x + rand(-spread, spread) * k;
      const s = make(name, x, at.y - height * k, { scale, frame });
      const d = ms(duration);
      s.play(d, true);
      all.push(s.node.animate(
        [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${height * k * 0.9}px)`, opacity: 1, offset: 0.8 }, { transform: `translateY(${height * k}px)`, opacity: 0 }],
        { duration: d, easing: 'ease-in', fill: 'forwards' },
      ).finished.catch(() => {}).then(s.remove));
      await wait(ms(gap));
    }
    await Promise.all(all);
  }

  // Particles floating up from a point (bubbles, healing sparkles, Zs).
  async function rise(name, at, { count = 5, spread = 22, height = 40, duration = 650, gap = 90, scale = 1, frame = null } = {}) {
    const k = px();
    const all = [];
    for (let i = 0; i < count; i++) {
      const s = make(name, at.x + rand(-spread, spread) * k, at.y + rand(0, 14) * k, { scale, frame });
      const d = ms(duration);
      s.play(d, true);
      all.push(s.node.animate(
        [{ transform: 'translateY(0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translateY(${-height * k}px)`, opacity: 0 }],
        { duration: d, easing: 'ease-out', fill: 'forwards' },
      ).finished.catch(() => {}).then(s.remove));
      await wait(ms(gap));
    }
    await Promise.all(all);
  }

  // Sprites circling a point (Swords Dance).
  async function orbit(name, at, { count = 4, radius = 26, duration = 700, scale = 1 } = {}) {
    const k = px();
    const all = [];
    for (let i = 0; i < count; i++) {
      const s = make(name, at.x, at.y, { scale });
      const start = (360 / count) * i;
      const keys = [0, 0.25, 0.5, 0.75, 1].map((t) => {
        const a = ((start + t * 360) * Math.PI) / 180;
        return { transform: `translate(${Math.cos(a) * radius * k}px, ${Math.sin(a) * radius * k * 0.5}px)`, opacity: t === 1 ? 0 : 1 };
      });
      all.push(s.node.animate(keys, { duration: ms(duration), fill: 'forwards' }).finished.catch(() => {}).then(s.remove));
    }
    await Promise.all(all);
  }

  // A lightning bolt from the top of the screen down to a point.
  async function strike(at, { bolts = 1 } = {}) {
    const k = px();
    const segment = 32 * k;
    const all = [];
    for (let b = 0; b < bolts; b++) {
      const x = at.x + (bolts > 1 ? rand(-18, 18) * k : 0);
      const pieces = [];
      for (let y = at.y; y > -segment; y -= segment * 0.9) pieces.push(make('lightning', x, y, { frame: 0 }));
      all.push((async () => {
        await Promise.all(pieces.map((p) => p.node.animate(
          [{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }, { opacity: 0 }],
          { duration: ms(420), fill: 'forwards' },
        ).finished.catch(() => {})));
        pieces.forEach((p) => p.remove());
      })());
      await wait(ms(90));
    }
    flashScreen('#fff8b0', 160);
    await Promise.all([...all, burst('electricity', at, { duration: 360 })]);
  }

  // The attacker darts toward the target and back.
  async function lunge(side, target, { distance = 0.28, duration = 260 } = {}) {
    const sprite = sprites[side];
    const from = spot(side);
    const dx = (target.x - from.x) * distance;
    const dy = (target.y - from.y) * distance;
    await sprite.animate(
      [{ translate: '0 0' }, { translate: `${dx}px ${dy}px`, offset: 0.45 }, { translate: '0 0' }],
      { duration: ms(duration), easing: 'ease-out' },
    ).finished.catch(() => {});
  }

  async function shake(target, { amount = 4, times = 4, duration = 320 } = {}) {
    const k = px() * amount;
    const keys = [{ translate: '0 0' }];
    for (let i = 0; i < times; i++) keys.push({ translate: `${i % 2 ? k : -k}px 0` });
    keys.push({ translate: '0 0' });
    await target.animate(keys, { duration: ms(duration) }).finished.catch(() => {});
  }

  // Tints a sprite briefly (a glow, or darker).
  async function glow(side, filter, { duration = 520, times = 2 } = {}) {
    const keys = [{ filter: 'none' }];
    for (let i = 0; i < times; i++) keys.push({ filter }, { filter: 'none' });
    await sprites[side].animate(keys, { duration: ms(duration) }).finished.catch(() => {});
  }

  // Colours the whole scene for a moment.
  async function tint(color, { duration = 600, opacity = 0.45 } = {}) {
    overlay.style.background = color;
    await overlay.animate(
      [{ opacity: 0 }, { opacity, offset: 0.25 }, { opacity, offset: 0.7 }, { opacity: 0 }],
      { duration: ms(duration) },
    ).finished.catch(() => {});
  }

  function flashScreen(color, duration) {
    return tint(color, { duration, opacity: 0.6 });
  }

  // A wall of water sweeping across the scene (Surf).
  async function wave() {
    const node = document.createElement('div');
    node.className = 'fx-wave';
    layer.append(node);
    await node.animate(
      [{ transform: 'translateY(100%)', opacity: 0.9 }, { transform: 'translateY(10%)', opacity: 0.9, offset: 0.5 }, { transform: 'translateY(-110%)', opacity: 0 }],
      { duration: ms(900), easing: 'ease-in-out' },
    ).finished.catch(() => {});
    node.remove();
  }

  // Coloured streaks running up (stat rose) or down (fell) over a Pokémon,
  // clipped to its outline like in FireRed.
  async function statChange(side, up) {
    const sprite = sprites[side];
    const box = scene.getBoundingClientRect();
    const r = sprite.getBoundingClientRect();
    if (!r.width) return;
    const node = document.createElement('div');
    node.className = `fx-stat ${up ? 'is-up' : 'is-down'}`;
    Object.assign(node.style, {
      left: `${r.left - box.left}px`,
      top: `${r.top - box.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    node.style.webkitMaskImage = node.style.maskImage = `url("${sprite.currentSrc || sprite.src}")`;
    layer.append(node);
    const shift = r.height * 0.6;
    await node.animate(
      [
        { backgroundPosition: `0 ${up ? 0 : -shift}px`, opacity: 0 },
        { opacity: 0.9, offset: 0.15 },
        { opacity: 0.9, offset: 0.85 },
        { backgroundPosition: `0 ${up ? -shift * 2 : shift}px`, opacity: 0 },
      ],
      { duration: ms(800) },
    ).finished.catch(() => {});
    node.remove();
  }

  // A Poké Ball opening where the Pokémon appears.
  async function sendOut(side) {
    const at = spot(side);
    await burst('light', at, { duration: 260, scale: 0.6 });
  }

  // --- Weather (stays until it ends) ------------------------------------------------------

  function setWeather(weather) {
    weatherLayer.dataset.weather = { RainDance: 'rain', SunnyDay: 'sun', Sandstorm: 'sand', Hail: 'hail' }[weather] ?? '';
  }

  // --- Moves --------------------------------------------------------------------------------

  const ctx = { burst, projectile, stream, fall, rise, orbit, strike, lunge, shake, glow, tint, wave, statChange, sprites, px };

  async function move(info) {
    const a = spot(info.side);
    const t = info.self ? a : spot(info.target);
    const recipe = MOVES[info.id] ?? defaultRecipe(info);
    await recipe({ ...ctx, a, t, side: info.side, targetSide: info.self ? info.side : info.target, info });
  }

  // The little animations that go with other battle messages.
  async function event(anim) {
    const at = () => spot(anim.side);
    switch (anim.kind) {
      case 'stat':
        return statChange(anim.side, anim.up);
      case 'status':
      case 'cant':
        return statusEffect(anim.status ?? anim.reason, anim.side, at());
      case 'residual':
        return residual(anim.from, anim.side, at());
      case 'heal':
        return rise('sparkles', at(), { count: 3, spread: 14, height: 26, gap: 120 });
      case 'crit':
        return tint('#ffffff', { duration: 180, opacity: 0.7 });
      case 'protect':
        return burst('shield', at(), { duration: 600, scale: 0.9 });
      case 'enter':
        return sendOut(anim.side);
      case 'weather':
        setWeather(anim.weather);
        return null;
      default:
        return null;
    }
  }

  async function statusEffect(status, side, at) {
    switch (status) {
      case 'par': return Promise.all([burst('electricity', at, { duration: 420 }), glow(side, 'brightness(1.3) sepia(1) saturate(4) hue-rotate(15deg)')]);
      case 'brn': return Promise.all([burst('fire', at, { duration: 480, scale: 0.8, dy: 6 }), glow(side, 'sepia(1) saturate(4) hue-rotate(-30deg)')]);
      case 'psn':
      case 'tox': return Promise.all([rise('poison', at, { count: 4 }), glow(side, 'sepia(1) saturate(3) hue-rotate(240deg)')]);
      case 'slp': return rise('zzz', at, { count: 2, spread: 8, height: 30, scale: 0.6, gap: 220 });
      case 'frz': return burst('ice', at, { duration: 480 });
      case 'confusion': return orbit('twinkleGold', { x: at.x, y: at.y - 24 * px() }, { count: 3, radius: 14, duration: 650 });
      case 'flinch': return shake(sprites[side], { amount: 2, times: 2 });
      default: return null;
    }
  }

  async function residual(from, side, at) {
    switch (from) {
      case 'psn': case 'tox': return statusEffect('psn', side, at);
      case 'brn': return statusEffect('brn', side, at);
      case 'leechseed': return rise('greenOrb', at, { count: 4, spread: 12, height: 24 });
      case 'sandstorm': return burst('dirt', at, { duration: 360 });
      case 'hail': return fall('hail', at, { count: 4, height: 40, spread: 20, duration: 360 });
      case 'recoil': return shake(sprites[side], { amount: 2, times: 3 });
      default: return null;
    }
  }

  return { move, event, setWeather, clear: () => { layer.replaceChildren(); setWeather(''); } };
}

// --- Recipes --------------------------------------------------------------------------------
// Each gets { a (attacker), t (target), side, targetSide, and the effects }.

const hitTarget = async (f, name = 'impact', options = {}) => {
  await Promise.all([f.burst(name, f.t, { duration: 300, ...options }), f.shake(f.sprites[f.targetSide], { amount: 3, times: 3, duration: 280 })]);
};

// Contact moves: dash in, then the hit.
const contact = (impact = 'impact', extra = null) => async (f) => {
  await f.lunge(f.side, f.t);
  await Promise.all([hitTarget(f, impact), extra?.(f)]);
};

// Ranged moves: a projectile (or a stream of them), then the hit.
const ranged = (shot, impact, { count = 1, scale = 1, arc = 0, duration = 380, spin = false } = {}) => async (f) => {
  if (count > 1) await f.stream(shot, f.a, f.t, { count, scale, arc, duration, spin });
  else await f.projectile(shot, f.a, f.t, { scale, arc, duration, spin });
  if (impact) await hitTarget(f, impact);
};

const powder = (name) => async (f) => f.fall(name, f.t, { count: 14, spread: 26, height: 60, gap: 35 });

const selfBoost = (name = null) => async (f) => {
  if (name === 'sword') await f.orbit('sword', f.a, { count: 3, radius: 22, scale: 0.7 });
  else if (name) await f.rise(name, f.a, { count: 4, spread: 18 });
  await f.statChange(f.side, true);
};

const heal = async (f) => {
  await Promise.all([f.glow(f.side, 'brightness(1.5)', { duration: 700 }), f.rise('sparkles', f.a, { count: 5, spread: 18, height: 34 })]);
};

const drain = async (f) => {
  await hitTarget(f, 'twinkle');
  await f.stream('greenOrb', f.t, f.a, { count: 6, gap: 60, duration: 420, arc: 14 });
  await f.rise('sparkles', f.a, { count: 2, spread: 10, height: 20 });
};

// Per type: what a contact move adds, and what a ranged one shoots.
const TYPE_STYLE = {
  Normal: { shot: 'orb', impact: 'impact' },
  Fire: { shot: 'ember', impact: 'fire', count: 4 },
  Water: { shot: 'water', impact: 'splash', count: 6 },
  Electric: { shot: 'spark', impact: 'electricity' },
  Grass: { shot: 'leaf', impact: 'impact', count: 5 },
  Ice: { shot: 'crystal', impact: 'ice', count: 5 },
  Fighting: { shot: 'punch', impact: 'punch' },
  Poison: { shot: 'sludge', impact: 'poison', arc: 18 },
  Ground: { shot: 'dirt', impact: 'dirt' },
  Flying: { shot: 'airWave', impact: 'impact' },
  Psychic: { shot: 'ring', impact: 'twinkle' },
  Bug: { shot: 'needle', impact: 'impact', count: 3 },
  Rock: { shot: 'rock', impact: 'rock', arc: 20 },
  Ghost: { shot: 'shadowBall', impact: 'ghost' },
  Dragon: { shot: 'dragonFlame', impact: 'claw', count: 4 },
  Dark: { shot: 'shadowBall', impact: 'slash' },
  Steel: { shot: 'metal', impact: 'star' },
};

function defaultRecipe(info) {
  if (info.category === 'Status') {
    if (info.self) return selfBoost(info.boosts ? null : 'twinkle');
    if (info.status === 'slp') return powder('sleepPowder');
    if (info.status === 'par') return async (f) => f.burst('electricity', f.t, { duration: 500 });
    if (info.status === 'psn' || info.status === 'tox') return async (f) => f.rise('toxic', f.t, { count: 5 });
    return async (f) => {
      await f.projectile('ring', f.a, f.t, { scale: 0.5, grow: 1.6 });
      await f.statChange(f.targetSide, false);
    };
  }
  const style = TYPE_STYLE[info.type] ?? TYPE_STYLE.Normal;
  if (info.contact) {
    const extra = info.type === 'Normal' || info.type === 'Fighting' ? null : (f) => f.burst(style.impact, f.t, { duration: 380 });
    return contact(info.type === 'Fighting' ? 'punch' : 'impact', extra);
  }
  if (info.type === 'Psychic') return MOVES.psychic;
  if (info.type === 'Ground') return MOVES.earthquake;
  return ranged(style.shot, style.impact, { count: style.count ?? 1, arc: style.arc ?? 0 });
}

const MOVES = {
  // Electric
  thunderbolt: async (f) => f.strike(f.t),
  thunder: async (f) => f.strike(f.t, { bolts: 3 }),
  thunderwave: async (f) => {
    await f.projectile('spark', f.a, f.t, { duration: 300 });
    await f.burst('electricity', f.t, { duration: 520 });
  },
  thundershock: ranged('spark', 'electricity'),
  volttackle: async (f) => {
    await f.glow(f.side, 'brightness(1.4) sepia(1) saturate(5) hue-rotate(10deg)', { duration: 300, times: 1 });
    await f.lunge(f.side, f.t, { distance: 0.5, duration: 300 });
    await Promise.all([hitTarget(f, 'impact'), f.burst('electricity', f.t, { duration: 420 })]);
  },
  // Fire
  flamethrower: ranged('ember', 'fire', { count: 7, duration: 340 }),
  fireblast: async (f) => {
    await f.projectile('ember', f.a, f.t, { scale: 1.5 });
    await Promise.all([f.burst('fire', f.t, { duration: 640, scale: 1.4 }), f.burst('plume', f.t, { duration: 640, dy: -12 }), f.shake(f.sprites[f.targetSide])]);
  },
  overheat: async (f) => {
    await f.glow(f.side, 'sepia(1) saturate(5) hue-rotate(-20deg)', { duration: 300, times: 1 });
    await MOVES.fireblast(f);
  },
  ember: ranged('ember', 'fire', { count: 2 }),
  willowisp: ranged('wisp', null, { duration: 520, arc: 10 }),
  // Water
  surf: async (f) => {
    await f.wave();
    await hitTarget(f, 'splash');
  },
  hydropump: ranged('water', 'splash', { count: 10, scale: 1.3, duration: 300 }),
  hydrocannon: async (f) => {
    await f.stream('water', f.a, f.t, { count: 12, scale: 1.6, gap: 50, duration: 300 });
    await Promise.all([f.burst('splash', f.t, { scale: 1.6, duration: 500 }), f.shake(f.sprites[f.targetSide], { amount: 5 })]);
  },
  watergun: ranged('water', 'splash', { count: 5 }),
  bubblebeam: ranged('bubble', 'splash', { count: 7 }),
  waterfall: contact('splash', (f) => f.burst('splash', f.t, { scale: 1.3 })),
  raindance: async (f) => f.fall('rain', { x: f.px() * 120, y: f.px() * 80 }, { count: 14, spread: 110, height: 90, gap: 30 }),
  // Grass
  gigadrain: drain,
  megadrain: drain,
  absorb: drain,
  leechseed: async (f) => {
    await f.stream('seed', f.a, f.t, { count: 3, arc: 26, duration: 450 });
    await f.burst('sprout', f.t, { duration: 520, dy: 10 });
  },
  sleeppowder: powder('sleepPowder'),
  spore: powder('sleepPowder'),
  stunspore: powder('stunSpore'),
  poisonpowder: powder('powder'),
  razorleaf: ranged('leaf', 'impact', { count: 6, spin: true }),
  magicalleaf: ranged('leaf', 'impact', { count: 6, spin: true, arc: 20 }),
  solarbeam: ranged('greenOrb', 'impact', { count: 10, scale: 1.4, duration: 260 }),
  synthesis: heal,
  // Ice
  icebeam: ranged('crystal', 'ice', { count: 8, duration: 320 }),
  blizzard: async (f) => {
    await f.fall('snow', f.t, { count: 22, spread: 40, height: 60, gap: 22, scale: 1.5 });
    await hitTarget(f, 'ice');
  },
  icepunch: contact('punch', (f) => f.burst('ice', f.t)),
  hail: async (f) => f.fall('hail', { x: f.px() * 120, y: f.px() * 80 }, { count: 14, spread: 110, height: 90, gap: 30 }),
  // Fighting
  brickbreak: contact('punch', (f) => f.burst('hit', f.t)),
  crosschop: contact('slam'),
  skyuppercut: contact('punch', (f) => f.burst('slam', f.t)),
  bulkup: selfBoost('focus'),
  // Poison
  sludgebomb: ranged('sludge', 'poison', { arc: 30, scale: 1.5, duration: 460 }),
  sludge: ranged('sludge', 'poison', { arc: 20 }),
  toxic: async (f) => f.rise('toxic', f.t, { count: 6 }),
  // Ground
  earthquake: async (f) => {
    await Promise.all([
      f.shake(f.sprites.p1.parentElement, { amount: 3, times: 8, duration: 760 }),
      f.burst('dirt', f.t, { duration: 640, dy: 18, dx: -14 }),
      f.burst('dirt', f.t, { duration: 640, dy: 18, dx: 14 }),
      f.rise('rock', f.t, { count: 3, spread: 22, height: 20, frame: 4, gap: 120 }),
    ]);
  },
  magnitude: async (f) => MOVES.earthquake(f),
  // Flying
  aerialace: async (f) => {
    await f.lunge(f.side, f.t, { distance: 0.6, duration: 220 });
    await hitTarget(f, 'slash');
  },
  wingattack: contact('impact', (f) => f.burst('gust', f.t)),
  drillpeck: contact('horn'),
  // Psychic
  psychic: async (f) => {
    await Promise.all([f.tint('#e85ad0', { duration: 700, opacity: 0.35 }), f.shake(f.sprites[f.targetSide], { amount: 3, times: 6, duration: 700 })]);
  },
  confusion: async (f) => MOVES.psychic(f),
  hypnosis: async (f) => f.projectile('spiral', f.a, f.t, { scale: 0.6, spin: true, duration: 600 }),
  calmmind: selfBoost('twinkle'),
  amnesia: selfBoost('twinkle'),
  rest: async (f) => {
    await heal(f);
    await f.rise('zzz', f.a, { count: 2, spread: 8, scale: 0.6, gap: 200 });
  },
  // Rock
  rockslide: async (f) => {
    await f.fall('rock', f.t, { count: 5, spread: 24, height: 80, gap: 90, frame: 0, scale: 0.9 });
    await f.shake(f.sprites[f.targetSide]);
  },
  rockthrow: async (f) => MOVES.rockslide(f),
  // Ghost and Dark
  shadowball: ranged('shadowBall', 'ghost', { scale: 1.2, duration: 460 }),
  nightshade: async (f) => {
    await Promise.all([f.tint('#2a1238', { duration: 700, opacity: 0.55 }), f.shake(f.sprites[f.targetSide])]);
  },
  lick: contact('ghost'),
  bite: contact('fangs'),
  crunch: contact('fangs', (f) => f.burst('fangs', f.t, { scale: 1.3 })),
  faintattack: async (f) => {
    await f.glow(f.side, 'opacity(0.2)', { duration: 400, times: 1 });
    await hitTarget(f, 'slash');
  },
  // Dragon and Steel
  dragonclaw: contact('claw', (f) => f.burst('claw', f.t, { scale: 1.2 })),
  dragonbreath: ranged('dragonFlame', 'claw', { count: 5 }),
  outrage: contact('slam', (f) => f.tint('#e04030', { duration: 400, opacity: 0.3 })),
  irontail: contact('star', (f) => f.glow(f.side, 'brightness(1.6) grayscale(1)', { duration: 300, times: 1 })),
  metalclaw: contact('claw'),
  steelwing: contact('star'),
  // Normal
  quickattack: async (f) => {
    await f.lunge(f.side, f.t, { distance: 0.7, duration: 200 });
    await hitTarget(f);
  },
  extremespeed: async (f) => MOVES.quickattack(f),
  bodyslam: contact('slam'),
  doubleedge: contact('slam'),
  return: contact('impact', (f) => f.burst('star', f.t)),
  slash: contact('slash'),
  scratch: contact('scratch'),
  swordsdance: selfBoost('sword'),
  agility: selfBoost('blueStar'),
  morningsun: heal,
  moonlight: heal,
  recover: heal,
  softboiled: heal,
  milkdrink: heal,
  slackoff: heal,
  sunnyday: async (f) => f.tint('#ffd24a', { duration: 800, opacity: 0.4 }),
  sandstorm: async (f) => f.burst('dirt', { x: f.px() * 120, y: f.px() * 80 }, { scale: 3, duration: 700 }),
  protect: async (f) => f.burst('shield', f.a, { duration: 700, scale: 0.9 }),
  detect: async (f) => f.burst('shield', f.a, { duration: 700, scale: 0.9 }),
  sing: async (f) => f.stream('notes', f.a, f.t, { count: 4, arc: 20, duration: 600 }),
  supersonic: async (f) => f.stream('ring', f.a, f.t, { count: 3, scale: 0.4, grow: 1.4 }),
  substitute: async (f) => f.glow(f.side, 'opacity(0.3)', { duration: 600, times: 1 }),
  explosion: async (f) => {
    await Promise.all([f.burst('explosion', f.a, { scale: 2, duration: 700 }), f.tint('#ffffff', { duration: 500, opacity: 0.7 })]);
  },
  selfdestruct: async (f) => MOVES.explosion(f),
  spikes: async (f) => f.fall('needle', f.t, { count: 6, spread: 30, height: 30, gap: 60 }),
};
