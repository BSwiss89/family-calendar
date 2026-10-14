import test from 'node:test';
import assert from 'node:assert/strict';
import { isApprovedPwaPrebuildOnly } from './check-pwa-prebuild-only.mjs';

const original = {
  name: 'calendar',
  scripts: { build: 'tsc -b && vite build', preview: 'vite preview' },
  dependencies: { react: '^19.2.8' },
  devDependencies: { vite: '^8.2.2' }
};
const approved = () => ({
  ...structuredClone(original),
  scripts: { ...original.scripts, prebuild: 'node scripts/generate-pwa-icons.mjs' }
});

test('allows only the expected prebuild addition', () => {
  assert.equal(isApprovedPwaPrebuildOnly(original, approved()), true);
});
test('rejects runtime dependency changes', () => {
  const next = approved();
  next.dependencies.react = '^20.0.0';
  assert.equal(isApprovedPwaPrebuildOnly(original, next), false);
});
test('rejects dev dependency changes', () => {
  const next = approved();
  next.devDependencies.vite = '^9.0.0';
  assert.equal(isApprovedPwaPrebuildOnly(original, next), false);
});
test('rejects any unrelated script change', () => {
  const next = approved();
  next.scripts.build = 'echo unsafe';
  assert.equal(isApprovedPwaPrebuildOnly(original, next), false);
});
test('rejects a different prebuild command', () => {
  const next = approved();
  next.scripts.prebuild = 'node arbitrary.mjs';
  assert.equal(isApprovedPwaPrebuildOnly(original, next), false);
});
test('rejects changes to other package metadata', () => {
  const next = approved();
  next.name = 'different';
  assert.equal(isApprovedPwaPrebuildOnly(original, next), false);
});
test('rejects a prebuild modification when prebuild already existed', () => {
  assert.equal(isApprovedPwaPrebuildOnly(approved(), approved()), false);
});
test('rejects malformed manifests', () => {
  assert.equal(isApprovedPwaPrebuildOnly(null, approved()), false);
  assert.equal(isApprovedPwaPrebuildOnly(original, { scripts: {} }), false);
});
