// Bundles Discord's Embedded App SDK into one browser module,
// web/vendor/discord-sdk.js, so the site keeps its no-build-step setup: like
// the emulator files from scripts/fetch-vendor.sh, it's a vendored file that
// web/discord.js imports only when the page runs inside Discord.
//
//   cd activity && npm ci && npm run build-sdk
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const vendor = fileURLToPath(new URL('../web/vendor/', import.meta.url));
mkdirSync(vendor, { recursive: true });

await build({
  stdin: {
    contents: "export { DiscordSDK, Events } from '@discord/embedded-app-sdk';",
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
  },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  legalComments: 'eof',
  outfile: `${vendor}discord-sdk.js`,
  logLevel: 'info',
});

copyFileSync(
  fileURLToPath(new URL('./node_modules/@discord/embedded-app-sdk/LICENSE.md', import.meta.url)),
  `${vendor}discord-sdk.LICENSE.txt`,
);
