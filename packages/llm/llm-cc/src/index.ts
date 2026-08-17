/**
 * Register a {@link CcAdapter} for the `cc` provider route on `ctx.llm`, driving
 * `claude-opus-4-8` (and any Claude model the gateway serves) through a Claude
 * Code gateway that admits only requests carrying the Claude Code fingerprint.
 * Connection facts resolve per request rather than freezing at load: the plugin
 * layers its `cordis.yml` entry config under the optional `llm-cc` user-settings
 * section (`ctx.settings`) and resolves the token through the optional
 * credential seam (`ctx.credentials`), so a changed base URL, catalog, version,
 * or key reaches the next request without restarting anything, while an
 * in-flight stream keeps the facts it started with. The one
 * registration-captured fact — the retry policy — re-registers the route in
 * place when it changes.
 *
 * The fingerprint parts the gateway checks (Claude Code version, beta feature
 * list, base URL) are Config fields because the gateway's private admission
 * policy can change; protocol constants (anthropic-version, x-app value, billing
 * header format) stay fixed in the adapter.
 * @module @deepseek-ai/dsh-llm-cc
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import {
  CcAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.ts'
import type { CcCatalogModel, CcConnectionOptions } from './adapter.ts'
import type { WireEffort } from './serialize.ts'
import type { WireContextEdit } from './types.ts'

export {
  CcAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
} from './adapter.ts'
export type { CcAdapterOptions, CcCatalogModel, CcConnectionOptions } from './adapter.ts'
export type { RequestDefaults, WireEffort } from './serialize.ts'
export type * from './types.ts'

export const name = 'llm-cc'
export const inject = ['llm']

const NS = settingsNamespace('llm-cc')
const DEFAULT_API_KEY_ENV = 'CC_API_KEY'
/** The single provider route this plugin owns. */
const PROVIDER = 'cc'

/** Public Claude Code gateway default; the local agentproxy relay listens here. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:9090'

/** The Claude Code version the gateway currently expects in the fingerprint. */
const DEFAULT_CLAUDE_CODE_VERSION = '2.1.228'

/** The `anthropic-beta` feature list a current Claude Code request sends. */
const DEFAULT_BETA_FEATURES: string[] = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'effort-2025-11-24',
]

/** Server-side context-management edits a current Claude Code request sends. */
const DEFAULT_CONTEXT_EDITS: WireContextEdit[] = [
  { type: 'clear_thinking_20251015', keep: 'all' },
]

const DEFAULT_MODELS: CcCatalogModel[] = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

/**
 * Plugin config, validated by the same-named schemastery schema and doubling as
 * the `llm-cc` settings-section shape. Every field is optional in yml: a missing
 * key resolves through {@link Config.apiKeyEnv} at each request (a request
 * without a key fails with `MISSING_CREDENTIAL`, not at load), and omitted
 * fingerprint fields fall back to the current Claude Code defaults.
 */
export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `CC_API_KEY`. */
  apiKeyEnv?: string
  /** Gateway base URL; defaults to the local agentproxy relay. */
  baseURL?: string
  /** Claude Code version in the fingerprint (user-agent + billing header). */
  claudeCodeVersion?: string
  /** The `anthropic-beta` feature list the gateway requires. */
  betaFeatures?: string[]
  /** Server-side context-management edits sent on every request. */
  contextEdits?: WireContextEdit[]
  /** Default reasoning effort (default `high`). */
  reasoningEffort?: WireEffort
  /** Default per-request output cap (default 64,000); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 200,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to Claude Opus 4.8. */
  models?: CcCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<CcCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

const contextEdit: z<WireContextEdit> = z.object({
  type: z.string().required(),
  keep: z.string().required(),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  claudeCodeVersion: z.string().default(DEFAULT_CLAUDE_CODE_VERSION),
  betaFeatures: z.array(z.string()).default(DEFAULT_BETA_FEATURES),
  contextEdits: z.array(contextEdit).default(DEFAULT_CONTEXT_EDITS),
  reasoningEffort: z.union(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** One resolution's complete request facts. */
export type ResolvedCcOptions = CcConnectionOptions

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly CcCatalogModel[] | undefined): CcCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-cc: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-cc: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-cc: catalog model "${model.id}" contextWindow must be a positive integer`)
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-cc: catalog model "${model.id}" maxTokens must be a positive integer`)
    }
    if (seen.has(model.id)) throw new Error(`llm-cc: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — for the composition entry at load (fail
 * loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param userId - the fingerprint `metadata.user_id`, derived from the anonymous harness id.
 * @returns validated connection facts plus the credential reference.
 */
export function resolveAdapterOptions(config: Config, userId: string): ResolvedCcOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-cc: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-cc: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-cc: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const claudeCodeVersion = config.claudeCodeVersion ?? DEFAULT_CLAUDE_CODE_VERSION
  if (claudeCodeVersion.length === 0) throw new Error('llm-cc: claudeCodeVersion must be non-empty')
  const betaFeatures = config.betaFeatures ?? DEFAULT_BETA_FEATURES
  if (betaFeatures.length === 0) throw new Error('llm-cc: betaFeatures must list at least one feature')
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const defaultEffort = config.reasoningEffort ?? 'high'
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    claudeCodeVersion,
    betaFeatures,
    defaults: {
      claudeCodeVersion,
      userId,
      contextEdits: config.contextEdits ?? DEFAULT_CONTEXT_EDITS,
      defaultEffort,
      maxTokens,
    },
    maxTokens,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-cc: retryPolicy'),
  }
}

/** Build the fingerprint `metadata.user_id` JSON from an anonymous device id. */
function fingerprintUserId(deviceId: string): string {
  return JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: deviceId })
}

export function apply(ctx: Context, config: Config): void {
  const userId = fingerprintUserId(String(getOrCreateAnonymousUserId()))
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedCcOptions | undefined
  const options = (): ResolvedCcOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, userId)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound: keep
      // serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-cc: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: ResolvedCcOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-cc', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-cc', ref)
      }
    }
    throw new LlmError(
      `llm-cc: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new CcAdapter({ options, resolveApiKey })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Claude Code', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}
