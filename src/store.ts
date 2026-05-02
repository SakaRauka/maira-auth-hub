import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AccountStore, AccountCredentials } from './types.js'

// ─── Config ────────────────────────────────────────────────────────────

const STORE_DIR = path.join(os.homedir(), '.maira-auth-hub')
const STORE_FILE = 'accounts.json'

function getStorePath(): string {
  return path.join(STORE_DIR, STORE_FILE)
}

// ─── Lock ──────────────────────────────────────────────────────────────

let writeLock = false
let writeLockQueue: Array<() => void> = []

async function acquireWriteLock(): Promise<void> {
  if (!writeLock) { writeLock = true; return }
  return new Promise(resolve => writeLockQueue.push(resolve))
}

function releaseWriteLock(): void {
  const next = writeLockQueue.shift()
  if (next) next()
  else writeLock = false
}

// ─── Validation ────────────────────────────────────────────────────────

function emptyStore(): AccountStore {
  return {
    version: 2,
    accounts: {},
    activeAlias: null,
    rotationIndex: 0,
    lastRotation: Date.now(),
  }
}

function validateAccount(acc: any, alias: string): AccountCredentials | null {
  if (!acc || typeof acc !== 'object') return null
  if (typeof acc.accessToken !== 'string' || !acc.accessToken) return null
  if (typeof acc.refreshToken !== 'string' || !acc.refreshToken) return null
  if (typeof acc.expiresAt !== 'number') return null

  return {
    alias,
    accessToken: acc.accessToken,
    refreshToken: acc.refreshToken,
    idToken: typeof acc.idToken === 'string' ? acc.idToken : undefined,
    accountId: typeof acc.accountId === 'string' ? acc.accountId : undefined,
    planType: typeof acc.planType === 'string' ? acc.planType : undefined,
    expiresAt: acc.expiresAt,
    email: typeof acc.email === 'string' ? acc.email : undefined,
    lastRefresh: typeof acc.lastRefresh === 'string' ? acc.lastRefresh : undefined,
    lastSeenAt: typeof acc.lastSeenAt === 'number' ? acc.lastSeenAt : undefined,
    lastActiveUntil: typeof acc.lastActiveUntil === 'number' ? acc.lastActiveUntil : undefined,
    lastUsed: typeof acc.lastUsed === 'number' ? acc.lastUsed : undefined,
    usageCount: typeof acc.usageCount === 'number' ? acc.usageCount : 0,
    rateLimitedUntil: typeof acc.rateLimitedUntil === 'number' ? acc.rateLimitedUntil : undefined,
    modelUnsupportedUntil: typeof acc.modelUnsupportedUntil === 'number' ? acc.modelUnsupportedUntil : undefined,
    authInvalid: typeof acc.authInvalid === 'boolean' ? acc.authInvalid : undefined,
    authInvalidatedAt: typeof acc.authInvalidatedAt === 'number' ? acc.authInvalidatedAt : undefined,
    enabled: typeof acc.enabled === 'boolean' ? acc.enabled : undefined,
    disabledAt: typeof acc.disabledAt === 'number' ? acc.disabledAt : undefined,
    disabledBy: typeof acc.disabledBy === 'string' ? acc.disabledBy : undefined,
    disableReason: typeof acc.disableReason === 'string' ? acc.disableReason : undefined,
    rateLimits: acc.rateLimits || undefined,
    rateLimitHistory: Array.isArray(acc.rateLimitHistory) ? acc.rateLimitHistory : undefined,
    limitStatus: typeof acc.limitStatus === 'string' ? acc.limitStatus : undefined,
    limitError: typeof acc.limitError === 'string' ? acc.limitError : undefined,
    limitsConfidence: acc.limitsConfidence || undefined,
    source: acc.source === 'opencode' || acc.source === 'codex' ? acc.source : undefined,
  }
}

