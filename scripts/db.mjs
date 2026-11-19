#!/usr/bin/env node
/**
 * Neon database helper for the SIM Management System.
 *
 * There is no `psql` binary on this machine, so this script reuses the Neon
 * CLI's bundled pure-JavaScript psql implementation to run SQL against the
 * linked branch. It is a development/admin tool only; the apps never call it.
 *
 * Usage:
 *   node scripts/db.mjs sql "select 1"            run SQL, print results
 *   node scripts/db.mjs sql-file scripts/schema.sql
 *   node scripts/db.mjs admin-create <email> <password> <name> [role] [outlet_id]
 *   node scripts/db.mjs admin-list               list users with their scope
 *
 * Connection order: $DATABASE_URL, else `neon connection-string` for the
 * project in .neon.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function findPsqlChunk() {
  const roots = [
    process.env.NEON_DIST,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm/node_modules/neon/dist') : null,
  ].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    const dir = path.join(root, '_chunks');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      // Several psql-* chunks can exist; match the one exporting runPsql.
      if (entry.startsWith('psql-') && entry.endsWith('.js')) {
        candidates.push(path.join(dir, entry));
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error('Neon CLI psql chunk not found. Install with: npm i -g neon');
  }
  return candidates;
}

const RUN_PSQL_RE = /^async\s*\(\s*argv\s*,\s*stdio/;

export async function loadRunPsql() {
  for (const file of findPsqlChunk()) {
    const mod = await import(pathToFileURL(file).href);
    // Minified builds rename exports, so identify the psql entry point by its
    // signature: `async (argv, stdio = {}) => ...`.
    const candidate = Object.values(mod).find(
      (v) => typeof v === 'function' && RUN_PSQL_RE.test(v.toString().trim()),
    );
    if (candidate) return candidate;
  }
  throw new Error('Could not identify runPsql() in the Neon CLI chunks.');
}

export function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  const linkFile = path.join(projectRoot, '.neon');
  if (!existsSync(linkFile)) {
    throw new Error('No $DATABASE_URL and no .neon link file. Run `neon link` first.');
  }
  const projectId = readFileSync(linkFile, 'utf8').match(/projectId\s*=\s*"([^"]+)"/)?.[1];
  if (!projectId) throw new Error('Could not read projectId from .neon');
  return execFileSync('neon', ['connection-string', '--project-id', projectId], {
    encoding: 'utf8',
  }).trim();
}

/** Runs SQL and returns captured stdout/stderr/exit code. */
export async function runSql(sql) {
  const runPsql = await loadRunPsql();
  let stdout = '';
  let stderr = '';
  const sink = (target) => ({
    isTTY: false,
    write(chunk) {
      if (target === 'out') stdout += chunk;
      else stderr += chunk;
      return true;
    },
  });
  const code = await runPsql([connectionString(), '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sql], {
    stdin: { isTTY: false, on() {}, removeListener() {}, pause() {}, resume() {}, setEncoding() {} },
    stdout: sink('out'),
    stderr: sink('err'),
  });
  return { code, stdout, stderr };
}

export async function runFile(file) {
  return runSql(readFileSync(path.resolve(projectRoot, file), 'utf8'));
}

const [, , command, ...rest] = process.argv;
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    if (command === 'sql') {
      const { code, stdout, stderr } = await runSql(rest.join(' '));
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      process.exitCode = code;
    } else if (command === 'sql-file') {
      const { code, stdout, stderr } = await runFile(rest[0]);
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      process.exitCode = code;
    } else if (command === 'connection') {
      const cs = new URL(connectionString());
      console.log(`host=${cs.hostname} db=${cs.pathname.slice(1)} user=${cs.username}`);
    } else {
      console.log('Commands: sql "<SQL>" | sql-file <path> | connection');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('ERROR:', error.message);
    process.exitCode = 1;
  }
}
