// Private household gateway security policy: conservative event mutations.
//
// The legacy calendar has several alternative routes which can mutate event
// rows without the gateway's durable per-event sharing journal. Block these
// routes in the private multi-family test gateway until each can safely
// journal its complete affected-event set and reconcile before responding.
// This file does NOT run in the existing single-family production backend.
//
// Route checks and mutation identification must use the SAME canonical URL.
// An upstream Express app may accept casing, trailing slashes and encoded
// dynamic parameters which an overly narrow write-ahead matcher would miss.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function inspectPrivateGatewayMutation(method, originalUrl) {
  if (!MUTATING.has(method)) return { allowed: true }
  if (typeof originalUrl !== 'string' || !originalUrl.startsWith('/')) {
    return { allowed: false }
  }
  const path = originalUrl.split('?')[0]
  if (path.includes('%') || path.includes('\\') || path.includes('//')) {
    // Conservative: do not trust differing HTTP/Express URL decoding on a
    // mutation. Ordinary JSON form fields are passed in the body, not path.
    return { allowed: false }
  }
  const lower = path.toLowerCase()
  if (lower === '/api/event-batches' || lower.startsWith('/api/event-batches/')) {
    return { allowed: false }
  }
  // Confirmed AI actions bypass /api/events/:id and mutate source rows.
  if (lower === '/api/ai/cancel-confirmed' ||
      lower.startsWith('/api/ai/cancel-confirmed/') ||
      lower === '/api/ai/reschedule-confirmed' ||
      lower.startsWith('/api/ai/reschedule-confirmed/')) {
    return { allowed: false }
  }
  if (lower === '/api/events' || lower.startsWith('/api/events/')) {
    if (method === 'POST' && path === '/api/events') {
      return { allowed: true, isCreate: true }
    }
    const match = /^\/api\/events\/([1-9][0-9]*)$/.exec(path)
    if (match && (method === 'PUT' || method === 'DELETE')) {
      const sourceEventId = Number(match[1])
      if (Number.isSafeInteger(sourceEventId) && sourceEventId > 0) {
        return { allowed: true, sourceEventId }
      }
    }
    // Catches POST/DELETE recurrence exception mutations, noncanonical IDs
    // such as /api/events/01, and any new undeclared event-writing routes.
    return { allowed: false }
  }
  // Other household-scoped routes remain accessible only behind the
  // authenticated private loopback gateway. Each still requires its own audit
  // before a real family can be onboarded.
  return { allowed: true }
}
