// The banner over today's card in Discord (bot.mjs): the Daily Red logo over
// a FireRed-style field, with Pikachu and RED on their platforms. It never
// changes, so build-sprites.mjs draws it once, into web/sprites/banner.png,
// and the site serves it like any other image. Drawn at 340x120 like a GBA
// screen and doubled to 680x240, with no image library: the scenery is drawn
// here, the lettering is activity/banner-title.png
// (scripts/draw-banner-title.mjs) and the sprites are the site's own.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

const W = 340;
const H = 120;
const SCALE = 2;
const COLOURS = {
  sky: ['#5fa8e8', '#7cc0f0', '#a0d4f4', '#c4e6f8'],
  hillFar: '#7fbf6a', hillNear: '#5ea254',
  grass: '#9fd27a', grassTufts: '#8cc46a', grassEdge: '#78b45c',
  padTop: '#d8eeb0', pad: '#b8dc8c', padEdge: '#5e9a48',
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// `sprites`: a folder like web/sprites/ (front/25.png and trainers/red.png).
// Returns the banner as a PNG.
export function drawBanner({ sprites, title = join(dirname(fileURLToPath(import.meta.url)), 'banner-title.png') }) {
  const px = new Uint8Array(W * H * 4);
  const fill = (x, y, w, h, hex) => {
    const [r, g, b] = rgb(hex);
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
        const o = (yy * W + xx) * 4;
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
      }
    }
  };
  // A filled ellipse, row by row, with hard pixel edges.
  const ellipse = (cx, cy, rx, ry, hex) => {
    for (let dy = -ry; dy <= ry; dy++) {
      const w = Math.round(rx * Math.sqrt(1 - (dy / (ry + 0.5)) ** 2));
      fill(cx - w, cy + dy, w * 2, 1, hex);
    }
  };
  const hills = (base, hex, seed) => {
    for (let x = 0; x < W; x++) {
      const h = Math.round(10 + 7 * Math.sin((x + seed) / 23) + 4 * Math.sin((x + seed * 3) / 9));
      fill(x, base - h, 1, h + H, hex);
    }
  };
  const pad = (cx, cy, rx, ry) => {
    ellipse(cx, cy, rx + 1, ry + 1, COLOURS.padEdge);
    ellipse(cx, cy, rx, ry, COLOURS.pad);
    ellipse(cx, cy - 2, rx - 4, ry - 3, COLOURS.padTop);
  };
  // Pastes an image's opaque pixels at (x, y).
  const paste = (file, x, y) => {
    const img = decodePng(readFileSync(file));
    for (let yy = 0; yy < img.height; yy++) {
      for (let xx = 0; xx < img.width; xx++) {
        const s = (yy * img.width + xx) * 4;
        const tx = x + xx; const ty = y + yy;
        if (img.data[s + 3] < 128 || tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const o = (ty * W + tx) * 4;
        px[o] = img.data[s]; px[o + 1] = img.data[s + 1]; px[o + 2] = img.data[s + 2]; px[o + 3] = 255;
      }
    }
  };

  COLOURS.sky.forEach((hex, i) => fill(0, Math.round((74 * i) / 4), W, 19, hex));
  hills(72, COLOURS.hillFar, 12);
  hills(82, COLOURS.hillNear, 60);
  fill(0, 79, W, H - 79, COLOURS.grass);
  for (let y = 83; y < H; y += 6) for (let x = (y * 7) % 11; x < W; x += 11) fill(x, y, 3, 1, COLOURS.grassTufts);
  fill(0, 79, W, 1, COLOURS.grassEdge);
  pad(280, 98, 52, 10);
  paste(join(sprites, 'trainers/red.png'), 248, 36);
  pad(190, 106, 34, 7);
  paste(join(sprites, 'front/25.png'), 158, 46);
  paste(title, 0, 0);

  // Doubled, pixel for pixel.
  const big = new Uint8Array(W * SCALE * H * SCALE * 4);
  for (let y = 0; y < H * SCALE; y++) {
    for (let x = 0; x < W * SCALE; x++) {
      const s = (Math.floor(y / SCALE) * W + Math.floor(x / SCALE)) * 4;
      big.set(px.subarray(s, s + 4), (y * W * SCALE + x) * 4);
    }
  }
  return encodePng({ width: W * SCALE, height: H * SCALE, data: big });
}
