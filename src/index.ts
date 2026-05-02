import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createProxyApp } from './proxy.js'
import { createDashboardApp } from './dashboard.js'
import { importFromOpenCode } from './import.js'
import { loginAccount } from './auth.js'
import { addAccount, listAccounts, loadStore } from './store.js'

// ─── Config ────────────────────────────────────────────────────────────

const PROXY_PORT = Number(process.env.MAIRA_AUTH_HUB_PORT || 47990)
const DASHBOARD_PORT = Number(process.env.MAIRA_AUTH_HUB_DASHBOARD_PORT || 3434)

// ─── CLI commands ──────────────────────────────────────────────────────

const command = process.argv[2]

if (command === 'import') {
  console.log('[maira-auth-hub] Importing accounts from opencode...')
  const result = importFromOpenCode()
  console.log(`Imported: ${result.imported}, Skipped: ${result.skipped}`)
  console.log('Aliases:', result.aliases.join(', '))
  process.exit(0)
}

if (command === 'add') {
  const alias = process.argv[3]
  if (!alias) {
    console.log('Usage: npx tsx src/index.ts add <alias>')
    console.log('Opens browser for OAuth login.')
    process.exit(1)
  }
  console.log('[auth-hub] Starting OAuth login for "' + alias + '"...')
  loginAccount(alias).then(function(acc) {
    console.log('[auth-hub] Account "' + alias + '" added: ' + (acc.email || 'no email'))
    process.exit(0)
  }).catch(function(err) {
    console.error('[auth-hub] Login failed:', err.message)
    process.exit(1)
  })
}


if (command === 'list') {
  const accounts = listAccounts()
  if (accounts.length === 0) {
    console.log('No accounts. Run: npx tsx src/index.ts import  (from opencode)')
      console.log('  or: npx tsx src/index.ts add <alias>  (OAuth login)')
  } else {
    console.log(`${accounts.length} accounts:\n`)
    for (const acc of accounts) {
      const status = acc.enabled === false ? 'DISABLED' : acc.authInvalid ? 'INVALID' : acc.rateLimitedUntil && acc.rateLimitedUntil > Date.now() ? 'RATE-LIMITED' : 'OK'
      console.log(`  ${acc.alias}: ${acc.email} (${acc.planType || '?'}) [${status}]`)
    }
  }
  process.exit(0)
}

if (command === 'status') {
  const store = loadStore()
  const now = Date.now()
  const total = Object.keys(store.accounts).length
  const active = Object.values(store.accounts).filter(a =>
    a.enabled !== false && !a.authInvalid && (!a.rateLimitedUntil || a.rateLimitedUntil < now)
  ).length
  const strategy = store.settings?.rotationStrategy || store.rotationStrategy || 'round-robin'
  const forced = store.forcedAlias ? ` (forced: ${store.forcedAlias})` : ''
  console.log(`Accounts: ${active}/${total} active`)
  console.log(`Strategy: ${strategy}${forced}`)
  console.log(`Store: ~/.maira-auth-hub/accounts.json`)
  process.exit(0)
}

// ─── Main app ──────────────────────────────────────────────────────────

const proxyApp = createProxyApp()
const dashboardApp = createDashboardApp()

// Start proxy server
serve({ fetch: proxyApp.fetch, port: PROXY_PORT, hostname: '0.0.0.0' }, () => {
  console.log(`[maira-auth-hub] Proxy on http://127.0.0.1:${PROXY_PORT}`)
  console.log(`  POST /v1/chat/completions  GET /v1/models  GET /health`)
})

// Start dashboard server
serve({ fetch: dashboardApp.fetch, port: DASHBOARD_PORT, hostname: '0.0.0.0' }, () => {
  console.log(`[maira-auth-hub] Dashboard on http://127.0.0.1:${DASHBOARD_PORT}`)
})

// ─── Graceful shutdown ─────────────────────────────────────────────────

process.on('SIGTERM', () => { console.log('[maira-auth-hub] SIGTERM'); process.exit(0) })
process.on('SIGINT', () => { console.log('[maira-auth-hub] SIGINT'); process.exit(0) })
