import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { addAccount, loadStore, saveStore } from './store.js'

/**
 * Import accounts from opencode's codex-accounts.json format into maira-auth-hub store.
 * 
 * opencode format:
 * { "openai": { "type": "oauth", "accounts": [{ accountId, email, plan, enabled, refresh, access, expires, ... }] } }
 * 
 * maira-auth-hub format:
 * { accounts: { alias: { accessToken, refreshToken, accountId, email, planType, expiresAt, ... } } }
 */

interface OpenCodeAccount {
  accountId: string
  email: string
  plan: string
  enabled: boolean
  refresh: string
  access: string
  expires: number
  lastUsed?: number
  cooldownUntil?: number
  identityKey?: string
}

interface OpenCodeStore {
  [provider: string]: {
    type: string
    accounts: OpenCodeAccount[]
  }
}

export function importFromOpenCode(): { imported: number; skipped: number; aliases: string[] } {
  const openCodePath = path.join(os.homedir(), '.config', 'opencode', 'codex-accounts.json')
  
  if (!fs.existsSync(openCodePath)) {
    console.error(`[import] No opencode accounts at ${openCodePath}`)
    return { imported: 0, skipped: 0, aliases: [] }
  }

  let raw: OpenCodeStore
  try {
    raw = JSON.parse(fs.readFileSync(openCodePath, 'utf-8'))
  } catch (err) {
    console.error(`[import] Failed to parse ${openCodePath}:`, err)
    return { imported: 0, skipped: 0, aliases: [] }
  }

  const store = loadStore()
  const existingAliases = new Set(Object.keys(store.accounts))
  const aliases: string[] = []
  let imported = 0
  let skipped = 0

  for (const [, providerData] of Object.entries(raw)) {
    if (!providerData?.accounts || !Array.isArray(providerData.accounts)) continue

    for (const acc of providerData.accounts) {
      if (!acc.refresh || !acc.access) {
        skipped++
        continue
      }

      // Generate alias from email
      const baseAlias = acc.email?.split('@')[0] || `acc-${acc.accountId?.slice(0, 8)}`
      let alias = baseAlias
      let suffix = 1
      while (existingAliases.has(alias)) {
        // If same email already exists, skip (not a new account)
        if (store.accounts[alias]?.email === acc.email) {
          alias = ''
          break
        }
        alias = `${baseAlias}-${suffix}`
        suffix++
      }

      if (!alias) { skipped++; continue }

      const now = Date.now()
      store.accounts[alias] = {
        alias,
        accessToken: acc.access,
        refreshToken: acc.refresh,
        accountId: acc.accountId,
        email: acc.email,
        planType: acc.plan,
        expiresAt: acc.expires,
        enabled: acc.enabled,
        lastSeenAt: acc.lastUsed || now,
        lastUsed: acc.lastUsed || 0,
        usageCount: 0,
        authInvalid: false,
        source: 'codex',
        rateLimitedUntil: acc.cooldownUntil && acc.cooldownUntil > now ? acc.cooldownUntil : undefined,
      }

      existingAliases.add(alias)
      aliases.push(alias)
      imported++
      console.log(`[import] ${alias}: ${acc.email} (${acc.plan})`)
    }
  }

  if (imported > 0) {
    store.activeAlias = aliases[0] || store.activeAlias
    saveStore(store)
    console.log(`[import] Done: ${imported} imported, ${skipped} skipped`)
  }

  return { imported, skipped, aliases }
}
