/**
 * Pure member selection for the key-pool provider. Given a pool and the current
 * cursor, choose one member reference and report the next cursor. No I/O and no
 * state: the provider owns the cursor store and the credential reads; this file
 * owns only the policy arithmetic, so every branch is unit-coverable.
 * @module @deepseek-ai/dsh-credentials-keypool/pick
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { PoolSpec, Policy } from './types.ts'

/** One selection outcome: the chosen member and the cursor to store for next time. */
export interface Pick {
  /** The member reference to resolve for this operation. */
  ref: CredentialRef
  /** The cursor value to persist for the pool; unchanged by non-advancing policies. */
  nextCursor: number
}

/**
 * Select one member of a pool under its policy.
 *
 * - `round_robin` returns `members[cursor mod length]` and advances the cursor,
 *   so successive calls walk the members in declaration order and wrap around.
 * - `manual` returns the pinned {@link PoolSpec.active} member, or the first
 *   member when none is pinned or the pin is not a member, and never advances.
 *
 * The cursor is only meaningful for `round_robin`; `manual` returns it
 * unchanged so a policy switch at runtime does not lose the round-robin
 * position.
 * @param spec - the pool to select from; `members` is non-empty per its schema.
 * @param cursor - the pool's current cursor; any non-negative integer.
 * @returns the chosen member and the next cursor.
 */
export function pickMember(spec: PoolSpec, cursor: number): Pick {
  const policy: Policy = spec.policy
  switch (policy) {
    case 'round_robin': {
      // members is non-empty per schema, so the modulo index is always in range.
      const index = cursor % spec.members.length
      return { ref: spec.members[index] as CredentialRef, nextCursor: cursor + 1 }
    }
    case 'manual': {
      const pinned = spec.active !== undefined && spec.members.includes(spec.active)
        ? spec.active
        : spec.members[0] as CredentialRef
      return { ref: pinned, nextCursor: cursor }
    }
    default:
      return assertNever(policy)
  }
}

/**
 * Exhaustiveness guard for the closed {@link Policy} union: a new policy that
 * skips its `case` fails to type-check here rather than silently falling
 * through to a default at runtime.
 * @param value - the unreachable policy value.
 * @throws always, naming the unhandled value.
 */
function assertNever(value: never): never {
  throw new Error(`unhandled rotation policy: ${String(value)}`)
}
