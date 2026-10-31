// Disposable supervisor fixture worker ONLY. No calendar API, SQLite or gateway.
// Never wire this entrypoint into the installed Windows Task Scheduler.
import http from 'node:http'

const id = process.env.FC_DISPOSABLE_HOUSEHOLD_ID
const token = process.env.FC_DISPOSABLE_HEALTH_TOKEN
if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id) ||
    typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
    typeof process.send !== 'function') {
  process.exit(70)
}

const server = http.createServer((req, res) => {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'GET' || req.url !== '/health') {
    res.writeHead(404).end()
  } else if (req.headers['x-disposable-health-token'] !== token) {
    res.writeHead(401).end()
  } else {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ healthy: true, householdId: id }))
  }
})

let stopping = false
process.on('message', message => {
  if (message?.kind !== 'stop' || stopping) return
  stopping = true
  server.close(error => process.exit(error ? 71 : 0))
  server.closeIdleConnections()
})
process.on('disconnect', () => {
  // Parent lost its IPC ownership. The reviewed supervisor writes its hold.
  // Never continue serving a private household after control is lost.
  server.close(() => process.exit(72))
  server.closeIdleConnections()
})
server.on('error', () => process.exit(73))
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') process.exit(74)
  process.send({ kind: 'ready', householdId: id, port: address.port })
})
