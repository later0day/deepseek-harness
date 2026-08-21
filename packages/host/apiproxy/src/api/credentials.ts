/**
 * credentials domain contract: the web face of the credential-reference seam
 * (`ctx.credentials`). Reads are structurally value-free — a credential view
 * carries configured/source/writable (and, for a rotation pool, its member
 * topology) and has no slot for the value — and the value crosses the wire in
 * exactly one direction, inside `credentials.set`. There is no enumeration
 * method by design: clients learn which references exist from settings schemas
 * and values (`apiKeyEnv` fields), and a pool view names only the members of
 * the one described reference.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Wire view of one rotation-pool member: its reference name and configured state, never a value. */
export interface PoolMemberView {
  /** The member's own reference name (for example `QWEN_API_KEY_1`). */
  ref: string
  /** Whether any layer currently supplies a non-empty value for this member. */
  configured: boolean
  /** Winning layer when configured (`env`, `file`, …); provider vocabulary. */
  source?: string
}

/** Wire view of a rotation pool's topology: its policy and members, never a value. */
export interface PoolView {
  /** Provider-defined rotation policy label (`round_robin`, `manual`). */
  policy: string
  /** The pool's member references, in declaration order; never empty. */
  members: PoolMemberView[]
}

/** Wire view of one credential reference's state. */
export interface CredentialView {
  /** Whether any layer currently supplies a non-empty value. */
  configured: boolean
  /** Winning layer when configured (`env`, `file`, …); provider vocabulary. */
  source?: string
  /** Whether `credentials.set`/`credentials.unset` can affect this reference. */
  writable: boolean
  /** Rotation topology when the reference is a pool; absent for an ordinary reference. */
  pool?: PoolView
}

/** Credentials-domain unary methods (the map keys credentials.* of RpcMethodMap). */
export interface CredentialsApi {
  /**
   * Describe the named references (batch): configured state, winning source,
   * and writability — never values. An invalid reference name is a
   * `bad-request`; an unknown-but-valid one describes as unconfigured.
   */
  describe(request: RpcRequest<{ refs: string[] }>): Promise<RpcResponse<{ credentials: Record<string, CredentialView> }>>

  /**
   * Store one credential value in the writable layer. Rejected with
   * `credential-rejected` while a read-only layer (the live environment)
   * shadows the reference — the write would otherwise appear to succeed while
   * resolution keeps returning the shadowing value.
   */
  set(request: RpcRequest<{ ref: string; value: string }>): Promise<RpcResponse<{}>>

  /**
   * Remove one credential from the writable layer; same shadowing rejection
   * as `set`. Unsetting an absent reference succeeds (idempotent).
   */
  unset(request: RpcRequest<{ ref: string }>): Promise<RpcResponse<{}>>
}
