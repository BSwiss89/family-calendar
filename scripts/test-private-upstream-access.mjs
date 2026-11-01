import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  requirePrivateUpstreamToken, verifyPrivateUpstreamToken,
  PRIVATE_UPSTREAM_HEADER,
} from '../Server/private-upstream-access.mjs'

test('private backend requires unpredictable 256-bit secrets', () => {
  const first = randomBytes(32).toString('hex')
  const second = randomBytes(32).toString('hex')
  assert.equal(requirePrivateUpstreamToken(first), first)
  assert.equal(verifyPrivateUpstreamToken(first, first), true)
  assert.equal(verifyPrivateUpstreamToken(second, first), false)
  assert.equal(verifyPrivateUpstreamToken(undefined, first), false)
  assert.equal(verifyPrivateUpstreamToken([first], first), false)
  for (const invalid of [null, undefined, '', 'abc', 'f'.repeat(63),
    'f'.repeat(65), 'F'.repeat(64), '../calendar.db']) {
    assert.throws(() => requirePrivateUpstreamToken(invalid),
      /distinct 256-bit service secret/)
    assert.equal(verifyPrivateUpstreamToken(invalid, first), false)
  }
  assert.equal(PRIVATE_UPSTREAM_HEADER, 'x-family-calendar-upstream-token')
})
