import test from 'node:test'
import assert from 'node:assert/strict'
import { isAppSourcePath, parseTreeEntries, compareSourceTrees } from './report-source-content-alignment.mjs'

test('includes only application source paths, not deployment configuration', () => {
  assert.equal(isAppSourcePath('src/App.tsx'), true)
  assert.equal(isAppSourcePath('Server/index.mjs'), true)
  assert.equal(isAppSourcePath('scripts/deploy.ps1'), false)
  assert.equal(isAppSourcePath('.github/workflows/build.yml'), false)
  assert.equal(isAppSourcePath('Serverish/file.mjs'), false)
})

test('parses NUL-delimited git tree data, including filenames containing spaces', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const tree = parseTreeEntries('100644 blob ' + a + '\tsrc/profile picker.tsx\0' +
    '100644 blob ' + b + '\tServer/index.mjs\0' +
    '100644 blob ' + b + '\tscripts/deploy.ps1\0')
  assert.deepEqual([...tree.entries()], [['src/profile picker.tsx', a], ['Server/index.mjs', b]])
})

test('classifies exact file contents instead of branch history or diff status', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const c = 'c'.repeat(40)
  const live = new Map([['src/same.ts', a], ['src/changed.ts', a], ['Server/live.mjs', b]])
  const staging = new Map([['src/same.ts', a], ['src/changed.ts', c], ['Server/test.mjs', b]])
  const result = compareSourceTrees(live, staging)
  assert.deepEqual(result.counts, { identical: 1, different: 1, live_only: 1, test_only: 1 })
  assert.deepEqual(result.files.map(x => [x.path, x.status]), [
    ['Server/live.mjs', 'live_only'],
    ['Server/test.mjs', 'test_only'],
    ['src/changed.ts', 'different'],
    ['src/same.ts', 'identical'],
  ])
  assert.equal(result.files.find(x => x.path === 'src/same.ts').liveBlob, a)
  assert.equal(result.files.find(x => x.path === 'src/same.ts').testBlob, a)
})

test('refuses a malformed or duplicate tree record instead of reporting false parity', () => {
  const oid = 'a'.repeat(40)
  const row = '100644 blob ' + oid + '\tsrc/App.tsx\0'
  assert.throws(() => parseTreeEntries('broken-entry\0'), /Unexpected git ls-tree entry/)
  assert.throws(() => parseTreeEntries(row + row), /Duplicate path/)
  assert.throws(() => parseTreeEntries(null), /must be text/)
})

test('does not include non-source paths supplied by callers', () => {
  const report = compareSourceTrees(new Map([['docs/report.md', 'one']]), new Map([['docs/report.md', 'two']]))
  assert.equal(report.totalPaths, 0)
  assert.deepEqual(report.counts, { identical: 0, different: 0, live_only: 0, test_only: 0 })
})
