/**
 * Rotation types for the key-pool credentials provider: a closed set of
 * rotation policies and the resolved shape of one pool.
 * @module @deepseek-ai/dsh-credentials-keypool/types
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * How a pool reference selects one member per resolution.
 *
 * - `round_robin` advances a per-pool cursor on every resolution, spreading
 *   load across members in declaration order.
 * - `manual` always resolves the pinned {@link PoolSpec.active} member (or the
 *   first member when none is pinned), so the choice is the operator's, not the
 *   provider's.
 *
 * Error-driven `failover` is deliberately absent: advancing on a failed request
 * requires the retry seam in `llm/stream`, which this credential-resolution path
 * never sees. It belongs to a retrying consumer, not to a credential provider.
 */
export type Policy = 'round_robin' | 'manual'

/**
 * One fully resolved pool: the member references it rotates over and the policy
 * that picks among them. Members are the concrete stored references (for
 * example `QWEN_API_KEY_1`), each resolvable through the underlying file-backed
 * provider; the pool reference is the name the adapter asks for (for example
 * `QWEN_API_KEY`).
 */
export interface PoolSpec {
  /** Rotation policy applied on each resolution. */
  policy: Policy
  /** Member references rotated over, in declaration order; never empty. */
  members: CredentialRef[]
  /** The pinned member for `manual`; defaults to the first member when absent. */
  active?: CredentialRef
}
