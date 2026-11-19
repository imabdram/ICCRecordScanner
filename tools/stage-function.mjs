// Stage the Edge Function for testing outside Deno.
//
//   node stage-function.mjs <project-root>
//
// This ONLY rewrites the source (npm: import -> global, Deno.serve(...) ->
// assignment). It deliberately spawns nothing: the sandbox blocks nested
// process spawns, so the TypeScript compile is a separate shell step.
//
// Full sequence (see test-admin-function.ps1):
//   node stage-function.mjs <root>
//   node node_modules/typescript/bin/tsc .fnbuild/stage.ts --target es2022 ...
//   node test-admin-function.mjs <root>
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.argv[2] ?? '.';
const SRC = join(ROOT, 'supabase', 'functions', 'admin-user', 'index.ts');
const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = join(HERE, '.fnbuild');

if (!existsSync(SRC)) {
  console.error(`source not found: ${SRC}`);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

// Two surgical rewrites. Everything else is the real function body.
const staged = readFileSync(SRC, 'utf8')
  .replace(
    /import \{ createClient \} from 'npm:@supabase\/supabase-js@2';/,
    'const createClient = globalThis.__createClient;',
  )
  .replace(/^Deno\.serve\(/m, 'globalThis.__handler = (');

const tsFile = join(OUT, 'stage.ts');
const jsFile = join(OUT, 'stage.js');

writeFileSync(tsFile, staged, 'utf8');

// Remove the previous JS so a failed/skipped compile can never leave old code
// in place (observed on Windows: tsc leaves the stale file behind).
if (existsSync(jsFile)) unlinkSync(jsFile);

// Per-load copies are single-use; clear them.
for (const f of readdirSync(OUT)) {
  if (/^run-\d+\.mjs$/.test(f)) {
    try { unlinkSync(join(OUT, f)); } catch { /* ignore */ }
  }
}

console.log(tsFile);
