// No database, real listener, HTTP site or production process is touched.
// Synthetic loopback listeners verify fail-closed binding retry semantics.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { verifyPrivateBackendBindings } from '../Server/private-household-gateway.mjs'

const validToken = () => randomBytes(32).toString('hex')

async function localServer(t, responder) {
  let calls = 0
  const server = createServer((request, response) => {
    calls++
    responder(request, response, calls)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => { await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }) })
  return { port: server.address().port, calls: () => calls }
}

function binding(response, id, status=200) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify({ mode: 'household', householdId: id }))
}

function inputs(servers, tokens) {
  return [
    new Map(servers.map(([id, server]) => [id, server.port])),
    new Map(tokens),
  ]
}

test('brief transport failure retries a verified household without allowing a wrong binding', async t => {
  const aToken = validToken()
  const bToken = validToken()
  const familyA = await localServer(t, (req,res,count) => {
    assert.equal(req.headers['x-family-calendar-upstream-token'], aToken)
    if (count === 1) {
      req.socket.destroy() // The first connection drops before any response.
      return
    }
    binding(res, 'family-a')
  })
  const familyB = await localServer(t, (req,res) => {
    assert.equal(req.headers['x-family-calendar-upstream-token'], bToken)
    binding(res, 'family-b')
  })
  await verifyPrivateBackendBindings(...inputs([
    ['family-a',familyA], ['family-b',familyB],
  ], [['family-a',aToken], ['family-b',bToken]]))
  assert.equal(familyA.calls(),2)
  assert.equal(familyB.calls(),1)
})

test('HTTP authorization rejection fails closed on first attempt', async t => {
  const token = validToken()
  const server = await localServer(t,(_req,res) => binding(res,'family-a',403))
  await assert.rejects(verifyPrivateBackendBindings(...inputs(
    [['family-a',server]], [['family-a',token]],
  )),/Private gateway refused unverified household backend: family-a/)
  assert.equal(server.calls(),1)
})

test('200 response with another household identity fails closed without retry', async t => {
  const token = validToken()
  const server = await localServer(t,(_req,res) => binding(res,'family-b'))
  await assert.rejects(verifyPrivateBackendBindings(...inputs(
    [['family-a',server]], [['family-a',token]],
  )),/Private gateway refused unverified household backend: family-a/)
  assert.equal(server.calls(),1)
})

test('all three transport attempts failing never authorizes a gateway', async t => {
  const token = validToken()
  const server = await localServer(t,(req,_res) => req.socket.destroy())
  await assert.rejects(verifyPrivateBackendBindings(...inputs(
    [['family-a',server]], [['family-a',token]],
  )),/Private gateway refused unverified household backend: family-a/)
  assert.equal(server.calls(),3)
})

test('malformed identity JSON is a terminal failure, never retried', async t => {
  const token = validToken()
  const server = await localServer(t,(_req,res)=>{
    res.writeHead(200,{'Content-Type':'application/json'})
    res.end('{untrusted')
  })
  await assert.rejects(verifyPrivateBackendBindings(...inputs(
    [['family-a',server]], [['family-a',token]],
  )),/Private gateway refused unverified household backend: family-a/)
  assert.equal(server.calls(),1)
})


test('oversized identity payload fails closed without retry', async t => {
  const token = validToken()
  const server = await localServer(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ mode: 'household', householdId: 'family-a',
      padding: 'x'.repeat(2048) }))
  })
  await assert.rejects(verifyPrivateBackendBindings(...inputs(
    [['family-a', server]], [['family-a', token]],
  )), /Private gateway refused unverified household backend: family-a/)
  assert.equal(server.calls(), 1)
})

test('truncated HTTP identity body fails closed without retry', async t => {
  const token = validToken()
  const server = await localServer(t, (_req, res) => {
    // Announce more bytes than are ever sent; fetch receives HTTP 200,
    // but the response body is incomplete and must NEVER be retried.
    res.writeHead(200, { 'Content-Type': 'application/json',
      'Content-Length': '100' })
    res.end('{"mode":"household"')
  })
  await assert.rejects(verifyPrivateBackendBindings(...inputs(
    [['family-a', server]], [['family-a', token]],
  )), /Private gateway refused unverified household backend: family-a/)
  assert.equal(server.calls(), 1)
})

test('redirect cannot be followed or retried for a household binding', async t => {
  const token = validToken()
  const server = await localServer(t, (_req, res) => {
    res.writeHead(302, { Location: '/api/internal/household-binding' })
    res.end()
  })
  await assert.rejects(verifyPrivateBackendBindings(...inputs(
    [['family-a', server]], [['family-a', token]],
  )), /Private gateway refused unverified household backend: family-a/)
  assert.equal(server.calls(), 1)
})

test('identity with incorrect MIME type fails closed without retry', async t => {
  const token = validToken()
  const server = await localServer(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(JSON.stringify({ mode: 'household', householdId: 'family-a' }))
  })
  await assert.rejects(verifyPrivateBackendBindings(...inputs(
    [['family-a', server]], [['family-a', token]],
  )), /Private gateway refused unverified household backend: family-a/)
  assert.equal(server.calls(), 1)
})
