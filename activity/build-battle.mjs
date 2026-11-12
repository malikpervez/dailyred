// Bundles the battle engine (web/battle/worker.js and the Pokémon Showdown
// simulator it uses) into web/vendor/battle-worker.js, one classic Web Worker
// script, so the site needs no CDN or runtime build step. Also writes
// web/vendor/battle-worker.LICENSE.txt with the licenses of every package in
// the bundle.
//
//   cd activity && npm ci && npm run build-battle
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, '../web/vendor');
mkdirSync(vendor, { recursive: true });

const result = await build({
  entryPoints: [join(here, '../web/battle/worker.js')],
  outfile: join(vendor, 'battle-worker.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020', 'safari15'],
  // web/battle/ has no node_modules of its own; the packages live here.
  nodePaths: [join(here, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});

// Every npm package that ended up in the bundle, with its license text.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.add(match[1]);
}
const sections = [...packages].sort().map((name) => {
  const dir = join(here, 'node_modules', name);
  const info = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  const text = file && existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${info.license}`;
  return `${name} ${info.version} (${info.license})\n${'-'.repeat(60)}\n${text}\n`;
});
writeFileSync(join(vendor, 'battle-worker.LICENSE.txt'),
  `Packages bundled into battle-worker.js\n\n${sections.join('\n')}`);
console.log(`Built web/vendor/battle-worker.js (${[...packages].join(', ')})`);
