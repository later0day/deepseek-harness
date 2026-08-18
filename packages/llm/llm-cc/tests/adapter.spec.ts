import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, {
  createUserMessage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as LlmCc from '@deepseek-ai/dsh-llm-cc'
import { CcAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-cc'
import { httpErrorCode } from '../src/adapter.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import type { Behavior } from './mock-server.ts'

const TEST_USER_ID = '{"device_id":"dev","account_uuid":"","session_id":"dev"}'
let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-cc-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(testHome, { recursive: true, force: true })
})

async function harness(baseURL: string, config: object = {}): Promise<Context> {
  vi.stubEnv('CC_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmCc, { baseURL, ...config })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(config: Partial<LlmCc.Config> & { apiKey?: string } = {}): CcAdapter {
  const { apiKey, ...rest } = config
  return new CcAdapter({
    options: () => resolveAdapterOptions(rest, TEST_USER_ID),
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
  })
}

describe('CcAdapter against a mock gateway', () => {
  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, {
      model: 'claude-opus-4-8',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
    })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })
    expect(server.requests[0]).toMatchObject({
      model: 'claude-opus-4-8',
      max_tokens: 64_000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    })
  })

  it('sends the full Claude Code fingerprint headers, Bearer auth, and billing system prompt', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })

    const headers = server.headers[0]!
    expect(headers.authorization).toBe('Bearer test-key')
    expect(headers['user-agent']).toMatch(/^claude-cli\//)
    expect(headers['x-app']).toBe('cli')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-beta']).toContain('claude-code-20250219')
    const body = server.requests[0] as { system: { text: string }[]; metadata: { user_id: string } }
    expect(body.system[0]?.text).toMatch(/^x-anthropic-billing-header: cc_version=.*cc_entrypoint=cli;$/)
    // The plugin derives user_id from the anonymous harness id, not the test id;
    // assert the fingerprint JSON shape the gateway records.
    const userId = JSON.parse(body.metadata.user_id) as { device_id: string; account_uuid: string; session_id: string }
    expect(userId.account_uuid).toBe('')
    expect(userId.device_id).toBe(userId.session_id)
    expect(userId.device_id.length).toBeGreaterThan(0)
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 2 }])
    const ctx = await harness(server.url)
    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'cc', model: 'claude-opus-4-8', messages: [] })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('uses the configured maxTokens default and preserves an explicit request cap', async () => {
    const server = await mockServer([
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const ctx = await harness(server.url, { maxTokens: 32_000 })
    await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    await assemble(ctx, { model: 'claude-opus-4-8', messages: [], maxTokens: 8_192 })
    expect(server.requests[0]).toMatchObject({ max_tokens: 32_000 })
    expect(server.requests[1]).toMatchObject({ max_tokens: 8_192 })
  })

  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [400, 'INVALID_REQUEST'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ])('maps HTTP %d to failure code %s with the body message', async (status, code) => {
    const behavior: Behavior = {
      kind: 'http-error',
      status,
      body: JSON.stringify({ error: { message: `failed with ${status}`, type: 't' } }),
    }
    const server = await mockServer([behavior])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { message: `failed with ${status}`, code, status },
    })
  })

  it('classifies an HTTP context-window failure with the canonical code', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 400,
      body: JSON.stringify({ error: { message: 'prompt is too long for the model context window', type: 'invalid_request_error' } }),
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE } })
  })

  it('retains status, Retry-After seconds, and provider request id as structured facts', async () => {
    const server = await mockServer([{
      kind: 'http-error',
      status: 429,
      body: JSON.stringify({ error: { message: 'slow down' } }),
      headers: { 'retry-after': '2', 'request-id': 'req-429' },
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(result.finish).toEqual({
      kind: 'error',
      failure: {
        message: 'slow down',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 2_000,
        requestId: ProviderRequestId('req-429'),
      },
    })
  })

  it('parses a future Retry-After HTTP date and the x-request-id fallback', async () => {
    const now = 1_800_000_000_000
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const server = await mockServer([{
        kind: 'http-error',
        status: 503,
        body: JSON.stringify({ error: { message: 'come back later' } }),
        headers: { 'retry-after': new Date(now + 3_000).toUTCString(), 'x-request-id': 'cc-503' },
      }])
      const ctx = await harness(server.url)
      const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
      expect(result.finish).toEqual({
        kind: 'error',
        failure: {
          message: 'come back later',
          code: 'SERVER',
          status: 503,
          providerRetryAfterMs: 3_000,
          requestId: ProviderRequestId('cc-503'),
        },
      })
    } finally {
      dateNow.mockRestore()
    }
  })

  it('omits zero, non-finite, invalid, and past Retry-After values', async () => {
    const values = ['0', '9'.repeat(400), 'not-a-date', new Date(0).toUTCString()]
    for (const value of values) {
      const server = await mockServer([{
        kind: 'http-error',
        status: 429,
        body: JSON.stringify({ error: { message: 'retry later' } }),
        headers: { 'retry-after': value },
      }])
      const ctx = await harness(server.url)
      const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
      expect(result.finish).toEqual({
        kind: 'error',
        failure: { message: 'retry later', code: 'RATE_LIMIT', status: 429 },
      })
    }
  })

  it('classifies only context-capacity HTTP 400 details as context overflow', () => {
    expect(httpErrorCode(400, { message: 'prompt is too long for the model context window' }))
      .toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(httpErrorCode(400, { message: 'temperature: must be <= 1' })).toBe('INVALID_REQUEST')
  })

  it('distinguishes terminal quota exhaustion from transient HTTP 429 throttling', () => {
    expect(httpErrorCode(429, { type: 'insufficient_quota', message: 'credit balance is too low' }))
      .toBe(QUOTA_EXCEEDED_CODE)
    expect(httpErrorCode(429, { message: 'rate limit exceeded' })).toBe('RATE_LIMIT')
  })

  it('maps unusual statuses to HTTP_<status>', () => {
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })

  it('keeps the status-line message for JSON error bodies without a message', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 500, body: '{"error":{"type":"x"}}' }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.code).toBe('SERVER')
    expect(result.finish.failure.message).toMatch(/HTTP 500/)
  })

  it('keeps the status-line message for non-JSON error bodies', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 502, body: 'Bad Gateway', contentType: 'text/plain' }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.message).toMatch(/HTTP 502/)
  })

  it('reports a transport failure with the endpoint in the message', async () => {
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: { code: 'TRANSPORT', message: 'Claude Code request to http://127.0.0.1:1 failed' },
    })
  })

  it('classifies an aborted request as an aborted finish', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = await harness('http://127.0.0.1:1')
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [], signal: controller.signal })
    expect(result.finish).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
  })

  it('throws EMPTY_RESPONSE when the response has no body', async () => {
    const adapter = adapterOf({ baseURL: 'http://127.0.0.1:1' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
    try {
      const iterate = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'cc', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(iterate()).rejects.toThrow(/no response body/)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('classifies an abrupt body close as TRANSPORT', async () => {
    const server = await mockServer([{
      kind: 'close-early',
      events: ['{"type":"content_block_start","index":0,"content_block":{"type":"text"}}'],
    }])
    const ctx = await harness(server.url)
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(result.finish.kind).toBe('error')
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.code).toBe('TRANSPORT')
    expect(result.finish.failure.message).toMatch(/^Claude Code stream from .* failed$/)
  })

  it('aborts mid-stream via the request signal', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 50 }])
    const ctx = await harness(server.url)
    const controller = new AbortController()
    const pending = (async () => {
      const chunks = []
      for await (const chunk of ctx.llm.stream({ provider: 'cc', model: 'claude-opus-4-8', messages: [], signal: controller.signal })) {
        chunks.push(chunk)
      }
      return chunks
    })()
    setTimeout(() => { controller.abort() }, 30)
    const chunks = await pending
    expect(chunks.at(-1)?.type).toBe('finish')
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('expected a finish chunk')
    expect(finish.reason.kind).toBe('aborted')
  })

  it('maps connection failures to TRANSPORT without losing the cause', async () => {
    const cause = new TypeError('connection refused')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause)
    const adapter = adapterOf({ baseURL: 'https://example.invalid' })
    try {
      const drain = async (): Promise<void> => {
        for await (const _chunk of adapter.stream({ provider: 'cc', model: 'm', messages: [] })) { /* drain */ }
      }
      await expect(drain()).rejects.toMatchObject({ code: 'TRANSPORT', cause })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('aborts the underlying body when the stream stays idle past its watchdog', async () => {
    vi.useFakeTimers()
    let stopped = false
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            stopped = true
            controller.error(signal.reason)
          }, { once: true })
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const adapter = adapterOf({ baseURL: 'https://example.invalid', streamIdleTimeoutMs: 100 })
    try {
      const drain = (async () => {
        for await (const _chunk of adapter.stream({ provider: 'cc', model: 'm', messages: [] })) { /* drain */ }
      })()
      const rejected = expect(drain).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      await rejected
      expect(stopped).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps an idle provider read alive through SSE comments', async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => { controller.enqueue(encoder.encode(': keep-alive\n\n')) }, 75)
          setTimeout(() => { controller.enqueue(encoder.encode(': keep-alive\n\n')) }, 150)
          setTimeout(() => {
            controller.enqueue(encoder.encode(textEvents.map(event => `data: ${event}\n\n`).join('')))
            controller.close()
          }, 225)
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    const adapter = adapterOf({ baseURL: 'https://example.invalid', streamIdleTimeoutMs: 100 })
    try {
      const chunks: string[] = []
      const drain = (async () => {
        for await (const chunk of adapter.stream({ provider: 'cc', model: 'm', messages: [] })) {
          chunks.push(chunk.type)
        }
      })()
      await vi.advanceTimersByTimeAsync(75)
      await vi.advanceTimersByTimeAsync(75)
      await vi.advanceTimersByTimeAsync(75)
      await expect(drain).resolves.toBeUndefined()
      expect(chunks).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('resolves connection facts and the credential exactly once per stream call', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const options = vi.fn(() => resolveAdapterOptions({ baseURL: server.url }, TEST_USER_ID))
    const resolveApiKey = vi.fn(() => Promise.resolve('per-request-key'))
    const adapter = new CcAdapter({ options, resolveApiKey })
    for await (const _chunk of adapter.stream({ provider: 'cc', model: 'm', messages: [] })) { /* drain */ }
    expect(options).toHaveBeenCalledTimes(1)
    expect(resolveApiKey).toHaveBeenCalledTimes(1)
    expect(server.headers[0]?.authorization).toBe('Bearer per-request-key')
  })
})

describe('plugin registration and config', () => {
  it('keeps wire helpers off the package root', () => {
    for (const helper of ['httpErrorCode', 'serializeMessages', 'serializeRequest', 'parseSse', 'mapStopReason', 'mapUsage', 'translate', 'billingHeaderText']) {
      expect(LlmCc).not.toHaveProperty(helper)
    }
  })

  it('registers the cc provider and unregisters on dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmCc, { baseURL: 'http://127.0.0.1:1' })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'cc', name: 'Claude Code' }])
    expect(ctx.llm.listConfigurableProviders()).toEqual([{
      provider: 'cc',
      displayName: 'Claude Code',
      settingsNs: 'llm-cc',
      settingsPath: [],
    }])
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('registers retryPolicy from the provider config', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCc, {
      baseURL: 'http://127.0.0.1:1',
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('cc')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
  })

  it('advertises the default Opus model and resolves its capabilities', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCc, { baseURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('cc')).resolves.toEqual([
      { provider: 'cc', id: 'claude-opus-4-8', name: 'Claude Opus 4.8', inputModalities: ['text', 'image'] },
    ])
    await expect(ctx.llm.resolveModelInfo('cc', 'claude-opus-4-8')).resolves.toMatchObject({
      provider: 'cc',
      id: 'claude-opus-4-8',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 64_000,
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('medium'), name: 'Medium' },
          { id: ReasoningEffortId('high'), name: 'High' },
          { id: ReasoningEffortId('xhigh'), name: 'XHigh' },
          { id: ReasoningEffortId('max'), name: 'Max' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  })

  it('resolves an unlisted model to the default context window and effort', async () => {
    const adapter = adapterOf()
    await expect(adapter.resolveModel('cc', 'claude-sonnet-9')).resolves.toMatchObject({
      provider: 'cc',
      id: 'claude-sonnet-9',
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 64_000,
    })
  })

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'reports the %s default effort when configured',
    async (reasoningEffort) => {
      const adapter = adapterOf({ reasoningEffort })
      await expect(adapter.resolveModel('cc', 'claude-opus-4-8')).resolves.toMatchObject({
        reasoning: { defaultEffort: ReasoningEffortId(reasoningEffort) },
      })
    },
  )

  it.each(['low', 'medium', 'xhigh'] as const)(
    'accepts an explicit %s reasoning effort through the full call-config validation',
    async (effort) => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmCc, { baseURL: 'http://127.0.0.1:1' })
      await expect(ctx.llm.resolveCallConfig({
        provider: 'cc',
        model: 'claude-opus-4-8',
        reasoningEffort: ReasoningEffortId(effort),
      })).resolves.toMatchObject({ reasoningEffort: ReasoningEffortId(effort) })
    },
  )

  it('prefers a model\'s own output cap over the profile default', async () => {
    const adapter = adapterOf({ maxTokens: 4096, models: [{ id: 'capped', maxTokens: 512 }, { id: 'uncapped' }] })
    await expect(adapter.resolveModel('cc', 'capped')).resolves.toMatchObject({ defaultMaxTokens: 512 })
    await expect(adapter.resolveModel('cc', 'uncapped')).resolves.toMatchObject({ defaultMaxTokens: 4096 })
  })

  it('advertises configured models without restricting arbitrary request ids', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCc, {
      baseURL: 'http://127.0.0.1:1',
      models: [
        { id: 'claude-opus-4-8', contextWindow: 200_000 },
        { id: 'claude-sonnet-9', name: 'Sonnet 9', description: 'Faster', contextWindow: 400_000 },
      ],
    })
    await expect(ctx.llm.listModels('cc')).resolves.toEqual([
      { provider: 'cc', id: 'claude-opus-4-8', name: 'claude-opus-4-8', inputModalities: ['text', 'image'] },
      { provider: 'cc', id: 'claude-sonnet-9', name: 'Sonnet 9', description: 'Faster', inputModalities: ['text', 'image'] },
    ])
  })

  it('allows an explicit empty model catalog', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCc, { baseURL: 'http://127.0.0.1:1', models: [] })
    await expect(ctx.llm.listModels('cc')).resolves.toEqual([])
  })

  it.each([
    [[{ id: '' }], /ids must be non-empty/],
    [[{ id: 'm', name: '' }], /empty name/],
    [[{ id: 'm', contextWindow: 0 }], /contextWindow/],
    [[{ id: 'm', contextWindow: 1.5 }], /contextWindow/],
    [[{ id: 'm' }, { id: 'm' }], /duplicate catalog model/],
  ] as const)('rejects invalid advisory model config', async (models, message) => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmCc, { baseURL: 'http://127.0.0.1:1', models: [...models] })).rejects.toThrow(message)
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it.each([0, 1.5])('rejects a per-model output cap of %s at the resolver boundary', (maxTokens) => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'bad-cap', maxTokens }] }, TEST_USER_ID))
      .toThrow(/maxTokens must be a positive integer/)
  })

  it.each([0, 1.5])('rejects a per-model contextWindow of %s at the resolver boundary', (contextWindow) => {
    expect(() => resolveAdapterOptions({ models: [{ id: 'bad-window', contextWindow }] }, TEST_USER_ID))
      .toThrow(/contextWindow must be a positive integer/)
  })

  it('rejects an empty catalog id and name at the resolver boundary', () => {
    expect(() => resolveAdapterOptions({ models: [{ id: '' }] }, TEST_USER_ID)).toThrow(/ids must be non-empty/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'm', name: '' }] }, TEST_USER_ID)).toThrow(/empty name/)
    expect(() => resolveAdapterOptions({ models: [{ id: 'dup' }, { id: 'dup' }] }, TEST_USER_ID)).toThrow(/duplicate catalog model/)
  })

  it('rejects invalid fingerprint and bound config at the resolver boundary', () => {
    expect(() => resolveAdapterOptions({ defaultContextWindow: 0 }, TEST_USER_ID)).toThrow(/defaultContextWindow/)
    expect(() => resolveAdapterOptions({ maxTokens: 1.5 }, TEST_USER_ID)).toThrow(/maxTokens must be a positive safe integer/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: Number.POSITIVE_INFINITY }, TEST_USER_ID))
      .toThrow(/streamIdleTimeoutMs.*positive finite/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, TEST_USER_ID))
      .toThrow(/streamIdleTimeoutMs.*no greater/)
    expect(() => resolveAdapterOptions({ claudeCodeVersion: '' }, TEST_USER_ID)).toThrow(/claudeCodeVersion/)
    expect(() => resolveAdapterOptions({ betaFeatures: [] }, TEST_USER_ID)).toThrow(/betaFeatures/)
  })

  it('falls back to CC_API_KEY from the ambient environment when no seam is mounted', async () => {
    vi.stubEnv('CC_API_KEY', 'ambient-key')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCc, { baseURL: server.url })
    await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer ambient-key')
  })

  it('loads keyless, keeps the catalog browsable, and fails the request actionably', async () => {
    vi.stubEnv('CC_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCc, { baseURL: 'http://127.0.0.1:1' })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'cc', name: 'Claude Code' }])
    const result = await assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.message).toMatch(/store CC_API_KEY through the credentials.*export CC_API_KEY/s)
  })

  it('uses the default model catalog when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    LlmCc.apply(ctx, { baseURL: 'http://127.0.0.1:1' })
    await expect(ctx.llm.listModels('cc')).resolves.toHaveLength(1)
  })

  it('adapter is constructible directly and shares the default catalog', async () => {
    const adapter = adapterOf()
    expect(adapter).toBeInstanceOf(CcAdapter)
    await expect(adapter.listModels('cc')).resolves.toHaveLength(1)
  })
})

