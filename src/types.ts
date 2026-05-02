// ─── Account Types ─────────────────────────────────────────────────────

export interface AccountCredentials {
  alias: string
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
  planType?: string
  expiresAt: number
  email?: string
  lastRefresh?: string
  lastSeenAt?: number
  lastActiveUntil?: number
  lastUsed?: number
  usageCount: number
  rateLimitedUntil?: number
  modelUnsupportedUntil?: number
  authInvalid?: boolean
  authInvalidatedAt?: number
  enabled?: boolean
  disabledAt?: number
  disabledBy?: string
  disableReason?: string
  rateLimits?: AccountRateLimits
  rateLimitHistory?: RateLimitHistoryEntry[]
  limitStatus?: LimitStatus
  limitError?: string
  lastLimitProbeAt?: number
  lastLimitErrorAt?: number
  limitsConfidence?: LimitsConfidence
  source?: 'opencode' | 'codex'
}

export interface RateLimitWindow {
  limit?: number
  remaining?: number
  resetAt?: number
  updatedAt?: number
}

export interface AccountRateLimits {
  fiveHour?: RateLimitWindow
  weekly?: RateLimitWindow
}

export interface RateLimitSnapshot {
  remaining?: number
  limit?: number
  resetAt?: number
}

export interface RateLimitHistoryEntry {
  at: number
  fiveHour?: RateLimitSnapshot
  weekly?: RateLimitSnapshot
}

export type LimitStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'stopped'
export type LimitsConfidence = 'fresh' | 'stale' | 'error' | 'unknown'

export interface AccountStore {
  version?: number
  accounts: Record<string, AccountCredentials>
  activeAlias: string | null
  rotationIndex: number
  lastRotation: number
  forcedAlias?: string | null
  forcedUntil?: number | null
  previousRotationStrategy?: string | null
  forcedBy?: string | null
  rotationStrategy?: RotationStrategy
  settings?: RotationSettings
}

export type RotationStrategy = 'round-robin' | 'least-used' | 'random' | 'weighted-round-robin'

export interface RotationSettings {
  rotationStrategy: RotationStrategy
  criticalThreshold: number
  lowThreshold: number
  accountWeights: Record<string, number>
  featureFlags?: FeatureFlags
  updatedAt?: number
  updatedBy?: string
}

export interface FeatureFlags {
  antigravityEnabled: boolean
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  antigravityEnabled: false
}

export const DEFAULT_ROTATION_SETTINGS: RotationSettings = {
  rotationStrategy: 'round-robin',
  criticalThreshold: 10,
  lowThreshold: 30,
  accountWeights: {},
  featureFlags: { ...DEFAULT_FEATURE_FLAGS }
}

// ─── Error Types ───────────────────────────────────────────────────────

export type ErrorCode =
  | 'NO_ELIGIBLE_ACCOUNTS'
  | 'MAX_RETRIES_EXCEEDED'
  | 'TOKEN_REFRESH_FAILED'
  | 'INVALID_REQUEST'

export interface DeterministicError {
  code: ErrorCode
  message: string
  details?: Record<string, unknown>
}

export const Errors = {
  noEligibleAccounts: (reason?: string): DeterministicError => ({
    code: 'NO_ELIGIBLE_ACCOUNTS',
    message: reason || 'No eligible accounts available for rotation',
  }),
  maxRetriesExceeded: (attempts: number, aliasesTried: string[]): DeterministicError => ({
    code: 'MAX_RETRIES_EXCEEDED',
    message: `Exhausted all ${attempts} retry attempts`,
    details: { attempts, aliasesTried },
  }),
  invalidRequest: (msg: string): DeterministicError => ({
    code: 'INVALID_REQUEST',
    message: msg,
  }),
}
