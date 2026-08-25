# @deepseek-ai/dsh-llm-cc

English | [中文](README.zh.md)

Claude Code adapter for the harness LLM seam: direct `fetch` + SSE (framed by `eventsource-parser`) translating the Anthropic messages streaming protocol into the `StreamChunk` protocol. It drives `claude-opus-4-8` (and any Claude model the gateway serves) through a Claude Code gateway that admits only requests carrying the complete Claude Code fingerprint.

The gateway checks a request fingerprint no ordinary Anthropic client sends: `Authorization: Bearer` (never `x-api-key`), the `claude-cli` user-agent, `x-app: cli`, the `anthropic-beta` feature list, a billing header as `system[0]`, and body-level `metadata.user_id`, `thinking:{type:adaptive}`, `context_management`, and `output_config`. This package owns the `cc` provider route and injects that fingerprint on every request.

The package root exposes the Cordis plugin contract and `CcAdapter`; wire serialization, SSE parsing, and chunk translation helpers are not part of that root contract.

## Config

```yaml
- id: llm-cc
  name: '@deepseek-ai/dsh-llm-cc'
  config:
    apiKeyEnv: CC_API_KEY    # default; resolved per request via ctx.credentials, then the environment
    baseURL: http://127.0.0.1:9090 # optional; the local agentproxy relay when omitted
    claudeCodeVersion: 2.1.228 # fingerprint version (user-agent + billing header)
    betaFeatures:            # anthropic-beta feature list the gateway requires
      - claude-code-20250219
      - interleaved-thinking-2025-05-14
      - context-management-2025-06-27
      - effort-2025-11-24
    contextEdits:            # server-side context-management edits sent on every request
      - type: clear_thinking_20251015
        keep: all
    reasoningEffort: high    # optional; low | medium | high | xhigh | max — omitted ⇒ high
    maxTokens: 64000         # optional positive per-request output cap; this is the default
    defaultContextWindow: 200000 # optional positive-integer fallback; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    retryPolicy:             # optional; omission uses normal defaults
      mode: always           # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    models:                  # optional; defaults to Claude Opus 4.8
      - id: claude-opus-4-8
        name: Claude Opus 4.8
        contextWindow: 200000
```

The plugin registers the single provider route `cc` together with its resolved `retryPolicy`; omission resolves to normal defaults. A request selects it with `provider: cc`; its `model` is passed through as the wire `model` string, so changing Claude models does not require lifecycle-time registration. Omitting `models` advertises `claude-opus-4-8` with a 200,000-token context window; an explicit list replaces that default, while `models: []` advertises none. Catalog entries are exposed through `ctx.llm.listModels('cc')` for clients such as ACP editors and the Web selector, but remain advisory: unlisted model ids still pass through unchanged. An omitted entry name defaults to its id. Registering another adapter for `cc` throws `LlmError('DUPLICATE_ADAPTER')`.

`claudeCodeVersion`, `betaFeatures`, `baseURL`, and `contextEdits` are the fingerprint parts the gateway checks. They are Config fields because the gateway's private admission policy can change; the protocol constants the adapter fixes (anthropic-version `2023-06-01`, `x-app: cli`, the billing-header format, `thinking.type: adaptive`) are not configurable.

`contextWindow` is optional per configured model and is not exposed through the advisory catalog. `ctx.llm.resolveModelInfo('cc', model).context` returns an exact model value first, then `defaultContextWindow` for an entry without capacity or an unlisted pass-through id. The adapter default is 200,000; pressure-sensitive plugins therefore get deployment-owned capacity without treating the model selector as authoritative.

`maxTokens` is the adapter-configured output cap and defaults to 64,000; Anthropic requires a positive `max_tokens` on every request. A catalog entry may carry its own `maxTokens`, which wins for that model; an entry without one, and any unlisted pass-through id, resolve to the profile value. Exact-model resolution exposes the winner as `defaultMaxTokens`, which `LlmRuntime` materializes into `GenerateOptions.maxTokens` before the agent loop writes `request/header`; an explicit request or `AgentOptions.maxTokens` value wins and is serialized as `max_tokens`.

