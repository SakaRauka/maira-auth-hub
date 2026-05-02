import { Hono } from 'hono'
import type { Context } from 'hono'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadStore, saveStore, updateAccount, removeAccount as removeStoreAccount, listAccounts } from './store.js'
import { activateForce, clearForce, isForceActive, getForceState } from './force-mode.js'
import type { RotationStrategy } from './types.js'

const DASHBOARD_DIR = path.join(path.dirname(import.meta.url.replace('file://', '')), '..', 'dashboard')

export function createDashboardApp(): Hono {
  const app = new Hono()

  // Serve dashboard HTML
  app.get('/', (c: Context) => {
    const html = fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'), 'utf-8')
    return c.html(html)
  })

  // ─── API ─────────────────────────────────────────────────────────────

  // Status
  app.get('/api/status', (c: Context) => {
    const store = loadStore()
    const now = Date.now()
    const allAccounts = Object.values(store.accounts)
    const activeAlias = store.activeAlias
    const strategy = store.settings?.rotationStrategy || store.rotationStrategy || 'round-robin'
    const forcedAlias = isForceActive() ? getForceState().forcedAlias : null

    return c.json({
      strategy,
      activeAlias,
      forcedAlias,
      total: allAccounts.length,
      active: allAccounts.filter(a => a.enabled !== false && !a.authInvalid && (!a.rateLimitedUntil || a.rateLimitedUntil < now)).length,
    })
  })

  // Accounts (grouped by provider — for now codex only)
  app.get('/api/accounts', (c: Context) => {
    const store = loadStore()
    const accounts = Object.values(store.accounts)

    const codex = accounts.map(a => ({
      alias: a.alias,
      email: a.email,
      planType: a.planType,
      enabled: a.enabled !== false,
      authInvalid: !!a.authInvalid,
      rateLimitedUntil: a.rateLimitedUntil,
      usageCount: a.usageCount || 0,
      lastUsed: a.lastUsed,
      lastRefresh: a.lastRefresh,
      // Rate limit data
      fiveHourRemaining: a.rateLimits?.fiveHour?.remaining,
      fiveHourLimit: a.rateLimits?.fiveHour?.limit,
      fiveHourResetAt: a.rateLimits?.fiveHour?.resetAt,
      fiveHourUpdatedAt: a.rateLimits?.fiveHour?.updatedAt,
      weeklyRemaining: a.rateLimits?.weekly?.remaining,
      weeklyLimit: a.rateLimits?.weekly?.limit,
      weeklyResetAt: a.rateLimits?.weekly?.resetAt,
      weeklyUpdatedAt: a.rateLimits?.weekly?.updatedAt,
    }))

    return c.json({ codex, antigravity: [] })
  })

  // Force mode
  app.post('/api/force', async (c: Context) => {
    const body = await c.req.json()
    if (!body.alias) return c.json({ error: 'alias required' }, 400)
    const result = activateForce(body.alias, 'dashboard')
    return c.json(result)
  })

  app.delete('/api/force', (c: Context) => {
    clearForce()
    return c.json({ success: true })
  })

  // Strategy
  app.post('/api/strategy', async (c: Context) => {
    const body = await c.req.json()
    const valid: RotationStrategy[] = ['round-robin', 'least-used', 'random', 'weighted-round-robin']
    if (!valid.includes(body.strategy)) return c.json({ error: 'invalid strategy' }, 400)

    const store = loadStore()
    const newStrategy = body.strategy as RotationStrategy
    store.rotationStrategy = newStrategy
    if (store.settings) store.settings = { ...store.settings, rotationStrategy: newStrategy }
    else store.settings = { rotationStrategy: newStrategy, criticalThreshold: 10, lowThreshold: 30, accountWeights: {}, featureFlags: { antigravityEnabled: false } }
    saveStore(store)
    return c.json({ success: true, strategy: newStrategy })
  })

  // Toggle account
  app.patch('/api/accounts/:alias', async (c: Context) => {
    const alias = c.req.param('alias')
    const body = await c.req.json()
    const store = loadStore()
    if (!store.accounts[alias]) return c.json({ error: 'not found' }, 404)

    if (body.enabled !== undefined) {
      updateAccount(alias, {
        enabled: body.enabled,
        disabledAt: body.enabled ? undefined : Date.now(),
        disabledBy: body.enabled ? undefined : 'dashboard',
      })
    }
    return c.json({ success: true })
  })

  // Remove account
  app.delete('/api/accounts/:alias', (c: Context) => {
    const alias = c.req.param('alias')
    const store = loadStore()
    if (!store.accounts[alias]) return c.json({ error: 'not found' }, 404)
    removeStoreAccount(alias)
    return c.json({ success: true })
  })

  return app
}
