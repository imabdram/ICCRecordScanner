// Reports files that still contain UTF-8-read-as-CP1252 damage.
//
//   node tools/check-encoding.mjs src index.html
//
// Patterns are written with \u escapes so this file stays pure ASCII and cannot
// itself be corrupted by a console that is not UTF-8.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

// "â€" is the tell-tale start of most sequences; "Ã" indicates double encoding.
const DAMAGE = [/\u00e2\u20ac/g, /\u00c3/g, /\u00c2/g];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.dart_tool', 'build', '.fnbuild']);

function walk(p) {
  const out = [];
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const entry of readdirSync(p)) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(join(p, entry)));
    }
  } else if (['.js', '.css', '.html', '.json', '.md'].includes(extname(p))) {
    out.push(p);
  }
  return out;
}

const targets = process.argv.slice(2);
const files = targets.flatMap((t) => walk(t));

let bad = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const hits = DAMAGE.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
  if (hits > 0) {
    console.log(`${hits}\t${file}`);
    bad += 1;
  }
}

console.log(bad === 0 ? `clean: ${files.length} file(s) checked` : `\n${bad} file(s) still damaged`);
process.exit(bad === 0 ? 0 : 1);