The same exact-model result exposes ordered `low`, `medium`, `high`, `xhigh`, and `max` efforts under `reasoning`. `reasoningEffort` selects the deployment default and falls back to `high` when omitted. `agent/request` can replace it on each conversation step; the resolved value is logged in `request/header` and serialized as `output_config.effort`. The harness-only `off` effort maps to gateway `low` — the gateway always thinks — so a request never disables thinking on the wire. An unsupported value fails with `UNSUPPORTED_REASONING_EFFORT` before network I/O.

## Dynamic configuration (settings + credentials)

Connection facts are not frozen at load. `resolveAdapterOptions` is the one explicit resolve step from raw config to validated facts, and the adapter re-reads them through a thunk **once per operation**: base URL, catalog, fingerprint version and features, request defaults, and idle budget all take effect on the next request, while an in-flight stream keeps the facts it started with. Three optional seams feed that thunk:

- **`ctx.settings`** — the plugin registers the `llm-cc` namespace with this same `Config` schema and its `cordis.yml` entry as the composition `base`, so a `llm-cc:` section in the user settings document overrides any field without a restart. Without a mounted settings service the entry config alone drives the adapter, unchanged. A live settings snapshot that passes the schema but fails a beyond-schema bound (a duplicate catalog id, an empty version or feature list) keeps the last good facts and logs the failure; the entry config itself still fails plugin load.
- **`ctx.credentials`** — the bearer token resolves per stream call, from the *same* resolved snapshot that supplies the endpoint, so a request can never pair one generation's URL with another generation's secret. Configuration carries only `apiKeyEnv`, never a literal key: the reference resolves through the credential seam, and without a mounted seam through the trusted launch-environment layer. Every resolved key is format-checked before use, so a value no HTTP header can carry is refused with `LlmError('INVALID_CREDENTIAL')` naming the failing entry point — never any part of the key. A request with no key anywhere fails with `MISSING_CREDENTIAL` naming the configuration entry point, while the route stays registered and the catalog stays browsable.
- **`ctx.attachments`** — image requests resolve this service at request time, so Cordis load order does not freeze optional image availability. Absence rejects image input with `UNSUPPORTED_CONTENT`; text-only calls do not require the service.

The one registration-captured fact is the retry policy: when its resolved value changes, the plugin re-registers the route in place (same adapter instance, one synchronous section), so `ctx.llm.providerRetryPolicy('cc')` always reports the current policy.

The plugin also declares its route in the configurable-provider directory (`ctx.llm.listConfigurableProviders()`): provider `cc`, display name `Claude Code`, settings namespace `llm-cc`, empty settings path — the whole section is the profile. Configuration surfaces use that entry to offer this adapter alongside other providers.

## Request fingerprint

