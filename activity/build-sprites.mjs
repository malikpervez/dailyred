// Copies the FireRed battle sprites of all 386 Pokémon out of pret/pokefirered
// (graphics/pokemon/, see scripts/get-sprites.sh) into web/sprites/:
//
//   web/sprites/front/<dex number>.png        front-shiny/, back/, back-shiny/
//
// The source PNGs are 16-colour indexed images with colour 0 transparent, so
// they're used as they are; the shiny versions swap in shiny.pal. Deoxys's
// image holds two formes and FireRed's (Attack Forme) is the second, so that
// one is cut out. No image library needed: just the few PNG chunks these use.
//
//   node build-sprites.mjs <path to pokefirered> [<output dir>]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { Dex } from '@pkmn/sim';

const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2];
const out = process.argv[3] ?? join(here, '../web/sprites');
if (!source) {
  console.error('Usage: node build-sprites.mjs <path to pokefirered> [<output dir>]');
  process.exit(1);
}
const pokemonDir = join(source, 'graphics/pokemon');

// Folder names in graphics/pokemon/ that don't follow from the species name.
const FOLDERS = {
  nidoranf: 'nidoran_f', nidoranm: 'nidoran_m', mrmime: 'mr_mime', hooh: 'ho_oh',
  castform: 'castform/normal', unown: 'unown/a',
};
// Where the palettes are, if not next to the pictures.
const PALETTES = { unown: 'unown' };
const CROP_SECOND_FRAME = new Set(['deoxys']);

// --- Minimal PNG reading and writing ------------------------------------------------

function readChunks(buffer) {
  const chunks = [];
  for (let i = 8; i < buffer.length;) {
    const length = buffer.readUInt32BE(i);
    chunks.push({ type: buffer.toString('latin1', i + 4, i + 8), data: buffer.subarray(i + 8, i + 8 + length) });
    i += 12 + length;
  }
  return chunks;
}

function writeChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Undoes the PNG row filters (indexed images below 8 bits use 1 byte per pixel
// for the filter maths).
function unfilter(raw, height, rowBytes) {
  const rows = [];
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const start = y * (rowBytes + 1);
    const filter = raw[start];
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + rowBytes));
    for (let x = 0; x < rowBytes; x++) {
      const a = x > 0 ? row[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = (row[x] + add) & 0xff;
    }
    rows.push(row);
    prev = row;
  }
  return rows;
}

function readPalette(file) {
  const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(3);
  return Buffer.from(lines.flatMap((line) => line.trim().split(/\s+/).map(Number)));
}

// Returns the PNG with a new palette and, optionally, only rows [top, top+h).
function rewrite(png, { palette, crop }) {
  const chunks = readChunks(png);
  const ihdr = Buffer.from(chunks.find((c) => c.type === 'IHDR').data);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  let idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  if (crop) {
    const rowBytes = Math.ceil((width * bitDepth) / 8);
    const rows = unfilter(inflateSync(idat), height, rowBytes).slice(crop.top, crop.top + crop.height);
    idat = deflateSync(Buffer.concat(rows.flatMap((row) => [Buffer.from([0]), row])), { level: 9 });
    ihdr.writeUInt32BE(crop.height, 4);
  }
  const parts = [SIGNATURE, writeChunk('IHDR', ihdr)];
  const plte = chunks.find((c) => c.type === 'PLTE').data;
  parts.push(writeChunk('PLTE', palette ? palette.subarray(0, plte.length) : plte));
  const trns = chunks.find((c) => c.type === 'tRNS');
  parts.push(writeChunk('tRNS', trns ? trns.data : Buffer.from([0])));
  parts.push(writeChunk('IDAT', idat), writeChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// --- Sprites -----------------------------------------------------------------------

const dex = Dex.forGen(3);
const species = dex.species.all()
  .filter((s) => s.exists && s.num >= 1 && s.num <= 386 && !s.forme)
  .sort((a, b) => a.num - b.num);

for (const dir of ['front', 'front-shiny', 'back', 'back-shiny']) mkdirSync(join(out, dir), { recursive: true });

let count = 0;
for (const s of species) {
  const folder = join(pokemonDir, FOLDERS[s.id] ?? s.id);
  const paletteDir = join(pokemonDir, PALETTES[s.id] ?? FOLDERS[s.id] ?? s.id);
  const shiny = readPalette(join(paletteDir, 'shiny.pal'));
  for (const side of ['front', 'back']) {
    const file = join(folder, `${side}.png`);
    if (!existsSync(file)) throw new Error(`Missing ${file} for ${s.name}`);
    const png = readFileSync(file);
    const crop = CROP_SECOND_FRAME.has(s.id) ? { top: 64, height: 64 } : null;
    writeFileSync(join(out, side, `${s.num}.png`), crop ? rewrite(png, { crop }) : png);
    writeFileSync(join(out, `${side}-shiny`, `${s.num}.png`), rewrite(png, { palette: shiny, crop }));
  }
  count++;
}
console.log(`Wrote sprites for ${count} Pokémon to ${out}`);
