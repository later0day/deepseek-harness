/**
 * `CcAdapter`: fetch + SSE against a Claude Code gateway (Anthropic messages
 * protocol), emitting harness StreamChunks. Every request carries the Claude
 * Code fingerprint the gateway admits: `Authorization: Bearer`, the
 * `claude-cli` user-agent, `x-app: cli`, the `anthropic-beta` feature list, and
 * a body whose `system[0]` is the billing header (see {@link ../serialize}).
 * The adapter is transport-only: connection facts arrive through a thunk
 * resolved once per operation and the token through a per-request resolver, so
 * the registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-cc/adapter
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, contentHasImage, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { serializeRequest } from './serialize.ts'
import type { ResolvedImage, RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** One optional model entry advertised by the adapter. */
export interface CcCatalogModel {
  /** Wire model id accepted by the configured gateway. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail. */
  description?: string
  /** Known combined request/response context capacity; omitted when unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link CcConnectionOptions.maxTokens}. */
  maxTokens?: number
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, which makes a
 * configuration change reach the next request without re-registration.
 */
export interface CcConnectionOptions {
  /** Endpoint base; `/v1/messages?beta=true` is appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request. It
   * travels with the endpoint so a request can never pair one generation's URL
   * with another generation's secret.
   */
  apiKeyEnv: CredentialRef
  /** Claude Code version stamped into the fingerprint (user-agent + billing header). */
  claudeCodeVersion: string
  /** The `anthropic-beta` feature list the gateway requires. */
  betaFeatures: readonly string[]
  /** Fingerprint body facts and the default effort. */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly CcCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link CcAdapter}: the operation-local resolution hooks the plugin owns. */
export interface CcAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => CcConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the token can only come from the
   * same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: CcConnectionOptions) => Promise<string>
  /**
   * Resolve the durable attachment store for image content. Returns `undefined`
   * when no store is available in the current composition; image blocks then
   * fail with `UNSUPPORTED_CONTENT` at serialization time.
   */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 64_000
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const HIGH_REASONING_EFFORT = ReasoningEffortId('high')
const MAX_REASONING_EFFORT = ReasoningEffortId('max')
const REASONING_EFFORTS = [
  { id: HIGH_REASONING_EFFORT, name: 'High' },
  { id: MAX_REASONING_EFFORT, name: 'Max' },
] as const

function modelInfo(provider: string, model: CcCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text', 'image'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('request-id') ?? headers.get('x-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx gateway response.
 * @param error - parsed error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The Claude Code adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class CcAdapter extends LlmAdapter {
  constructor(private readonly config: CcAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort: connection.defaults.defaultEffort === 'max'
          ? MAX_REASONING_EFFORT
          : HIGH_REASONING_EFFORT,
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream never
    // observes a configuration change and the next call re-resolves. The token
    // resolves from this snapshot, so an endpoint and the secret sent to it can
    // never come from different configuration generations.
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)

    // Resolve image attachments before entering the transport boundary so
    // serialize stays a pure synchronous function.
    const images = await this.resolveImages(options)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      images,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Claude Code stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Claude Code request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Claude Code stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Claude Code stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  /**
   * Resolve all image attachments in the conversation to base64 data. Returns
   * `undefined` when no images exist (the common case, avoiding map allocation).
   */
  private async resolveImages(
    options: GenerateOptions,
  ): Promise<ReadonlyMap<string, ResolvedImage> | undefined> {
    if (!contentHasImage(options.messages.flatMap(m => m.content))) return undefined
    const store = this.config.resolveAttachments?.()
    if (store === undefined) {
      throw new LlmError(
        'Claude Code image input requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    const images = new Map<string, ResolvedImage>()
    for (const message of options.messages) {
      for (const block of message.content) {
        if (block.type === 'image' && !images.has(block.attachment.attachmentId)) {
          const stored = await store.readImage(block.attachment)
          images.set(block.attachment.attachmentId, {
            mediaType: stored.ref.mediaType,
            data: Buffer.from(stored.data).toString('base64'),
          })
        }
        if (block.type === 'tool-result') {
          for (const nested of block.content) {
            if (nested.type === 'image' && !images.has(nested.attachment.attachmentId)) {
              const stored = await store.readImage(nested.attachment)
              images.set(nested.attachment.attachmentId, {
                mediaType: stored.ref.mediaType,
                data: Buffer.from(stored.data).toString('base64'),
              })
            }
          }
        }
      }
    }
    return images
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: CcConnectionOptions,
    apiKey: string,
    images: ReadonlyMap<string, ResolvedImage> | undefined,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options, connection.defaults, images)
    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    const headers = {
      // Claude Code fingerprint the gateway admits: Bearer auth, the claude-cli
      // user-agent, x-app, and the anthropic-beta feature list. Removing any
      // one of these makes the gateway reject the request.
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-beta': connection.betaFeatures.join(','),
      // The fingerprint owns user-agent: it MUST be the claude-cli value, never
      // the harness attribution UA, or the gateway rejects the request.
      'user-agent': `claude-cli/${connection.claudeCodeVersion} (external, cli)`,
      'x-app': 'cli',
    }

    // TODO(http): adopt the Cordis HTTP service when shared transport configuration
    // outweighs its additional runtime dependencies.
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/v1/messages?beta=true`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `Claude Code request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `Claude Code gateway error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('Claude Code gateway returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onComment))
  }
}