function validateStore(data: any): AccountStore | null {
  if (!data || typeof data !== 'object') return null
  const accounts: Record<string, AccountCredentials> = {}
  if (data.accounts && typeof data.accounts === 'object') {
    for (const [alias, acc] of Object.entries(data.accounts)) {
      const validated = validateAccount(acc, alias)
      if (validated) accounts[alias] = validated
    }
  }
  return {
    version: typeof data.version === 'number' ? data.version : 2,
    accounts,
    activeAlias: typeof data.activeAlias === 'string' ? data.activeAlias : null,
    rotationIndex: typeof data.rotationIndex === 'number' ? data.rotationIndex : 0,
    lastRotation: typeof data.lastRotation === 'number' ? data.lastRotation : Date.now(),
    forcedAlias: data.forcedAlias ?? null,
    forcedUntil: data.forcedUntil ?? null,
    previousRotationStrategy: data.previousRotationStrategy ?? null,
    forcedBy: data.forcedBy ?? null,
    rotationStrategy: data.rotationStrategy ?? 'round-robin',
    settings: data.settings ?? undefined,
  }
}

// ─── Core ──────────────────────────────────────────────────────────────

let storeLocked = false
let lastStoreError: string | null = null

function ensureDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
  }
}

export function loadStore(): AccountStore {
  storeLocked = false
  lastStoreError = null
  ensureDir()
  const file = getStorePath()
  if (fs.existsSync(file)) {
    try {
      const data = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(data)
      const validated = validateStore(parsed)
      if (validated) return validated
      storeLocked = true
      lastStoreError = 'Store validation failed'
      console.error('[auth-hub] Store validation failed')
    } catch (err) {
      storeLocked = true
      lastStoreError = 'Failed to parse store'
      console.error('[auth-hub] Failed to parse store:', err)
    }
  }
  return emptyStore()
}

export function saveStore(store: AccountStore): void {
  ensureDir()
  if (storeLocked) {
    console.error('[auth-hub] Store locked; refusing write')
    return
  }
  const file = getStorePath()
  // Backup
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak`)
      fs.chmodSync(`${file}.bak`, 0o600)
    }
  } catch { /* ignore */ }
  // Atomic write
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  let fd: number | null = null
  try {
    fd = fs.openSync(tmp, 'w', 0o600)
    fs.writeFileSync(fd, JSON.stringify(store, null, 2), { encoding: 'utf-8' })
    try { fs.fsyncSync(fd) } catch { /* best-effort */ }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
  try {
    fs.renameSync(tmp, file)
  } catch (err: any) {
    if (err?.code === 'EPERM' || err?.code === 'EEXIST') {
      try { fs.unlinkSync(file) } catch { /* ignore */ }
      fs.renameSync(tmp, file)
    } else {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      throw err
    }
  }
  try { fs.chmodSync(file, 0o600) } catch { /* ignore */ }
}

export function addAccount(alias: string, creds: Omit<AccountCredentials, 'alias' | 'usageCount'>): AccountStore {
  const store = loadStore()
  store.accounts[alias] = { ...creds, alias, usageCount: 0 }
  if (!store.activeAlias) store.activeAlias = alias
  saveStore(store)
  return store
}

export function removeAccount(alias: string): AccountStore {
  const store = loadStore()
  delete store.accounts[alias]
  if (store.activeAlias === alias) {
    const remaining = Object.keys(store.accounts)
    store.activeAlias = remaining[0] || null
  }
  saveStore(store)
  return store
}

export function updateAccount(alias: string, updates: Partial<AccountCredentials>): AccountStore {
  const store = loadStore()
  if (store.accounts[alias]) {
    store.accounts[alias] = { ...store.accounts[alias], ...updates }
    saveStore(store)
  }
  return store
}

export function listAccounts(): AccountCredentials[] {
  return Object.values(loadStore().accounts)
}

export function getStoreStatus(): { locked: boolean; error: string | null; path: string } {
  return { locked: storeLocked, error: lastStoreError, path: getStorePath() }
}
