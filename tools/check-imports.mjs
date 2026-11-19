// Static import-graph check for the web bundle.
//
//   node check-imports.mjs <project-root>
//
// There is no bundler available in this sandbox (Vite needs to spawn child
// processes), so this walks every relative import from the entry point and
// fails if a target is missing, or if a file imports something it no longer
// exports. It does not execute the modules.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.argv[2] ?? '.';
const ENTRY = join(ROOT, 'src', 'main.js');

const IMPORT_RE = /^\s*import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
const EXPORT_RE = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;

const errors = [];
const seen = new Set();
const modules = new Map(); // path -> Set(exports)

function exportsOf(file) {
  if (modules.has(file)) return modules.get(file);
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(EXPORT_RE)) names.add(m[1]);
  // `export { a, b }` / `export { a as b }`
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/);
      const name = (bits[1] ?? bits[0])?.trim();
      if (name) names.add(name);
    }
  }
  modules.set(file, names);
  return names;
}

function walk(file) {
  const abs = resolve(file);
  if (seen.has(abs)) return;
  seen.add(abs);
  if (!existsSync(abs)) {
    errors.push(`missing file: ${abs}`);
    return;
  }

  const src = readFileSync(abs, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const clause = m[1] ?? '';
    const spec = m[2];

    // Bare specifiers are packages (resolved by node_modules); skip them, but
    // flag anything still pointing at the retired Neon packages.
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      if (spec.includes('neon')) errors.push(`${abs}: still imports "${spec}"`);
      continue;
    }

    const target = resolve(dirname(abs), spec);
    if (!existsSync(target)) {
      errors.push(`${abs}: cannot resolve "${spec}"`);
      continue;
    }

    // Named imports must actually be exported by the target.
    const named = [];
    const braces = clause.match(/\{([\s\S]*?)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        const name = bits[0]?.trim();
        if (name && name !== 'default') named.push(name);
      }
    }
    const available = exportsOf(target);
    for (const name of named) {
      if (!available.has(name)) {
        errors.push(`${abs}: imports { ${name} } from "${spec}" but it is not exported there`);
      }
    }

    walk(target);
  }
}

walk(ENTRY);

console.log(`modules reachable from ${ENTRY}: ${seen.size}`);
for (const file of [...seen].sort()) {
  console.log('  ' + file.replace(resolve(ROOT) + '\\', '').replaceAll('\\', '/'));
}

if (errors.length) {
  console.log('\nPROBLEMS:');
  for (const e of [...new Set(errors)]) console.log('  ! ' + e);
  process.exit(1);
}
console.log('\nimport graph OK');
