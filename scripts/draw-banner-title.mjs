// Draws activity/banner-title.png: the "DAILY RED / One battle a day"
// lettering on the banner over today's card (activity/banner.mjs), in the
// site's pixel font with a dark outline, at the banner's native size (340x120,
// the rest transparent). The build can't draw text without a browser, so this
// is made once and kept in the repository; run it again only to change the
// lettering.
//
//   cd tests && npm install && node ../scripts/draw-banner-title.mjs
//
// Needs web/vendor/pixelify-sans.woff2 (scripts/fetch-vendor.sh) and Chromium.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = createRequire(join(ROOT, 'tests/package.json'))('playwright-core');
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome']
  .filter(Boolean).find((p) => existsSync(p));
const font = `data:font/woff2;base64,${readFileSync(join(ROOT, 'web/vendor/pixelify-sans.woff2')).toString('base64')}`;

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
const png = await page.evaluate(async (font) => {
  const face = new FontFace('Pixelify', `url(${font})`, { weight: '400 700' });
  await face.load();
  document.fonts.add(face);
  const [W, H] = [340, 120];
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
  text('DAILY', 14, 19, 32, '#f6f7fb');
  text('RED', 104, 19, 32, '#d63a3a');
  text('One battle a day', 15, 55, 13, '#f6f7fb');
  return out.toDataURL('image/png');
}, font);
await browser.close();
writeFileSync(join(ROOT, 'activity/banner-title.png'), Buffer.from(png.split(',')[1], 'base64'));
console.log('Wrote activity/banner-title.png');
