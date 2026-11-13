// Today's card picture: the day's six lined up on the grass with RED waiting
// on his platform, FireRed style. The bot puts it on top of the daily card
// (bot.mjs) and the server draws it on request (GET /card/<date>.png,
// app.mjs). Drawn at 400x200 like a GBA screen and doubled to 800x400, with no
// image library: the scenery is drawn here, the lettering is
// activity/card-title.png (scripts/draw-card-title.mjs) and the sprites are
// the site's own (web/sprites/, scripts/get-sprites.sh).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

const W = 400;
const H = 200;
const SCALE = 2;
const COLOURS = {
  sky: ['#5fa8e8', '#7cc0f0', '#a0d4f4', '#c4e6f8'],
  hillFar: '#7fbf6a', hillNear: '#5ea254',
  grass: '#9fd27a', grassTufts: '#8cc46a', grassEdge: '#78b45c',
  padTop: '#d8eeb0', pad: '#b8dc8c', padEdge: '#5e9a48',
};
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Returns paint(team): the picture for [{ num, shiny }] (the day's order) as a PNG.
export function createCardPainter({ webRoot, title = join(dirname(fileURLToPath(import.meta.url)), 'card-title.png') }) {
  const lettering = decodePng(readFileSync(title));
  const red = decodePng(readFileSync(join(webRoot, 'sprites/trainers/red.png')));
  const sprite = (mon) => decodePng(readFileSync(join(webRoot, `sprites/front${mon.shiny ? '-shiny' : ''}`, `${Number(mon.num)}.png`)));

  return function paint(team) {
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
    const paste = (img, x, y) => {
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

    COLOURS.sky.forEach((hex, i) => fill(0, (120 * i) / 4, W, 30, hex));
    hills(112, COLOURS.hillFar, 5);
    hills(122, COLOURS.hillNear, 40);
    fill(0, 118, W, H - 118, COLOURS.grass);
    for (let y = 122; y < H; y += 6) for (let x = (y * 7) % 11; x < W; x += 11) fill(x, y, 3, 1, COLOURS.grassTufts);
    fill(0, 118, W, 1, COLOURS.grassEdge);
    pad(336, 92, 54, 11);
    paste(red, 304, 28);
    pad(200, 178, 196, 16);
    team.slice(0, 6).forEach((mon, i) => paste(sprite(mon), 8 + i * 64, 124));
    paste(lettering, 0, 0);

    // Doubled, pixel for pixel.
    const big = new Uint8Array(W * SCALE * H * SCALE * 4);
    for (let y = 0; y < H * SCALE; y++) {
      for (let x = 0; x < W * SCALE; x++) {
        const s = (Math.floor(y / SCALE) * W + Math.floor(x / SCALE)) * 4;
        big.set(px.subarray(s, s + 4), (y * W * SCALE + x) * 4);
      }
    }
    return encodePng({ width: W * SCALE, height: H * SCALE, data: big });
  };
}
