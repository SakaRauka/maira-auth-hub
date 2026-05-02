import { createHash, randomBytes } from 'node:crypto'
import * as http from 'node:http'
import * as url from 'node:url'
import { addAccount, updateAccount, loadStore } from './store.js'
import { clearAuthInvalid } from './rotation.js'
import type { AccountCredentials } from './types.js'

// ─── OpenAI OAuth ──────────────────────────────────────────────────────

const OPENAI_ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`
const TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEFAULT_REDIRECT_PORTS = [1455, 1456, 1457, 1458, 1459]
const SCOPES = ['openid', 'profile', 'email', 'offline_access']

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in: number
  token_type: string
}

export interface AuthorizationFlow {
  pkce: { verifier: string; challenge: string }
  state: string
  url: string
  redirectUri: string
  port: number
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export async function createAuthorizationFlow(port?: number): Promise<AuthorizationFlow> {
  const pkce = generatePKCE()
  const state = randomBytes(16).toString('hex')
  const redirectPort = port || DEFAULT_REDIRECT_PORTS[0]
  const redirectUri = `http://localhost:${redirectPort}/auth/callback`

  const authUrl = new URL(AUTHORIZE_URL)
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPES.join(' '))
  authUrl.searchParams.set('code_challenge', pkce.challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('audience', 'https://api.openai.com/v1')
  authUrl.searchParams.set('id_token_add_organizations', 'true')
  authUrl.searchParams.set('codex_cli_simplified_flow', 'true')
  authUrl.searchParams.set('originator', 'codex_cli_rs')

  return { pkce, state, url: authUrl.toString(), redirectUri, port: redirectPort }
}

// ─── JWT decode (no dependency) ────────────────────────────────────────

export function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))
  } catch { return null }
}

function getEmailFromClaims(claims: Record<string, any> | null): string | undefined {
  if (!claims) return undefined
  if (typeof claims.email === 'string') return claims.email
  const profile = claims['https://api.openai.com/profile'] as { email?: string } | undefined
  return profile?.email
}

function getAccountIdFromClaims(claims: Record<string, any> | null): string | undefined {
  if (!claims) return undefined
  const auth = claims['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined
  return auth?.chatgpt_account_id
}

function getPlanTypeFromClaims(claims: Record<string, any> | null): string | undefined {
  if (!claims) return undefined
  const auth = claims['https://api.openai.com/auth'] as { chatgpt_plan_type?: string } | undefined
  return typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined
}

function getExpiryFromClaims(claims: Record<string, any> | null): number | undefined {
  if (!claims) return undefined
  const exp = claims.exp
  if (typeof exp === 'number') return exp * 1000
  return undefined
}

// ─── Login ─────────────────────────────────────────────────────────────

export async function loginAccount(
  alias: string,
  flow?: AuthorizationFlow,
  timeoutMs: number = 5 * 60 * 1000
): Promise<AccountCredentials> {
  let activeFlow = flow
  let server: http.Server | null = null

  return new Promise(async (resolve, reject) => {
    let finished = false
    let timeout: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (timeout) { clearTimeout(timeout); timeout = null }
      if (server) { server.close(); server = null }
    }

    const finish = (fn: () => void) => {
      if (finished) return
      finished = true
      cleanup()
      fn()
    }

    server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/auth/callback')) {
        res.writeHead(404); res.end('Not found'); return
      }
      if (!activeFlow) {
        res.writeHead(500); res.end('No active flow')
        finish(() => reject(new Error('No active flow'))); return
      }

      const parsedUrl = url.parse(req.url, true)
      const code = parsedUrl.query.code as string
      const returnedState = parsedUrl.query.state as string | undefined

      if (!code) {
        res.writeHead(400); res.end('No authorization code received')
        finish(() => reject(new Error('No authorization code'))); return
      }
      if (returnedState && returnedState !== activeFlow.state) {
        res.writeHead(400); res.end('Invalid state')
        finish(() => reject(new Error('Invalid state'))); return
      }

      try {
        const tokenRes = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code,
            code_verifier: activeFlow.pkce.verifier,
            redirect_uri: activeFlow.redirectUri,
          }),
        })

        if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`)
        const tokens = (await tokenRes.json()) as TokenResponse
        if (!tokens.refresh_token) throw new Error('No refresh_token in response')

        const now = Date.now()
        const accessClaims = decodeJwtPayload(tokens.access_token)
        const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null
        const expiresAt = getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || now + tokens.expires_in * 1000

        let email = getEmailFromClaims(idClaims) || getEmailFromClaims(accessClaims)
        try {
          const userRes = await fetch(`${OPENAI_ISSUER}/userinfo`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          })
          if (userRes.ok) {
            const user = (await userRes.json()) as { email?: string }
            email = user.email || email
          }
        } catch { /* non-critical */ }

        const accountId = getAccountIdFromClaims(idClaims) || getAccountIdFromClaims(accessClaims)
        const planType = getPlanTypeFromClaims(idClaims) || getPlanTypeFromClaims(accessClaims)

        const store = addAccount(alias, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token,
          accountId,
          planType,
          expiresAt,
          email,
          lastRefresh: new Date(now).toISOString(),
          lastSeenAt: now,
          source: 'opencode',
          authInvalid: false,
          authInvalidatedAt: undefined,
        })

        const account = store.accounts[alias]
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body style="font-family:system-ui;padding:40px;text-align:center">
          <h1>Account "${alias}" authenticated!</h1>
          <p>${email || 'Unknown email'}</p>
          <p>You can close this window.</p>
        </body></html>`)
        finish(() => resolve(account))
      } catch (err) {
        res.writeHead(500); res.end('Authentication failed')
        finish(() => reject(err))
      }
    })

    // Find available port
    const ports = DEFAULT_REDIRECT_PORTS
    let actualPort = ports[0]
    for (const p of ports) {
      try {
        await new Promise<void>((res, rej) => {
          server!.listen(p, () => { res() })
          server!.on('error', rej)
        })
        actualPort = p
        break
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') continue
        finish(() => reject(err)); return
      }
    }

    if (!activeFlow || activeFlow.port !== actualPort) {
      activeFlow = await createAuthorizationFlow(actualPort)
    }

    console.log(`\n[auth-hub] Login for account "${alias}"`)
    console.log(`[auth-hub] Open this URL:\n\n  ${activeFlow.url}\n`)
    console.log(`[auth-hub] Waiting for callback on port ${actualPort}...`)

    timeout = setTimeout(() => {
      finish(() => reject(new Error(`Login timeout after ${Math.round(timeoutMs / 1000)}s`)))
    }, timeoutMs)
  })
}