Every request carries the Claude Code fingerprint the gateway admits; removing any one part makes the gateway reject the request. Headers: `Authorization: Bearer <token>`, `user-agent: claude-cli/<version> (external, cli)`, `x-app: cli`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`, and the joined `anthropic-beta` feature list. Body: `system[0]` is the billing header `x-anthropic-billing-header: cc_version=<version>; cc_entrypoint=cli;` (the harness system prompt follows as `system[1]`), plus `metadata.user_id`, `thinking:{type:adaptive}`, `context_management.edits`, and `output_config.effort`. The `metadata.user_id` is a JSON object built from the stable anonymous id of [`@deepseek-ai/dsh-anonymous-user-id`](../../identity/anonymous-user-id/README.md); the fingerprint owns the `user-agent`, so the harness attribution baseline is deliberately not sent on this route.

## Wire-format notes

- Streaming only. Usage accumulates across `message_start` (input + cache reads) and `message_delta` (output + cache writes); the translator defers both to `message_stop`, so `usage` always precedes `finish`.
- There is no `[DONE]` sentinel: the terminal event is `message_stop`. EOF before it throws `STREAM_CLOSED`.
- One harness block per Anthropic content-block index: `text` → text, `thinking` → reasoning, `tool_use` → tool-call. `tool_use` carries its id and name at block open, never in later deltas; `input_json_delta` streams the argument string.
- `signature_delta` carries no harness-visible content and is dropped.
- Cache accounting maps `cache_read_input_tokens` → `cacheReadTokens` and `cache_creation_input_tokens` → `cacheWriteTokens`; Anthropic reports `input_tokens` already disjoint from cache.
- Harness tool-result and image blocks ride in user-role messages and become Anthropic user-role `tool_result` and `image` blocks; empty tool output crosses the wire as the literal `(no output)`. Assistant `tool-call` arguments are parsed from the raw string into JSON `input`.

## Errors

Non-2xx responses throw `LlmError` with stable codes: `AUTH` (401/403), `QUOTA` (a response whose provider details identify exhausted quota, balance, or credits), `RATE_LIMIT` (other 429s), `CONTEXT_WINDOW_EXCEEDED` (a 400 whose provider type or message identifies context overflow), `INVALID_REQUEST` (other 400s), `SERVER` (5xx), `HTTP_<status>` otherwise. Its serializable `failure` retains the HTTP status plus a valid positive `retry-after` seconds/date delay and `request-id` / `x-request-id` when present; the gateway's error message becomes the primary text, and malformed error JSON never masks the status. A pre-response transport failure (DNS, refused connection, TLS, proxy) throws `TRANSPORT` naming the configured endpoint and chaining the original rejection as `cause`; caller aborts throw `ABORTED`, and the per-read idle watchdog throws `TIMEOUT` after `streamIdleTimeoutMs`. Protocol violations throw `STREAM_CLOSED` (no `message_stop`), `MALFORMED_RESPONSE` (bad JSON payload), or `PROVIDER_ERROR` (a stream `error` event). Unknown wire `stop_reason`s become `finish {kind: 'error', failure}` chunks, and a completed stream whose `end_turn` (or absent) finish opened no content blocks becomes a `finish {kind: 'error'}` with code `EMPTY_RESPONSE`. A gateway response with no body throws `EMPTY_RESPONSE`. Image input with no attachment service throws `UNSUPPORTED_CONTENT`.

## Model Experience

### Claude Code request

#### What the model sees

The selected Claude model receives the billing `system[0]` header followed by the harness system prompt, message history, tool schemas, stop sequences, and call config. Retained user and tool-result images are sent as base64 `image` blocks resolved from the durable attachment store; a request with images and no attachment service is rejected before the wire. The gateway-required `thinking:adaptive`, `context_management`, and `output_config.effort` accompany every request.

#### Token effect

Provider tokenization governs exact text and image-token input. The billing `system[0]` header and the server-side `context_management` edits are constant per request; cache-read usage is reported when the gateway returns it.

#### KV Cache effect

An unchanged assembled prefix — the fixed billing header, system prompt, and history — is eligible for gateway cache reuse, which this adapter reports as `cacheReadTokens`. A model-route change or any upstream prompt, schema, prefix, history, fingerprint-version, or image change may prevent reuse from the first changed token.

### Claude Code response

#### What the model sees

Thinking, text, and tool-call arguments stream as Anthropic content-block deltas and are translated into harness chunks for the loop to log and assemble; `thinking` blocks become reasoning blocks.

#### Token effect

Generated tokens follow the request's logged reasoning effort and `maxTokens`; only loop-retained blocks affect later input. Cache-write usage is reported when the gateway returns it.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect. Changing the provider or model selects a different cache domain.

## Known Limitations and Deferred Work

- **The gateway is a private proxy** — its request path is not keyless-replayable in CI; a PoC against the live relay covers it, and unit tests mock `fetch` and the SSE stream.
- **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy/interception configuration; adoption is deferred until a second adapter wants it (`TODO(http)`).
- **The harness-only `off` effort cannot disable thinking** — the gateway always thinks, so `off` maps to `low`; a deployment cannot turn reasoning off on this route.
- **Images are input-only base64 attachments** — direct external URLs and assistant image output are not supported, and there is no Files API offload, so a large image history is sent inline every request.
- **A settings `models` list replaces the composition list wholesale** — settings-layer merging is per-field, and arrays are one field; per-entry catalog merging would need a keyed shape.