describe('CcAdapter image resolution', () => {
  it('throws UNSUPPORTED_CONTENT when image blocks are present but no store is available', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const id = AttachmentId(`sha256:${'a'.repeat(64)}`)
    const adapter = new CcAdapter({
      options: () => resolveAdapterOptions({ baseURL: server.url }, TEST_USER_ID),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => undefined,
    })
    const messages = [createUserMessage({
      content: [{
        type: 'image',
        attachment: { attachmentId: id, mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    const gen = adapter.stream({ provider: 'cc', model: 'claude-opus-4-8', messages })
    const iter = gen[Symbol.asyncIterator]()
    await expect(iter.next()).rejects.toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CONTENT' }),
    )
  })

  it('resolves image data and sends it on the wire', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const id = AttachmentId(`sha256:${'f'.repeat(64)}`)
    const fakeStore = {
      readImage: vi.fn().mockResolvedValue({
        ref: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 2, height: 2 },
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }),
    }
    const adapter = new CcAdapter({
      options: () => resolveAdapterOptions({ baseURL: server.url }, TEST_USER_ID),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => fakeStore as never,
    })
    const messages = [createUserMessage({
      content: [{
        type: 'image',
        attachment: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 2, height: 2 },
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    for await (const _ of adapter.stream({ provider: 'cc', model: 'claude-opus-4-8', messages })) {
      // consume
    }
    expect(fakeStore.readImage).toHaveBeenCalledOnce()
    const body = server.requests[0] as { messages: { content: unknown[] }[] }
    const userMessage = body.messages[0]!
    expect(userMessage.content).toContainEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      },
    })
  })

  it('resolves images nested inside tool-result blocks', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const imgId = AttachmentId(`sha256:${'d'.repeat(64)}`)
    const fakeStore = {
      readImage: vi.fn().mockResolvedValue({
        ref: { attachmentId: imgId, mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1 },
        data: new Uint8Array([0xff, 0xd8, 0xff]),
      }),
    }
    const adapter = new CcAdapter({
      options: () => resolveAdapterOptions({ baseURL: server.url }, TEST_USER_ID),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => fakeStore as never,
    })
    const messages = [createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: 'call-img' as never,
        content: [{
          type: 'image',
          attachment: { attachmentId: imgId, mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1 },
        }],
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    for await (const _ of adapter.stream({ provider: 'cc', model: 'claude-opus-4-8', messages })) {
      // consume
    }
    expect(fakeStore.readImage).toHaveBeenCalledOnce()
  })

  it('deduplicates repeated attachment ids across messages', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const id = AttachmentId(`sha256:${'e'.repeat(64)}`)
    const fakeStore = {
      readImage: vi.fn().mockResolvedValue({
        ref: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 2, height: 2 },
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }),
    }
    const adapter = new CcAdapter({
      options: () => resolveAdapterOptions({ baseURL: server.url }, TEST_USER_ID),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => fakeStore as never,
    })
    const imgBlock = {
      type: 'image' as const,
      attachment: { attachmentId: id, mediaType: 'image/png' as const, bytes: 4, width: 2, height: 2 },
    }
    const messages = [
      createUserMessage({ content: [imgBlock], source: { kind: 'plugin', plugin: 'test' } }),
      createUserMessage({ content: [imgBlock], source: { kind: 'plugin', plugin: 'test' } }),
    ]
    for await (const _ of adapter.stream({ provider: 'cc', model: 'claude-opus-4-8', messages })) {
      // consume
    }
    expect(fakeStore.readImage).toHaveBeenCalledOnce()
  })

  it('deduplicates a tool-result nested image already resolved from a top-level block', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const id = AttachmentId(`sha256:${'ab'.repeat(32)}`)
    const fakeStore = {
      readImage: vi.fn().mockResolvedValue({
        ref: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 2, height: 2 },
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }),
    }
    const adapter = new CcAdapter({
      options: () => resolveAdapterOptions({ baseURL: server.url }, TEST_USER_ID),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => fakeStore as never,
    })
    const messages = [
      createUserMessage({
        content: [
          { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 2, height: 2 } },
          {
            type: 'tool-result',
            toolCallId: 'call-dup' as never,
            content: [{ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 4, width: 2, height: 2 } }],
          },
        ],
        source: { kind: 'plugin', plugin: 'test' },
      }),
    ]
    for await (const _ of adapter.stream({ provider: 'cc', model: 'claude-opus-4-8', messages })) {
      // consume
    }
    // The same attachment appears in both a top-level image block and nested in a tool-result;
    // readImage should be called only once due to dedup.
    expect(fakeStore.readImage).toHaveBeenCalledOnce()
  })

  it('rejects images through the full plugin path when no attachment service is mounted', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    vi.stubEnv('CC_API_KEY', 'test-key')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmCc, { baseURL: server.url })
    const id = AttachmentId(`sha256:${'9'.repeat(64)}`)
    const result = await assemble(ctx, {
      model: 'claude-opus-4-8',
      messages: [createUserMessage({
        content: [{
          type: 'image',
          attachment: { attachmentId: id, mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
        }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'UNSUPPORTED_CONTENT' } })
  })
})