// ─── Token refresh ─────────────────────────────────────────────────────

export async function refreshToken(alias: string): Promise<AccountCredentials | null> {
  const store = loadStore()
  const account = store.accounts[alias]
  if (!account?.refreshToken) {
    console.error(`[auth-hub] No refresh token for ${alias}`)
    return null
  }

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: account.refreshToken,
      }),
    })

    if (!tokenRes.ok) {
      console.error(`[auth-hub] Refresh failed for ${alias}: ${tokenRes.status}`)
      if (tokenRes.status === 401 || tokenRes.status === 403) {
        try { updateAccount(alias, { authInvalid: true, authInvalidatedAt: Date.now() }) } catch { /* ignore */ }
      }
      return null
    }

    const tokens = (await tokenRes.json()) as TokenResponse
    const accessClaims = decodeJwtPayload(tokens.access_token)
    const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null
    const expiresAt = getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || Date.now() + tokens.expires_in * 1000

    const updates: Partial<AccountCredentials> = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || account.refreshToken,
      expiresAt,
      lastRefresh: new Date().toISOString(),
      idToken: tokens.id_token || account.idToken,
      accountId: getAccountIdFromClaims(idClaims) || getAccountIdFromClaims(accessClaims) || account.accountId,
      planType: getPlanTypeFromClaims(idClaims) || getPlanTypeFromClaims(accessClaims) || account.planType,
    }

    const updatedStore = updateAccount(alias, updates)
    clearAuthInvalid(alias)
    return updatedStore.accounts[alias]
  } catch (err) {
    console.error(`[auth-hub] Refresh error for ${alias}:`, err)
    return null
  }
}

export async function ensureValidToken(alias: string): Promise<string | null> {
  const store = loadStore()
  const account = store.accounts[alias]
  if (!account) return null
  const bufferMs = 5 * 60 * 1000
  if (account.expiresAt < Date.now() + bufferMs) {
    console.log(`[auth-hub] Refreshing token for ${alias}`)
    const refreshed = await refreshToken(alias)
    return refreshed?.accessToken || null
  }
  return account.accessToken
}
