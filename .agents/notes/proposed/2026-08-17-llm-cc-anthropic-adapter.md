# llm-cc: Claude Code anthropic-messages adapter plugin

Status: proposed
Date: 2026-08-17

## Why

The harness can drive `claude-opus-4-8` only through the local agentproxy gateway,
which admits requests carrying a complete Claude Code fingerprint. The existing
pi-ai anthropic adapter cannot produce that fingerprint: its Claude-Code identity
path triggers only on `sk-ant-oat` OAuth tokens, and even then it emits a fixed
`system[0]` string rather than the billing header the gateway requires, and its
body-level fields are not configurable. A dedicated adapter plugin owns the exact
request the gateway accepts.

## Verified facts (PoC, /tmp/cc-poc.mjs against real proxy on 127.0.0.1:9090)

Gateway ADMITS a request iff ALL of:
- `Authorization: Bearer <token>` (never `x-api-key`).
- Headers: `user-agent: claude-cli/<v>`, `x-app: cli`, full `anthropic-beta` list.
- Body `system[0]` = `x-anthropic-billing-header: cc_version=<v>; cc_entrypoint=cli;`.
- Body carries `metadata.user_id`, `thinking:{type:adaptive}`,
  `context_management`, `output_config:{effort}`.

PoC results: plain text → HTTP 200, assembled "pong"; tool call → HTTP 200,
`get_weather({"city":"Paris"})` streamed via `input_json_delta`. Request
fingerprint and Anthropic-SSE→StreamChunk translation both proven.

## Package: @deepseek-ai/dsh-llm-cc (packages/llm/llm-cc), provider route `cc`

Mirror llm-deepseek structure; direct fetch + SSE (no pi-ai dependency).

Files:
- `package.json` — peers: dsh-llm, dsh-credentials, dsh-launch-environment,
  dsh-settings, dsh-timeout, dsh-anonymous-user-id, dsh-invariants, cordis;
  deps: eventsource-parser, dsh-schemastery.
- `tsconfig.json` — extends base; references those workspaces (copy deepseek's).
- `src/types.ts` — Anthropic messages wire types (request body + SSE event union:
  message_start, content_block_start/delta/stop, message_delta, message_stop, error).
- `src/serialize.ts` — harness GenerateOptions → Anthropic body. Maps messages
  (user/assistant/tool-result → Anthropic content blocks; tool-result → user-role
  tool_result block), tools → `input_schema`, and INJECTS the CC fingerprint:
  billing `system[0]`, metadata, thinking:adaptive, context_management, output_config
  from reasoningEffort.
- `src/sse.ts` — reuse eventsource-parser stream; Anthropic has no `[DONE]`,
  terminal is `message_stop`.
- `src/translate.ts` — Anthropic events → StreamChunk (block-start/text-delta/
  reasoning-delta/tool-call-delta/block-end/usage/finish). Stateful per block index.
- `src/adapter.ts` — `CcAdapter extends LlmAdapter`: per-request resolve of
  connection+key (like DeepSeekAdapter), idleWatchdog, header block with Bearer +
  CC fingerprint + attributionHeaders(), fetch, error mapping.
- `src/index.ts` — Config (apiKeyEnv=CC_API_KEY, baseURL, claudeCodeVersion,
  betaFeatures[], models[], reasoningEffort, maxTokens, streamIdleTimeoutMs,
  retryPolicy), apply() with registerConfigurableProviders + registerAdapter +
  installSettingsSection.
- `src/invariant.ts` — empty companion (no independent event stream), like deepseek.

## Config-driven fingerprint (no hardcoded tunables)

claudeCodeVersion, betaFeatures[], baseURL all Config fields — the gateway's
private policy may change, so these must be reconfigurable from cordis.yml/settings.
Protocol constants (anthropic-version, x-app value, billing-header format) stay fixed.

## Tests (tests/*.spec.ts, per-file 100% coverage gate)

- serialize.spec.ts — body shape: billing system[0] present, metadata/thinking/
  context_management/output_config injected, message+tool mapping, effort mapping.
- translate.spec.ts — each Anthropic event → correct StreamChunk; tool_use assembly;
  finish/usage from message_delta.
- sse.spec.ts — framing, message_stop terminal.
- adapter.spec.ts / loader-composition.spec.ts / dynamic-config.spec.ts — mirror
  deepseek: registration, per-request resolution, settings swap. Mock fetch/server.

Gateway is a private proxy → not keyless-replayable in CI; PoC covers that path.

## Docs

- packages/llm/README.md + new package README (bilingual per docs/AGENTS.md).
- docs/config-catalog.md, docs/user/guide/providers.md — add cc provider.
- This Agent Note moves proposed → implemented on merge.

## Compose + default model

- Add `cc` provider to a cordis.yml or rely on settings.yaml (already has `cc`).
- Set ~/.dsh/settings.yaml agent-default-model → provider: cc, model: claude-opus-4-8.
- Verify: `pnpm dsh --profile headless "reply pong"` returns via opus through proxy.

## Risks

- SSE translation is the only substantial new logic (Anthropic events differ from
  OpenAI chunks); PoC validated the mapping.
- Gateway policy is external; fingerprint drift is absorbed by Config fields.
