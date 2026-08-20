# dsh-credentials-keypool

English | [中文](README.zh.md)

Rotating [credentials](../credentials/README.md) provider: one pool reference, many member keys, picked by policy.

It subclasses [`credentials-local`](../credentials-local/README.md). A *pool reference* is the name an adapter asks for (for example `QWEN_API_KEY`); its *members* are concrete stored keys in the same `$DSH_HOME/.credentials.yaml` document (for example `QWEN_API_KEY_1` … `QWEN_API_KEY_8`). On every resolution of a pool reference this provider picks one member by the pool's policy and resolves *that* member through the inherited file backend. Everything that is not a declared pool reference — resolution, description, writes, hot reload, disposal — is the file provider's behavior unchanged.

Rotation lives at the credential seam, not in an LLM adapter, because the seam is resolved once per operation: an adapter that re-reads its key at each request (both the direct DeepSeek and pi-ai adapters do) automatically sees the next member, with no adapter change and no access to adapter-private state.

## Config

The file-backed fields (`path`, `dshHome`, `watch`, `debounceMs`) carry through to the underlying document exactly as in [`credentials-local`](../credentials-local/README.md), plus:

| Field | Default | Meaning |
|---|---|---|
| `pools` | `{}` | Pool declarations keyed by the pool reference an adapter asks for. |

Each pool is `{ policy, members, active? }`:

| Field | Default | Meaning |
|---|---|---|
| `policy` | `round_robin` | `round_robin` or `manual`. |
| `members` | — | Non-empty ordered list of member references (POSIX identifiers), each a key stored in the document. |
| `active` | first member | The pinned member for `manual`; ignored by `round_robin`. |

An empty `pools` leaves the provider a pass-through over the file backend.

## Policies

- **`round_robin`** advances a per-pool in-memory cursor on every resolution, walking members in declaration order and wrapping around. The cursor starts at zero each boot: which member a fresh process begins on carries no meaning, only that successive resolutions advance, so nothing is persisted.
- **`manual`** always resolves the pinned `active` member (or the first member when none is pinned or the pin is not a member) and never advances, so the choice is the operator's.

Error-driven `failover` is deliberately absent. Advancing on a failed request needs the retry seam in `llm/stream`, which credential resolution never sees; it belongs to a retrying consumer, not a credential provider. Rotation here is load-spreading, not resilience — a rate-limited or revoked member is still selected in turn until removed.

## Pool references are not stored slots

A pool reference maps to no single stored key, so:

- `resolve(pool)` returns the picked member's value and its source layer (`env`/`file`/`project-env`/`user-env`).
- `describe(pool)` reports `configured: true` when any member is configured — sourced from the first configured member — and always `writable: false`.
- `set(pool, …)` and `unset(pool)` reject: store or remove the *members* instead. Non-pool references write straight through to the document.

## The document

Members are ordinary entries in the same YAML document [`credentials-local`](../credentials-local/README.md#the-document) owns — nothing new on disk:

```yaml
QWEN_API_KEY_1: sk-…
QWEN_API_KEY_2: sk-…
QWEN_API_KEY_3: sk-…
```

The pool that maps `QWEN_API_KEY` onto these members is composition, declared in `pools`, not a document entry.

## Wiring

Swap the credential provider through a user overlay — a profile's `cordis.patch.yml` under `$DSH_HOME`, or a `--patch` file — never the shipped `base` bundle: the pool and its keys are deployment-varying configuration, and the shipped default stays `credentials-local` for every profile.

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: credentials
  disabled: true
- insert:
    - id: credentials
      name: '@deepseek-ai/dsh-credentials-keypool'
      config:
        pools:
          QWEN_API_KEY:
            policy: round_robin
            members:
              - QWEN_API_KEY_1
              - QWEN_API_KEY_2
              - QWEN_API_KEY_3
```

## Model Experience

Indirectly, through the consuming LLM adapters, exactly as [`credentials-local`](../credentials-local/README.md#model-experience): stored values authorize provider requests and the adapter owns every model-visible surface. Rotation is invisible above the resolved value.

#### KV Cache effect

`round_robin` changes the resolved key between requests, which can move traffic across provider-side prefix caches keyed per account; `manual` pins one member and preserves that locality. No request prefix contains the credential, so there is no direct in-process invalidation.

## Known Limitations and Deferred Work

- **No error-driven failover** — see [Policies](#policies); a bad member is selected in turn until removed. A retry-layer failover is deferred.
- **The cursor is memory-only** — a restart does not resume a round-robin position; only relative advance is meaningful.
- Inherits every limitation of [`credentials-local`](../credentials-local/README.md#known-limitations-and-deferred-work), including same-UID read access and frozen-at-launch environment layers.
