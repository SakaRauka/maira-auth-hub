import { loadStore, saveStore, updateAccount } from './store.js'
import { ensureValidToken } from './auth.js'
import { decodeJwtPayload } from './auth.js'
import { isForceActive, checkAndAutoClearForce, getForceState, clearForce } from './force-mode.js'
import type { AccountCredentials, RotationStrategy } from './types.js'

export interface RotationResult {
  account: AccountCredentials
  token: string
  forceState?: { active: boolean; alias: string | null; remainingMs: number }
}

export interface AccountSelectionContext {
  model?: string
}

const RECENT_FAILURE_WINDOW_MS = 60_000
const TOKEN_FAILURE_COOLDOWN_MS = 60_000

interface AccountHealth {
  alias: string
  isHealthy: boolean
  priority: number
}

function evaluateAccountHealth(acc: AccountCredentials, now: number): AccountHealth {
  const isDisabled = acc.enabled === false
  const currentlyBlocked =
    !!(acc.rateLimitedUntil && acc.rateLimitedUntil > now) ||
    !!(acc.modelUnsupportedUntil && acc.modelUnsupportedUntil > now) ||
    !!acc.authInvalid ||
    isDisabled

  let priority = 100
  if (currentlyBlocked) priority = 0
  if (isDisabled) priority = -1
  if (acc.authInvalid) priority = 0
  if (acc.usageCount === 0) priority -= 5
  if (acc.lastLimitErrorAt && acc.lastLimitErrorAt > now - RECENT_FAILURE_WINDOW_MS) priority -= 10

  return { alias: acc.alias, isHealthy: !currentlyBlocked && !acc.authInvalid && !isDisabled, priority }
}

