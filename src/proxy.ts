import { Hono } from 'hono'
import type { Context } from 'hono'
import { loadStore, updateAccount } from './store.js'
import { getNextAccount, markAuthInvalid, markRateLimited } from './rotation.js'
import { getForceState, isForceActive } from './force-mode.js'
import { decodeJwtPayload } from './auth.js'
import { extractRateLimitUpdate, mergeRateLimits, getBlockingRateLimitResetAt } from './rate-limits.js'
import { Errors } from './types.js'
import type { AccountRateLimits } from './types.js'

// ─── Constants ─────────────────────────────────────────────────────────

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/codex/responses`
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000

// ─── Helpers ───────────────────────────────────────────────────────────

function normalizeModel(model: string | undefined): string {
  if (!model) return 'gpt-5.1'
  const modelId = model.includes('/') ? model.split('/').pop()! : model
  return modelId.replace(/-(?:fast|none|minimal|low|medium|high|xhigh)$/, '')
}

function isSparkModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('gpt-5.3-codex-spark')
}

function supportsFastMode(model: string | undefined): boolean {
  return model === 'gpt-5.5' || model === 'gpt-5.4'
}

// ─── SSE Transform ─────────────────────────────────────────────────────

let _hadToolCalls = false

function transformSSEEvent(codexEvent: { type: string; [key: string]: any }): string | null {
  switch (codexEvent.type) {
    // Text streaming
    case 'response.output_text.delta': {
      const chunk = {
        id: codexEvent.item_id?.replace('msg_', 'chatcmpl-') || 'chatcmpl-codex',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4',
        choices: [{ index: 0, delta: { content: codexEvent.delta || '' }, finish_reason: null }],
      }
      return `data: ${JSON.stringify(chunk)}\n\n`
    }
    // Tool call: new item started
    case 'response.output_item.added': {
      if (codexEvent.item?.type !== 'function_call') return null
      _hadToolCalls = true
      const chunk = {
        id: codexEvent.item.call_id || 'chatcmpl-codex',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4',
        choices: [{
          index: codexEvent.output_index ?? 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: codexEvent.item.call_id,
              type: 'function',
              function: { name: codexEvent.item.name || '', arguments: '' }
            }]
          },
          finish_reason: null,
        }],
      }
      return `data: ${JSON.stringify(chunk)}\n\n`
    }
    // Tool call: arguments streaming
    case 'response.function_call_arguments.delta': {
      const chunk = {
        id: codexEvent.item_id || 'chatcmpl-codex',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4',
        choices: [{
          index: codexEvent.output_index ?? 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: codexEvent.delta || '' } }]
          },
          finish_reason: null,
        }],
      }
      return `data: ${JSON.stringify(chunk)}\n\n`
    // Response complete — detect tool_calls
    }
    case 'response.completed':
    case 'response.done': {
      const finishReason = _hadToolCalls ? 'tool_calls' : 'stop'
      const chunk = {
        id: 'chatcmpl-codex',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4',
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      }
      _hadToolCalls = false
      return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
    }
    // Errors
    case 'response.failed':
    case 'error': {
      const err = {
        error: { message: codexEvent.error?.message || codexEvent.message || 'Unknown error', type: 'server_error', code: codexEvent.error?.code || 'unknown' },
      }
      return `data: ${JSON.stringify(err)}\n\ndata: [DONE]\n\n`
    }
    // Legacy: old Codex event types
    case 'response.function_call_delta':
    case 'response.function_call': {
      const chunk = {
        id: codexEvent.call_id || 'chatcmpl-codex',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'gpt-5.4',
        choices: [{
          index: codexEvent.delta_index ?? 0,
          delta: {
            tool_calls: [{
              id: codexEvent.call_id,
              function: { name: codexEvent.function?.name || '', arguments: codexEvent.function?.arguments || '' },
              type: 'function'
            }]
          },
          finish_reason: null,
        }],
      }
      return `data: ${JSON.stringify(chunk)}\n\n`
    }
    default: return null
  }
}

// ─── Codex proxy ───────────────────────────────────────────────────────

async function proxyToCodex(options: {
  body: object
  token: string
  accountId: string
  signal?: AbortSignal
  onHeaders: (headers: Headers) => void
  onEvent: (line: string) => void
  onError: (err: Error & { status?: number }) => void
  onClose: () => void
}): Promise<void> {
  const { body, token, accountId, signal, onHeaders, onEvent, onError, onClose } = options

  try {
    const res = await fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses=experimental',
        'chatgpt-account-id': accountId,
        'originator': 'codex_cli_rs',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })

    // Pass headers to caller for rate-limit extraction
    onHeaders(res.headers)

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText)
      const err = new Error(`Codex API ${res.status}: ${errText}`) as Error & { status: number }
      err.status = res.status
      onError(err)
      return
    }

    if (!res.body) { onError(new Error('No response body')); return }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''
      for (const part of parts) {
        const lines = part.split('\n')
        let eventType = ''
        let eventData = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7)
          else if (line.startsWith('data: ')) eventData = line.slice(6)
        }
        if (eventType && eventData) {
          try {
            const parsed = JSON.parse(eventData)
            onEvent(JSON.stringify({ type: eventType, ...parsed }))
          } catch {
            onEvent(JSON.stringify({ type: eventType, raw: eventData }))
          }
        }
      }
    }
    onClose()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') onClose()
    else onError(err instanceof Error ? err : new Error(String(err)))
  }
}

// ─── Build Hono proxy app ──────────────────────────────────────────────

export function createProxyApp(): Hono {
  const app = new Hono()

  app.get("/", (c: Context) => c.json({ status: "ok", version: "0.1.0", service: "maira-auth-hub", endpoints: ["POST /v1/chat/completions", "GET /v1/models", "GET /health"] }))

  // Health
  app.get('/health', (c: Context) => {
    const store = loadStore()
    const now = Date.now()
    const eligible = Object.values(store.accounts).filter(acc =>
      (!acc.rateLimitedUntil || acc.rateLimitedUntil < now) &&
      (!acc.modelUnsupportedUntil || acc.modelUnsupportedUntil < now) &&
      !acc.authInvalid && acc.enabled !== false
    )
    return c.json({ status: 'ok', accounts: eligible.length })
  })

  // Models
  app.get('/v1/models', (c: Context) => {
    return c.json({
      object: 'list',
      data: [
        { id: 'gpt-5.5', object: 'model', created: 0, owned_by: 'openai', context_length: 530000, max_tokens: 130000 },
        { id: 'gpt-5.4', object: 'model', created: 0, owned_by: 'openai', context_length: 272000, max_tokens: 128000 },
        { id: 'gpt-5.4-fast', object: 'model', created: 0, owned_by: 'openai', context_length: 272000, max_tokens: 128000 },
        { id: 'gpt-5.3-codex', object: 'model', created: 0, owned_by: 'openai', context_length: 272000, max_tokens: 128000 },
        { id: 'o4-mini', object: 'model', created: 0, owned_by: 'openai', context_length: 200000, max_tokens: 128000 },
      ],
    })
  })

  // Chat completions
  app.post('/v1/chat/completions', async (c: Context) => {
    let body: Record<string, any>
    try { body = await c.req.json() }
    catch { return c.json({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }, 400) }

    if (!body.model || !body.messages?.length) {
      return c.json({ error: Errors.invalidRequest('model and messages are required') }, 400)
    }

    const normalizedModel = normalizeModel(body.model)
    const store = loadStore()
    const forcePinned = isForceActive() && !!getForceState().forcedAlias
    const eligibleCount = Object.values(store.accounts).filter(acc => {
      const now = Date.now()
      return (!acc.rateLimitedUntil || acc.rateLimitedUntil < now) &&
        (!acc.modelUnsupportedUntil || acc.modelUnsupportedUntil < now) &&
        !acc.authInvalid && acc.enabled !== false
    }).length

    const maxAttempts = forcePinned ? 1 : Math.max(1, Math.min(eligibleCount, 5))
    const triedAliases = new Set<string>()

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rotation = await getNextAccount({ model: normalizedModel })
      if (!rotation) {
        return c.json({ error: Errors.noEligibleAccounts() }, 503)
      }

      const { account, token } = rotation
      if (triedAliases.has(account.alias)) continue
      triedAliases.add(account.alias)

      const decoded = decodeJwtPayload(token)
      const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id
      if (!accountId) {
        return c.json({ error: { code: 'TOKEN_PARSE_ERROR', message: 'Failed to extract accountId' } }, 401)
      }

      // Build Codex request (OpenAI Responses API format)
      const messages = body.messages || []
      let instructions = 'You are a helpful assistant.'
      const input: any[] = []

      for (const msg of messages) {
        if (msg.role === 'system') { instructions = msg.content; continue }
        // Tool result -> function_call_output (Responses API format)
        if (msg.role === 'tool') {
          input.push({
            type: 'function_call_output',
            call_id: msg.tool_call_id || '',
            output: typeof msg.content === 'string' ? msg.content : String(msg.content || '')
          })
          continue
        }
        // Assistant with tool_calls -> assistant text + function_call item
        if (msg.role === 'assistant' && msg.tool_calls) {
          const text = typeof msg.content === 'string' ? msg.content : ''
          input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
          for (const tc of msg.tool_calls) {
            if (tc.type === 'function') {
              input.push({
                type: 'function_call',
                call_id: tc.id || '',
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || ''
              })
            }
          }
          continue
        }
        const contentType = msg.role === 'assistant' ? 'output_text' : 'input_text'
        const text = typeof msg.content === 'string' ? msg.content : msg.content?.map?.((c: any) => c.text).join(' ') || String(msg.content || '')
        input.push({ role: msg.role, content: [{ type: contentType, text }] })
      }

      const reasoningMatch = body.model?.match(/-(none|low|medium|high|xhigh)$/)
      const codexBody: Record<string, any> = {
        model: normalizedModel,
        input,
        instructions,
        stream: true,
        store: false,
      }
      if (reasoningMatch?.[1]) {
        codexBody.reasoning = { effort: reasoningMatch[1] }
        if (!isSparkModel(normalizedModel)) codexBody.reasoning.summary = 'auto'
      }
      if (supportsFastMode(normalizedModel)) codexBody.service_tier = 'priority'
      if (body.tools?.length) {
        codexBody.tools = body.tools.map((t: any) => ({
          type: 'function', name: t.function?.name, description: t.function?.description,
          parameters: t.function?.parameters, strict: t.function?.strict,
        }))
      }
      if (body.tool_choice !== undefined) codexBody.tool_choice = body.tool_choice

      try {
        return await proxyRequest(c, codexBody, token, accountId, account.alias, normalizedModel, account.rateLimits)
      } catch (err: any) {
        const status = err?.status
        if (status === 401 || status === 403) {
          markAuthInvalid(account.alias)
          continue
        }
        if (status === 429) {
          markRateLimited(account.alias, Date.now() + RATE_LIMIT_COOLDOWN_MS)
          continue
        }
        if (status >= 500) continue
        throw err
      }
    }

    return c.json({ error: Errors.maxRetriesExceeded(maxAttempts, Array.from(triedAliases)) }, 502)
  })

  return app
}

// ─── Proxy with SSE streaming ──────────────────────────────────────────

async function proxyRequest(
  c: Context,
  codexBody: object,
  token: string,
  accountId: string,
  alias: string,
  model: string,
  existingRateLimits?: AccountRateLimits
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const encoder = new TextEncoder()
    let streamEnded = false
    const abortController = new AbortController()

    const stream = new ReadableStream({
      start(controller) {
        proxyToCodex({
          body: codexBody,
          token,
          accountId,
          signal: abortController.signal,
          onHeaders: (headers: Headers) => {
            // Extract rate-limit data from Codex response headers and update store
            const limitUpdate = extractRateLimitUpdate(headers)
            if (limitUpdate) {
              const merged = mergeRateLimits(existingRateLimits, limitUpdate)
              const blockingResetAt = getBlockingRateLimitResetAt(merged)
              updateAccount(alias, {
                rateLimits: merged,
                rateLimitedUntil: blockingResetAt || undefined,
              })
              console.log(`[auth-hub] Updated rate-limits for ${alias}`)
            }
          },
          onEvent: (eventJson: string) => {
            if (streamEnded) return
            try {
              const event = JSON.parse(eventJson)
              const sseLine = transformSSEEvent(event)
              if (sseLine) {
                controller.enqueue(encoder.encode(sseLine))
                if (event.type === 'response.completed' || event.type === 'response.failed') streamEnded = true
              }
            } catch {}
          },
          onError: (err: Error) => {
            if (!streamEnded) {
              const errorSSE = `data: ${JSON.stringify({ error: { message: err.message, type: 'server_error' } })}\n\ndata: [DONE]\n\n`
              try { controller.enqueue(encoder.encode(errorSSE)) } catch {}
              streamEnded = true
            }
            try { controller.close() } catch {}
          },
          onClose: () => {
            if (!streamEnded) {
              try { controller.enqueue(encoder.encode('data: [DONE]\n\n')) } catch {}
              streamEnded = true
            }
            try { controller.close() } catch {}
          },
        }).catch(err => reject(err))
      },
      cancel() { abortController.abort(); streamEnded = true },
    })

    c.req.raw.signal?.addEventListener('abort', () => { abortController.abort(); streamEnded = true })
    resolve(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' },
    }))
  })
}
