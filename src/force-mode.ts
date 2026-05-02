import { loadStore, saveStore } from './store.js'
import type { AccountStore, RotationStrategy } from './types.js'

const FORCE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface ForceState {
  forcedAlias: string | null
  forcedUntil: number | null
  previousRotationStrategy: string | null
  forcedBy: string | null
}

const VALID_STRATEGIES = new Set<RotationStrategy>(['round-robin', 'least-used', 'random', 'weighted-round-robin'])

export function getForceState(): ForceState {
  const store = loadStore()
  return {
    forcedAlias: store.forcedAlias ?? null,
    forcedUntil: store.forcedUntil ?? null,
    previousRotationStrategy: store.previousRotationStrategy ?? null,
    forcedBy: store.forcedBy ?? null,
  }
}

export function isForceActive(): boolean {
  const state = getForceState()
  if (!state.forcedAlias || !state.forcedUntil) return false
  const store = loadStore()
  if (!store.accounts[state.forcedAlias]) return false
  if (store.accounts[state.forcedAlias].enabled === false) return false
  return Date.now() <= state.forcedUntil
}

export function activateForce(alias: string, actor: string = 'system'): { success: boolean; error?: string } {
  const store = loadStore()
  if (!store.accounts[alias]) return { success: false, error: `Account '${alias}' not found` }
  if (store.accounts[alias].enabled === false) return { success: false, error: `Account '${alias}' is disabled` }

  const now = Date.now()
  const keepExisting = store.forcedAlias === alias && typeof store.forcedUntil === 'number' && store.forcedUntil > now
  const forcedUntil = keepExisting ? store.forcedUntil! : now + FORCE_TTL_MS
  const currentStrategy = store.settings?.rotationStrategy || store.rotationStrategy || 'round-robin'
  const previousStrategy = store.forcedAlias ? store.previousRotationStrategy : currentStrategy

  const newStore: AccountStore = {
    ...store,
    forcedAlias: alias,
    forcedUntil,
    previousRotationStrategy: previousStrategy ?? null,
    forcedBy: actor,
  }
  saveStore(newStore)
  return { success: true }
}

export function clearForce(): { success: boolean; restoredStrategy?: string | null } {
  const store = loadStore()
  const restoredStrategy = store.previousRotationStrategy
  const currentStrategy = store.settings?.rotationStrategy || store.rotationStrategy || 'round-robin'
  const nextStrategy = VALID_STRATEGIES.has(restoredStrategy as RotationStrategy) ? restoredStrategy : currentStrategy

  const newStore: AccountStore = {
    ...store,
    forcedAlias: null,
    forcedUntil: null,
    rotationStrategy: nextStrategy as RotationStrategy,
    previousRotationStrategy: null,
    forcedBy: null,
  }
  if (newStore.settings) newStore.settings = { ...newStore.settings, rotationStrategy: nextStrategy as RotationStrategy }
  saveStore(newStore)
  return { success: true, restoredStrategy }
}

export function checkAndAutoClearForce(): { wasCleared: boolean; reason?: string } {
  const state = getForceState()
  if (!state.forcedAlias) return { wasCleared: false }
  const store = loadStore()
  const now = Date.now()
  if (state.forcedUntil && now > state.forcedUntil) { clearForce(); return { wasCleared: true, reason: 'expired' } }
  if (!store.accounts[state.forcedAlias]) { clearForce(); return { wasCleared: true, reason: 'account_removed' } }
  if (store.accounts[state.forcedAlias].enabled === false) { clearForce(); return { wasCleared: true, reason: 'account_disabled' } }
  return { wasCleared: false }
}

export function getRemainingForceTimeMs(): number {
  const state = getForceState()
  if (!state.forcedUntil) return 0
  return Math.max(0, state.forcedUntil - Date.now())
}
