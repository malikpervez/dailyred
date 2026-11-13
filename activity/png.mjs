// Just enough PNG for today's card picture (card-image.mjs), with no image
// library: reading the sprites (indexed colour, 1 to 8 bits) and the title
// lettering (8-bit RGBA), and writing RGBA.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // by colour type

// { width, height, data } with data as RGBA bytes, row by row.
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');
  let ihdr; let palette = null; let alpha = null;
  const idat = [];
  for (let i = 8; i < buffer.length;) {
    const length = buffer.readUInt32BE(i);
    const type = buffer.toString('latin1', i + 4, i + 8);
    const data = buffer.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alpha = data;
    else if (type === 'IDAT') idat.push(data);
    i += 12 + length;
  }
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, colorType, , , interlace] = ihdr.subarray(8, 13);
  const channels = CHANNELS[colorType];
  if (interlace || !channels || (colorType !== 3 && depth !== 8)) {
    throw new Error(`Unsupported PNG (colour type ${colorType}, ${depth}-bit${interlace ? ', interlaced' : ''})`);
  }
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, (channels * depth) / 8); // bytes per pixel, for the filters
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const start = y * (rowBytes + 1);
    const filter = raw[start];
    const row = Uint8Array.from(raw.subarray(start + 1, start + 1 + rowBytes));
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = (row[x] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const bit = x * depth;
        const index = (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        data[o] = palette[index * 3];
        data[o + 1] = palette[index * 3 + 1];
        data[o + 2] = palette[index * 3 + 2];
        // FireRed's sprites: colour 0 is see-through, tRNS chunk or not.
        data[o + 3] = alpha ? (index < alpha.length ? alpha[index] : 255) : index === 0 ? 0 : 255;
      } else {
        const p = x * channels;
        const grey = colorType === 0 || colorType === 4;
        data[o] = row[p];
        data[o + 1] = grey ? row[p] : row[p + 1];
        data[o + 2] = grey ? row[p] : row[p + 2];
        data[o + 3] = colorType === 6 ? row[p + 3] : colorType === 4 ? row[p + 1] : 255;
      }
    }
    prev = row;
  }
  return { width, height, data };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

// An RGBA image as a PNG file.
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // no filter: the picture is flat colours, which compress well anyway
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
