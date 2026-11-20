#!/usr/bin/env node
// Static SOURCE-ROUTE inventory for a future secure TEST family account pilot.
// This is not proof that every dynamically mounted route is discovered.
// Output lists literal API declarations only, never personal accounts/data.
// Unknown routes remain DENIED (including for Owner), not auto-approved.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requiredFamilyMemberActions } from '../Server/family-member-route-enforcement.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ROUTE_SOURCES = Object.freeze([
  'Server/index.mjs',
  'Server/calendar-emoji-markers.mjs',
  'Server/daily-family-notes.mjs',
  'Server/test-notification-inbox-pilot.mjs',
  'Server/test-household-event-join.mjs',
  'Server/test-event-invitations.mjs',
  'Server/test-informational-push.mjs',
  'Server/test-local-stt.mjs',
])

export function representativeApiPath(template) {
  return template.replace(/:([a-zA-Z][a-zA-Z0-9]*)/g, (_match, key) => {
    if (/date/i.test(key)) return '2026-11-20'
    if (/mealType/i.test(key)) return 'dinner'
    return '1'
  })
}

export function declaredTestApiRoutes(read = file => fs.readFileSync(
  path.join(ROOT, file), 'utf8'
)) {
  // Current installer modules use single/double quoted literal API routes.
  const declaration = /\bapp\.(get|post|put|patch|delete)\s*\(\s*(['"])(\/api\/[^'"]+)\2/g
  const rows = []
  for (const source of ROUTE_SOURCES) {
    const text = read(source)
    for (const match of text.matchAll(declaration)) {
      const method = match[1].toUpperCase()
      const template = match[3]
      const example = representativeApiPath(template)
      const actions = requiredFamilyMemberActions(method, example)
      rows.push({
        source, method, template, example,
        status: actions === null ? 'UNREVIEWED_DENY' : 'REVIEWED_CLASSIFIED',
        actions,
      })
    }
  }
  return rows.sort((a, b) =>
    (a.source + a.template + a.method).localeCompare(b.source + b.template + b.method))
}

export function summarizeTestApiRouteAudit(rows = declaredTestApiRoutes()) {
  const declared = rows.length
  const reviewed = rows.filter(x => x.status === 'REVIEWED_CLASSIFIED')
  const unreviewed = rows.filter(x => x.status === 'UNREVIEWED_DENY')
  return {
    scope: 'static-literal-API-declarations-only',
    declared, reviewed: reviewed.length, unreviewed: unreviewed.length,
    // Developer-authored route names only; no user-specific content.
    unreviewedRoutes: unreviewed.map(x => ({
      source: x.source, method: x.method, template: x.template,
    })),
  }
}

if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(summarizeTestApiRouteAudit(), null, 2) + '\n') }
  catch {
    process.stderr.write('TEST_FAMILY_ROUTE_AUDIT=FAILED: source inventory unavailable\n')
    process.exitCode = 1
  }
}
