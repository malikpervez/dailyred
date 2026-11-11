// Follows RED's battle by reading the game's RAM straight out of the emulator.
//
// The game keeps a status block in RAM (sStatus in pokefirered/src/dailyred.c):
// the magic "DAILYRED-STATUS1", the seed it was booted with, a phase byte and a
// result byte. We search the emulator's WebAssembly memory for the magic
// followed by our seed (the ROM's own copy of the magic isn't followed by it),
// remember where it is, and read the two bytes on each call.

const MAGIC = new Uint32Array(new TextEncoder().encode('DAILYRED-STATUS1').buffer);

export const PHASE = { EXPLORING: 0, BATTLE: 1, RESULT: 2, FINISHED: 3 };
export const RESULT = { NONE: 0, WON: 1, LOST: 2 };

// Returns read(): { phase, result }, or null until the game has set up its
// status block (just after boot).
//
// The emulator's memory is over 100 MB, and a whole search at once blocked
// the page long enough on iPhones that the game ran at about 1 frame a second
// and never got far enough to set the block up. So each call searches only the
// next slice (the browser's native indexOf finds candidates), going round
// until it's found: a few ms per call, a few seconds for the whole memory.
const SLICE_WORDS = 4 * 1024 * 1024; // 16 MB

export function createGameLink(emulator, seed) {
  let offset = -1;
  let cursor = 0;
  return function read() {
    const heap = emulator.getEmscriptenModule().HEAPU8; // replaced if memory grows
    if (offset < 0) {
      const words = new Uint32Array(heap.buffer, heap.byteOffset, heap.byteLength >>> 2);
      const end = Math.min(cursor + SLICE_WORDS, words.length - 5);
      offset = findStatus(words, seed >>> 0, cursor, end);
      cursor = end >= words.length - 5 ? 0 : end;
      if (offset < 0) return null;
    }
    return { phase: heap[offset + 20], result: heap[offset + 21] };
  };
}

// Byte offset of the status block if it starts at a word in [from, end), else -1.
function findStatus(words, seed, from, end) {
  const slice = words.subarray(from, end);
  for (let i = slice.indexOf(MAGIC[0]); i !== -1; i = slice.indexOf(MAGIC[0], i + 1)) {
    const w = from + i;
    if (words[w + 1] === MAGIC[1] && words[w + 2] === MAGIC[2]
     && words[w + 3] === MAGIC[3] && words[w + 4] === seed) {
      return w * 4;
    }
  }
  return -1;
}
