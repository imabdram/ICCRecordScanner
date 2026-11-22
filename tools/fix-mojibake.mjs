// Repairs UTF-8 text that was read as CP1252 and re-saved (mojibake).
//
//   node tools/fix-mojibake.mjs src/main.js src/views/records.js ...
//
// A whole-file byte round-trip only works when the file is uniformly damaged.
// Once part of a file has been fixed, or it contains a correctly-encoded "…"
// next to a broken "â€¦", that approach either fails or corrupts the good parts.
//
// So this replaces exact known sequences instead, longest first, and repeats
// until nothing changes. Text that is already correct is never touched.
import { readFileSync, writeFileSync } from 'node:fs';

// Double-encoded first: they contain the single-encoded forms as substrings.
const REPLACEMENTS = [
  // doubly mangled
  ['Ã¢â‚¬Â¦', '…'],
  ['Ã¢â‚¬â€œ', '–'],
  ['Ã¢â‚¬â€\u009d', '”'],
  ['Ã¢â‚¬â„¢', '’'],
  ['Ã¢â‚¬Å“', '“'],
  ['Ã¢â‚¬â€', '—'],
  ['Ã‚Â·', '·'],
  ['Ã‚ ', ' '],
  ['Ã¢â‚¬', ''],

  // singly mangled
  ['â€¦', '…'],
  ['â€œ', '“'],
  ['â€\u009d', '”'],
  ['â€™', '’'],
  ['â€“', '–'],
  ['â€”', '—'],
  ['Â·', '·'],
  ['Â ', ' '],
  ['â€¢', '•'],
  ['â‚', '›'],
];

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tools/fix-mojibake.mjs <files...>');
  process.exit(2);
}

let changed = 0;
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  let text = before;

  // Two passes so a double-encoded sequence that produced a new single-encoded
  // one still gets cleaned up in the same run.
  for (let pass = 0; pass < 3; pass += 1) {
    let next = text;
    for (const [from, to] of REPLACEMENTS) {
      next = next.split(from).join(to);
    }
    if (next === text) break;
    text = next;
  }

  // A control character would mean a sequence we did not intend to produce.
  if (/[\u0080-\u009F]/.test(text)) {
    console.log(`SKIP    ${file} (result would contain control characters)`);
    continue;
  }

  if (text === before) {
    console.log(`ok      ${file}`);
    continue;
  }

  writeFileSync(file, text.replace(/^\uFEFF/, ''), 'utf8');
  console.log(`fixed   ${file}`);
  changed += 1;
}

console.log(`\n${changed} file(s) rewritten`);
