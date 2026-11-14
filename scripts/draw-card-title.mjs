// Draws activity/card-titles/<trainer>.png: the "DAILY RED / TODAY'S SIX vs
// BLUE" lettering on today's card picture (activity/card-image.mjs), one for
// each trainer on the Road to RED (web/road.js), in the site's pixel font with
// a dark outline, at the picture's native size (400x200, the rest
// transparent). The server can't draw text, so these are made once and kept
// in the repository; run it again to change the lettering or add a trainer.
//
//   cd tests && npm install && node ../scripts/draw-card-title.mjs
//
// Needs web/vendor/pixelify-sans.woff2 (scripts/fetch-vendor.sh) and Chromium.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'tests/package.json'))('playwright-core');
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .filter(Boolean).find((p) => existsSync(p));
const font = `data:font/woff2;base64,${readFileSync(join(ROOT, 'web/vendor/pixelify-sans.woff2')).toString('base64')}`;
const { TRAINERS } = await import(join(ROOT, 'web/road.js'));

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
const draw = (foe) => page.evaluate(async ({ font, foe }) => {
  const face = new FontFace('Pixelify', `url(${font})`, { weight: '400 700' });
  await face.load();
  document.fonts.add(face);
  const [W, H] = [400, 200];
  const layer = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return [c, c.getContext('2d')]; };
  const [out, ctx] = layer();
  // Canvas text is anti-aliased: keep only solid pixels, then add a 1px outline.
  const text = (words, x, y, size, fill) => {
    const [c, t] = layer();
    t.font = `700 ${size}px Pixelify`;
    t.textBaseline = 'top';
    t.fillStyle = fill;
    t.fillText(words, x, y);
    const d = t.getImageData(0, 0, W, H);
    for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] > 110 ? 255 : 0;
    t.putImageData(d, 0, 0);
    const [o, ot] = layer();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) ot.drawImage(c, dx, dy);
    ot.globalCompositeOperation = 'source-in';
    ot.fillStyle = '#14161c';
    ot.fillRect(0, 0, W, H);
    ctx.drawImage(o, 0, 0);
    ctx.drawImage(c, 0, 0);
  };
  text('DAILY', 12, 10, 28, '#f6f7fb');
  text('RED', 98, 10, 28, '#d63a3a');
  text(`TODAY'S SIX vs ${foe}`, 13, 42, 11, '#f6f7fb');
  return out.toDataURL('image/png');
}, { font, foe });
mkdirSync(join(ROOT, 'activity/card-titles'), { recursive: true });
for (const [id, { name }] of Object.entries(TRAINERS)) {
  const png = await draw(name.toUpperCase());
  writeFileSync(join(ROOT, `activity/card-titles/${id}.png`), Buffer.from(png.split(',')[1], 'base64'));
}
await browser.close();
console.log(`Wrote ${Object.keys(TRAINERS).length} letterings to activity/card-titles/`);
