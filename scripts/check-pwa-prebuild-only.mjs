// Permit only the exact PWA prebuild addition as a frontend-safe manifest change.
// All other package.json changes must use the separate dependency review.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isApprovedPwaPrebuildOnly(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object' ||
      Array.isArray(before) || Array.isArray(after)) return false;
  if (!before.scripts || !after.scripts ||
      typeof before.scripts !== 'object' || typeof after.scripts !== 'object' ||
      Array.isArray(before.scripts) || Array.isArray(after.scripts)) return false;
  if (Object.hasOwn(before.scripts, 'prebuild')) return false;
  if (after.scripts.prebuild !== 'node scripts/generate-pwa-icons.mjs') return false;

  const normalizedAfter = structuredClone(after);
  delete normalizedAfter.scripts.prebuild;
  // JSON text from git show preserves key order for existing keys. Compare
  // normalized objects without relying on the position of the new script.
  return deepEqual(before, normalizedAfter);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== typeof b || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length &&
    keysA.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

function runCli() {
  const [repository, from, to] = process.argv.slice(2);
  if (!repository || !/^[a-f0-9]{40}$/i.test(from ?? '') || !/^[a-f0-9]{40}$/i.test(to ?? '')) {
    console.error('Expected repository path, old commit SHA, new commit SHA.');
    process.exitCode = 1;
    return;
  }
  try {
    const read = (sha) => JSON.parse(execFileSync('git', ['-C', repository, 'show', sha + ':package.json'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true
    }));
    if (!isApprovedPwaPrebuildOnly(read(from), read(to))) {
      console.error('BLOCKED: package.json differs beyond the approved PWA prebuild addition.');
      process.exitCode = 1;
      return;
    }
    console.log('[PASS] Only the approved PWA prebuild script was added to package.json.');
  } catch (error) {
    console.error('BLOCKED: Could not validate package.json changes:', error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
