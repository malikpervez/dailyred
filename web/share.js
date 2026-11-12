// The result picture for sharing, like Wordle's grid but with sprites: the
// day's number, how it went, and both teams with the fainted Pokémon greyed
// out. Your team is drawn in the day's order, never your battle order, so the
// picture doesn't give away anyone's lead.
import { spriteUrl } from './battle/view.js';

const WIDTH = 1200;
const HEIGHT = 720;
const FONT = '"Pixelify Sans", ui-monospace, monospace';
const COLORS = {
  page: '#17181d',
  band: '#d63a3a',
  bandDeep: '#a92a2a',
  text: '#f2f4f8',
  muted: '#9aa4b5',
  gold: '#f0b232',
  slot: '#22242b',
  line: '#30333c',
};

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // a missing sprite leaves an empty slot
    img.src = src;
  });
}

// A 64×64 sprite as a canvas, in grey if it fainted (pixel by pixel:
// canvas filters aren't in every Safari).
function spriteCanvas(img, fainted) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || 64;
  c.height = img.naturalHeight || 64;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  if (fainted) {
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const grey = Math.round(px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11);
      px[i] = px[i + 1] = px[i + 2] = Math.round(grey * 0.55 + 20);
      px[i + 3] = Math.round(px[i + 3] * 0.6);
    }
    ctx.putImageData(data, 0, 0);
  }
  return c;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Shrinks the font until `text` fits in `max` pixels.
function fitText(ctx, text, weight, size, max) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  while (s > 12 && ctx.measureText(text).width > max) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
}

// result: { title: 'Daily Red No. 12', date: 'Thu, Nov 12', outcome: 'won' | 'lost' | 'ran',
//   headline, detail, team: [{ num, shiny, fainted }], red: [{ num, fainted }], footer }
// Resolves to a <canvas>.
export async function drawShareImage(result) {
  await document.fonts?.load(`700 64px ${FONT}`).catch(() => {});
  const images = await Promise.all([...result.team, ...result.red].map((m) => loadImage(spriteUrl(m.num, { shiny: m.shiny }))));

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.textBaseline = 'middle';

  ctx.fillStyle = COLORS.page;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Header band: the name and the day.
  ctx.fillStyle = COLORS.band;
  ctx.fillRect(0, 0, WIDTH, 96);
  ctx.fillStyle = COLORS.bandDeep;
  ctx.fillRect(0, 92, WIDTH, 4);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText(result.title, 48, 48);
  ctx.textAlign = 'right';
  ctx.font = `600 32px ${FONT}`;
  ctx.fillText(result.date ?? '', WIDTH - 48, 50);

  // How it went.
  ctx.textAlign = 'left';
  ctx.fillStyle = result.outcome === 'won' ? COLORS.gold : COLORS.text;
  fitText(ctx, result.headline, 700, 68, WIDTH - 96);
  ctx.fillText(result.headline, 48, 160);
  ctx.fillStyle = COLORS.muted;
  fitText(ctx, result.detail, 500, 32, WIDTH - 96);
  ctx.fillText(result.detail, 48, 218);

  // The two teams.
  const rows = [
    { label: 'YOU', mons: result.team, images: images.slice(0, result.team.length), y: 268 },
    { label: 'RED', mons: result.red, images: images.slice(result.team.length), y: 462 },
  ];
  const slot = 160;
  const left = 196;
  for (const row of rows) {
    ctx.textAlign = 'left';
    ctx.fillStyle = row.label === 'RED' ? COLORS.band : COLORS.text;
    ctx.font = `700 40px ${FONT}`;
    ctx.fillText(row.label, 48, row.y + 80);
    ctx.fillStyle = COLORS.muted;
    ctx.font = `500 22px ${FONT}`;
    const alive = row.mons.filter((m) => !m.fainted).length;
    ctx.fillText(`${alive} left`, 48, row.y + 120);
    row.mons.forEach((mon, i) => {
      const x = left + i * slot;
      ctx.fillStyle = COLORS.slot;
      roundRect(ctx, x, row.y, slot - 16, 168, 16);
      ctx.fill();
      const img = row.images[i];
      if (img) ctx.drawImage(spriteCanvas(img, mon.fainted), x + 8, row.y + 20, 128, 128);
      if (mon.fainted) {
        ctx.strokeStyle = COLORS.band;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(x + slot - 50, row.y + 16);
        ctx.lineTo(x + slot - 30, row.y + 36);
        ctx.moveTo(x + slot - 30, row.y + 16);
        ctx.lineTo(x + slot - 50, row.y + 36);
        ctx.stroke();
      }
    });
  }

  // Footer.
  ctx.fillStyle = COLORS.line;
  ctx.fillRect(48, 656, WIDTH - 96, 2);
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 24px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(result.footer ?? '', 48, 690);
  ctx.textAlign = 'right';
  ctx.fillText('Can you beat RED?', WIDTH - 48, 690);
  return canvas;
}

export const canvasToBlob = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't make the picture"))), 'image/png');
});