function shuffled<T>(input: T[]): T[] {
  const a = [...input]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function getStrategy(): RotationStrategy {
  const store = loadStore()
  return store.settings?.rotationStrategy || store.rotationStrategy || 'round-robin'
}

function buildCandidates(
  candidateAliases: string[],
  healthMap: Map<string, AccountHealth>,
  rotationIndex: number,
  strategy: RotationStrategy
): { aliases: string[]; nextIndex?: (selected: string) => number } {
  const sorted = [...candidateAliases].sort((a, b) =>
    (healthMap.get(b)?.priority || 0) - (healthMap.get(a)?.priority || 0)
  )

  switch (strategy) {
    case 'least-used': {
      const store = loadStore()
      const byUsage = [...sorted].sort((a, b) => {
        const usageDiff = (store.accounts[a]?.usageCount || 0) - (store.accounts[b]?.usageCount || 0)
        if (usageDiff !== 0) return usageDiff
        return (store.accounts[a]?.lastUsed || 0) - (store.accounts[b]?.lastUsed || 0)
      })
      return { aliases: byUsage }
    }
    case 'random': {
      const topHalf = sorted.slice(0, Math.ceil(sorted.length / 2))
      return { aliases: shuffled(topHalf.length > 0 ? topHalf : sorted) }
    }
    case 'weighted-round-robin': {
      // Fallback to round-robin if no weights
      const store = loadStore()
      const weights = store.settings?.accountWeights || {}
      const hasWeights = candidateAliases.some(a => (weights[a] || 0) > 0)
      if (!hasWeights) {
        // Fall through to round-robin
        break
      }
      const weighted = candidateAliases.filter(a => (weights[a] || 0) > 0)
      const totalWeight = weighted.reduce((s, a) => s + (weights[a] || 0), 0)
      if (totalWeight === 0) break
      let random = Math.random() * totalWeight
      for (const alias of weighted) {
        random -= weights[alias] || 0
        if (random <= 0) return { aliases: [alias] }
      }
      return { aliases: [weighted[weighted.length - 1]] }
    }
  }

  // round-robin (default)
  const start = rotationIndex % sorted.length
  const rr = sorted.map((_, i) => sorted[(start + i) % sorted.length])
  const nextIndex = (selected: string): number => {
    const idx = sorted.indexOf(selected)
    return idx >= 0 ? (idx + 1) % sorted.length : rotationIndex
  }
  return { aliases: rr, nextIndex }
}

export async function getNextAccount(
  selection?: AccountSelectionContext
): Promise<RotationResult | null> {
  const autoClear = checkAndAutoClearForce()
  if (autoClear.wasCleared) console.log(`[auth-hub] Force mode auto-cleared: ${autoClear.reason}`)

  const forceActive = isForceActive()
  const forceState = getForceState()
  let store = loadStore()
  const aliases = Object.keys(store.accounts)

  if (aliases.length === 0) {
    console.error('[auth-hub] No accounts configured')
    return null
  }

  const now = Date.now()

  // Force mode: pin to one alias
  if (forceActive && forceState.forcedAlias) {
    const forcedAlias = forceState.forcedAlias
    const forcedAccount = store.accounts[forcedAlias]
    if (forcedAccount) {
      const health = evaluateAccountHealth(forcedAccount, now)
      if (health.isHealthy) {
        const token = await ensureValidToken(forcedAlias)
        if (token) {
          store = updateAccount(forcedAlias, {
            usageCount: (forcedAccount.usageCount || 0) + 1,
            lastUsed: now,
            limitError: undefined,
          })
          store.activeAlias = forcedAlias
          store.lastRotation = now
          saveStore(store)
          return {
            account: store.accounts[forcedAlias],
            token,
            forceState: { active: true, alias: forcedAlias, remainingMs: forceState.forcedUntil ? forceState.forcedUntil - now : 0 },
          }
        }
        console.warn(`[auth-hub] Force: ${forcedAlias} token unavailable; refusing fallback`)
        return null
      }
      console.warn(`[auth-hub] Force: ${forcedAlias} blocked; refusing fallback`)
      return null
    }
    console.warn(`[auth-hub] Force: ${forcedAlias} not found, clearing`)
    clearForce()
  }

  // Health evaluation
  const healthMap = new Map<string, AccountHealth>()
  for (const alias of aliases) {
    healthMap.set(alias, evaluateAccountHealth(store.accounts[alias], now))
  }

  const availableAliases = aliases.filter(a => healthMap.get(a)?.isHealthy === true)
  if (availableAliases.length === 0) {
    console.warn('[auth-hub] No available accounts')
    return null
  }

  const strategy = getStrategy()
  const { aliases: candidates, nextIndex } = buildCandidates(availableAliases, healthMap, store.rotationIndex, strategy)

  for (const candidate of candidates) {
    const token = await ensureValidToken(candidate)
    if (!token) {
      updateAccount(candidate, {
        rateLimitedUntil: now + TOKEN_FAILURE_COOLDOWN_MS,
        limitError: 'Token unavailable',
        lastLimitErrorAt: now,
      })
      continue
    }

    store = updateAccount(candidate, {
      usageCount: (store.accounts[candidate]?.usageCount || 0) + 1,
      lastUsed: now,
      limitError: undefined,
    })
    store.activeAlias = candidate
    store.lastRotation = now
    if (nextIndex) store.rotationIndex = nextIndex(candidate)
    saveStore(store)

    return {
      account: store.accounts[candidate],
      token,
      forceState: { active: isForceActive(), alias: getForceState().forcedAlias, remainingMs: getForceState().forcedUntil ? getForceState().forcedUntil - now : 0 },
    }
  }

  console.error('[auth-hub] No available accounts (token refresh failed on all)')
  return null
}

export function markRateLimited(alias: string, rateLimitedUntil: number): void {
  updateAccount(alias, { rateLimitedUntil: Math.max(rateLimitedUntil, Date.now() + 1000) })
  console.warn(`[auth-hub] ${alias} rate-limited for ${Math.max(1, Math.ceil((rateLimitedUntil - Date.now()) / 1000))}s`)
}

export function markAuthInvalid(alias: string): void {
  updateAccount(alias, { authInvalid: true, authInvalidatedAt: Date.now() })
  console.warn(`[auth-hub] ${alias} marked invalidated`)
}

export function clearAuthInvalid(alias: string): void {
  updateAccount(alias, { authInvalid: false, authInvalidatedAt: undefined })
}
