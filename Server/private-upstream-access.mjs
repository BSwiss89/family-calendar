// Non-production loopback household backend channel authentication.
//
// A dedicated random secret is required for each household backend. This is
// a defense-in-depth guard against localhost clients bypassing the central
// login gateway. It does NOT attest process identity, secure the host against
// a compromised same-user process, or make the private gateway public-ready.
//
// The legacy production calendar never imports a token from a request and
// never enables this guard.
import { timingSafeEqual } from 'node:crypto'

export const PRIVATE_UPSTREAM_HEADER = 'x-family-calendar-upstream-token'
const TOKEN = /^[0-9a-f]{64}$/

export function requirePrivateUpstreamToken(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new Error('Private household backend requires a distinct 256-bit service secret.')
  }
  return value
}

export function verifyPrivateUpstreamToken(presented, expected) {
  if (typeof presented !== 'string' || !TOKEN.test(presented)) return false
  const safeExpected = requirePrivateUpstreamToken(expected)
  return timingSafeEqual(Buffer.from(presented, 'hex'), Buffer.from(safeExpected, 'hex'))
}

export function installPrivateUpstreamGuard(app, { expectedToken }) {
  requirePrivateUpstreamToken(expectedToken)
  app.use((request, response, next) => {
    const token = request.headers[PRIVATE_UPSTREAM_HEADER]
    if (!verifyPrivateUpstreamToken(token, expectedToken)) {
      // Do not distinguish missing, malformed or wrong credentials.
      response.set('Cache-Control', 'no-store')
      return response.status(403).json({ error: 'Private household service unavailable.' })
    }
    next()
  })
}
