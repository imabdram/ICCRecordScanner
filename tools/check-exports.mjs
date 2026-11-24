// Verifies that every named import actually exists in the target module.
// A missing export is a white screen: the module graph fails before any code runs.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = process.argv[2] ?? 'src';
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.js')) files.push(full);
  }
}
walk(root);

const exportsOf = (file) => {
  const text = readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) {
      const part = piece.trim().split(/\s+as\s+/);
      const name = (part[1] ?? part[0] ?? '').trim();
      if (name) names.add(name);
    }
  }
  return names;
};

const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec);
    let names;
    try {
      names = exportsOf(target);
    } catch {
      problems.push(`${file}: cannot read ${spec}`);
      continue;
    }
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!names.has(name)) problems.push(`${file}: '${name}' is not exported by ${spec}`);
    }
  }
}

if (problems.length) {
  for (const p of problems) console.log('FAIL ', p);
  process.exit(1);
}
console.log(`exports OK: ${files.length} module(s) checked`);
