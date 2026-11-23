// Builds the release artefacts: build/server.mjs and build/package.json.
// `dist/` is produced by `npm run build`, which `npm run build:release` runs
// first. Keeping both halves in one command is the point: a deployed client and
// a deployed server that disagree is a bug nobody notices until a shot resolves
// differently on two machines.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const ws = pkg.dependencies?.ws ?? '^8.18.0';

mkdirSync('build', { recursive: true });

await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  // ws is CommonJS and calls require() internally, which cannot run inside an
  // ESM bundle. It is installed beside the bundle from this manifest instead.
  external: ['ws'],
  outfile: 'build/server.mjs',
  logLevel: 'warning',
});

writeFileSync(
  'build/package.json',
  `${JSON.stringify(
    {
      name: '8ball-server',
      private: true,
      type: 'module',
      dependencies: { ws },
    },
    null,
    2,
  )}\n`,
);

console.log('release: build/server.mjs and build/package.json written');
