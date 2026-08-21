# Agent Note: Key-pool rotation, read-only in the credentials UI

Status: proposed

English | [中文](2026-08-21-keypool-rotation-ui.zh.md)

## Problem

`@deepseek-ai/dsh-credentials-keypool` resolves a pool reference (`QWEN_API_KEY`) to one of eight member keys (`QWEN_API_KEY_1..8`) by policy, but every configuration surface still sees the pool as one ordinary key. The models settings section (`packages/client/ui-settings-models`) describes the route's `apiKeyEnv: QWEN_API_KEY` through `api.credentials.describe({ refs })` and renders "API key configured" from the returned `CredentialView` — a single read-only key with no hint that eight interchangeable members back it or that one member could be unconfigured while the pool still reports configured. The pool topology (policy plus member reference names) exists only in `~/.dsh/cordis.patch.yml`; no wire field carries it, so no surface can show it. A user cannot tell from the UI that QWEN rotates, how many members are stored, or which members are missing.

## Proposal

Surface rotation state read-only, through the credential seam that already reaches the browser, with no new writable RPC and no persisted state. The change is one optional value-free field on the credential describe path, one producer (keypool), and generic rendering in the existing models section.

**Service Definition (`packages/credentials/credentials`).** Add an optional `pool?: PoolView` to `CredentialInfo`, where `PoolView = { policy: string; members: PoolMemberView[] }` and `PoolMemberView = { ref: CredentialRef; configured: boolean; source?: string }`. The base `CredentialProvider.describe` contract leaves `pool` undefined; only a provider that owns rotation populates it. The field is value-free: it carries member reference *names* and per-member `configured`/`source`, never member values, so it obeys the seam's existing "reads are structurally value-free" rule. It also does not violate "no enumeration by design": a caller still names the pool reference it already learned from the route's `apiKeyEnv` settings field, and describing that one named reference returns its shape — the seam adds no method that lists references.

**Provider (`packages/credentials/keypool`).** `KeypoolCredentialProvider.describe(ref)` for a pool reference returns the base describe of the pool (its `configured`/`source` stay the first-configured-member semantics already shipped) plus a `pool` block built by describing each member reference through `super.describe`. For a non-pool reference it returns `super.describe(ref)` unchanged, so `pool` stays undefined. Member describe is bounded by the declared member count (eight for QWEN), so the pool describe is O(members) base reads.

**Host RPC (`packages/host/apiproxy/src/api/credentials.ts`).** Mirror the optional block on `CredentialView` (`pool?: { policy: string; members: { ref: string; configured: boolean; source?: string }[] }`). The `describe` method maps `CredentialInfo.pool` straight through; the value-free and no-enumeration contract in that module's header extends to the pool block verbatim.

**Frontend (`packages/client/ui-settings-models`).** When `describe` for a route's `apiKeyEnv` returns a `pool` block, `ProviderEditor` renders, in place of the single "API key configured" line, a pool badge with the policy label and one chip per member showing configured state (for QWEN: eight chips, "N/8 configured"). Rendering is generic over any pool, keyed only on the presence of `pool`; it names no member reference and hardcodes no count. The section already subscribes to `credentials/updated`; setting or unsetting any member re-describes the pool reference and refreshes the chips, because each member write emits `credentials/updated` for that member and the section re-runs its describe on the pooled reference.

No keypool-specific client package is created: the pool block is a generic credential-view concept with one producer, so the models section renders it the way it renders every other credential, and the wire stays provider-neutral.

## Alternatives considered

**A keypool-specific client package (`ui-credentials-keypool`).** Rejected: it would duplicate the models section's describe/subscribe wiring for one provider and split credential rendering across two owners. The pool block is value-free credential state; the generic surface that already describes `apiKeyEnv` is its natural home.

**Expose the live cursor / next member.** Deferred. The round-robin cursor is in-memory and resets each boot; showing it truthfully needs keypool to emit a rotation event (or describe to read the cursor), and the display would be a best-effort real-time position rather than durable state. Read-only member/policy state is the useful first layer and needs no new event.

**Interactive control (switch policy, pin active, reset cursor from the UI).** Deferred. It requires a new writable RPC (`credentials.pools.setActive` or similar), keypool persisting the active selection, and enforcement at the resolution point — a materially larger seam touching persisted state. This proposal deliberately stops at read-only so the write path is designed separately once the read surface is proven.

**Put the pool block on a new dedicated describe method rather than `CredentialInfo`.** Rejected: it would fork the one describe path every consumer already calls and force the models section to call two methods for one reference. An optional field on the existing return keeps one call site.

## Acceptance criteria

- `KeypoolCredentialProvider.describe(pool)` returns a `pool` block naming the policy and every member with its `configured`/`source`; `describe` of a non-pool reference and the base `LocalCredentialProvider.describe` leave `pool` undefined.
- `api.credentials.describe` carries the `pool` block through `CredentialView`, and a test asserts no member value ever appears in the response.
- The models settings section renders QWEN as a pool: policy `round_robin` and eight member chips reflecting stored state; unsetting one member updates that chip without reload.
- A keyless snapshot through `apps/web` captures the pooled-credential rendering in the models section.

## Verification

- `packages/credentials/keypool/tests/provider.spec.ts` covers the describe contract: a pool reference returns the policy and every member; a non-pool reference and the base provider leave `pool` undefined; and "never places a member value in the topology" serializes the describe and asserts no member value appears.
- `packages/host/apiproxy/tests/api-proxy-config.spec.ts` asserts `credentials.describe` carries the `pool` block through `CredentialView` value-free.
- `packages/client/ui-settings-models/tests/components.client.spec.tsx` renders the pool as a policy badge, `N/M configured` count, and per-member chips, and asserts no member value reaches the page.
- `apps/web/tests/models-settings-keypool.e2e.ts` is the keyless `apps/web` snapshot: the scaffold's `keypool` lane swaps the shipped file-backed credentials row for the opt-in provider, declares a `QWEN_API_KEY` pool over eight members, seeds seven, and hand-declares a `qwen` pi-ai route. The golden (`snapshots/models-settings-keypool/pool.expected.md`) shows `密钥池 轮换 7/8 已配置` with eight member chips and no member value.

## Risks

- Adds an optional field to a Service Definition consumed by every provider for the benefit of one producer. Justified: the pool topology has no other home, the field is optional and value-free, and the seam rule ("design for all current consumers") is satisfied because the field is a generic credential-view concept, not keypool-internal vocabulary crossing the boundary.
- Pool describe performs one base read per member. Bounded by the declared member count; no unbounded fan-out.
- Read-only state can look stale relative to which member a request actually used, because the cursor is not shown. Accepted for this layer; the deferred cursor/event work owns that gap.
- The models section's rendering must stay generic over member count and reference names; a hardcoded "8" or `QWEN_*` string would regress the moment a second pool is declared. Guarded by rendering keyed only on the `pool` block's contents.
