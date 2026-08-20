# Agent Note: Key-pool credential rotation

Status: implemented

English | [中文](2026-08-21-credentials-keypool-rotation.zh.md)

## Problem

An operator with several interchangeable API keys for one provider — a rate-limited plan split across accounts, a bank of gateway keys — cannot spread requests across them. The `credentials` seam resolves one reference to one value, and every adapter asks for a single reference (`QWEN_API_KEY`, `DEEPSEEK_API_KEY`), so all traffic authenticates from the same key until it is edited by hand. The third-party dockyard-dsh plugin solved this by monkeypatching the private `llm.adapters` map to wrap each adapter's `resolveApiKey`, which reaches into adapter-internal fields no public interface exposes and cannot pass this repository's gates.

## Decision

`@deepseek-ai/dsh-credentials-keypool` adds rotation at the credential seam instead of the adapter. It is a `KeypoolCredentialProvider` that subclasses the file-backed `LocalCredentialProvider`: a *pool reference* (the name an adapter asks for, e.g. `QWEN_API_KEY`) maps to an ordered list of *member references* (concrete stored keys, e.g. `QWEN_API_KEY_1` … `QWEN_API_KEY_8`) held in the same `$DSH_HOME/.credentials.yaml` document. On each `resolve` of a pool reference the provider picks one member by the pool's policy and delegates to `super.resolve(member)`; every reference not declared as a pool, and all storage, is the base provider's behavior unchanged.

Rotation lives at the credential seam because the seam is resolved once per operation: both the direct DeepSeek adapter (`llm-deepseek/src/index.ts`) and the pi-ai adapter (`llm-pi-ai/src/index.ts`) call `credentials.resolve(ref)` at each request, so a rotating provider spreads keys across requests for every adapter with no adapter change and no access to adapter-private state.

Two policies ship. `round_robin` advances a per-pool in-memory cursor on every resolution, walking members in declaration order and wrapping around; the cursor starts at zero each boot because which member a fresh process begins on carries no meaning, only that successive resolutions advance. `manual` always resolves the pinned `active` member (or the first member when none is pinned), so the choice stays the operator's. Error-driven `failover` is deliberately absent: advancing on a failed request needs the retry seam in `llm/stream`, which this resolution path never sees.

A pool reference has no single stored slot, so `describe` reports it configured when any member is (sourced from the first configured member) and never writable, and `set`/`unset` reject it with a message pointing at its members. The pool declarations are validated `Config` (`pools`, a map of pool reference to `{policy, members, active?}`), so the package ships no hardcoded pool; an empty map leaves the provider a pass-through over the file backend.

Wiring a pool into a running harness is a user overlay, not a change to the shipped `base` bundle: a profile's `cordis.patch.yml` under `$DSH_HOME` (or a `--patch` file) disables the default `credentials` row and inserts one bound to this package with the operator's pool. The shipped default stays `credentials-local` for every profile, and the deployment-varying pool composition and its member keys live only in the untracked harness home.

## Alternatives considered

- **Monkeypatch `llm.adapters` (dockyard's approach).** `llm.adapters` is a private map with no public getter and adapter `config` is adapter-internal; wrapping `resolveApiKey` needs `(llm as any)` casts into private fields, which the type and hygiene gates reject. It also duplicates the wrap for every adapter kind. The seam-level provider reaches every adapter through one public interface.
- **Rotate inside a new LLM plugin on `llm/stream`.** This is the right layer for *error-driven* failover — it sees request outcomes — but wrong for load spreading: it would re-implement per-request key selection that the credential seam already resolves, and it could not serve non-LLM credential consumers. Failover is left for that layer if it is ever built.
- **Compose a separate base provider in an isolated scope and delegate to it.** Cordis services are single-slot and `provide` throws on a duplicate `credentials` registration, so a delegating provider would need an `ctx.isolate` wrapper with no precedent in the codebase. Subclassing reuses the base provider's file locking, layering, hot reload, and disposal through its public and protected surface with a much smaller coupling area.
- **Bake the pool into the shipped `base` bundle.** The pool and its keys are deployment-varying configuration; hardcoding them in the product tree violates the no-hardcoded-tunables rule and would change the `credentials` provider for every profile and every snapshot. A user overlay keeps the default untouched.

## Testing

Package unit tests pin the pure selection (`round_robin` order and wrap, `manual` pin and first-member fallback, closed-union exhaustiveness), the config schema (policy default, member branding, empty-member and empty-pool rejection), and the provider over a temporary document (eight-key rotation sequence, manual pinning, non-pool and empty-pool pass-through, aggregate `describe`, and `set`/`unset` rejection on a pool reference). Per-file coverage is 100%.

## Consequences

An operator spreads one provider's traffic across many keys by listing them as pool members and swapping the credential provider through a user overlay — no adapter, session-format, or SDK change, because rotation is invisible above the resolved value. The cursor is memory-only, so restarts do not resume a round-robin position; this is intended, since only relative advance matters. Rotation is load-spreading, not resilience: a member that is rate-limited or revoked is still selected in turn until the operator removes it, because error-driven failover belongs to a retry layer this package does not add.
