/**
 * Key-pool credentials provider: a thin rotation over the file-backed provider.
 *
 * A *pool reference* is the name an adapter asks for (for example
 * `QWEN_API_KEY`); its *members* are the concrete stored references the pool
 * rotates over (for example `QWEN_API_KEY_1` … `QWEN_API_KEY_8`), each held in
 * the same `$DSH_HOME/.credentials.yaml` document the base provider owns. On
 * every resolution of a pool reference this provider picks one member by the
 * pool's policy and resolves *that* member through the inherited file backend;
 * everything that is not a declared pool reference — resolution, description,
 * writes, hot reload, disposal — is the base provider's behavior unchanged.
 *
 * Rotation lives here rather than in an LLM adapter because the credentials
 * seam is resolved once per operation: a consumer that re-reads its key at each
 * request automatically sees the next member, with no adapter change and no
 * access to any adapter-private state.
 * @module @deepseek-ai/dsh-credentials-keypool
 */

import type { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import type { CredentialInfo, CredentialRef, PoolMemberView, PoolView, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { Config, resolvePools } from './config.ts'
import type { PoolSpec } from './types.ts'
import { pickMember } from './pick.ts'

/**
 * Rotating credentials provider. Subclasses the file-backed provider and
 * intercepts only the pool references named in {@link Config.pools}; all other
 * references, and all storage, defer to the base implementation.
 */
export class KeypoolCredentialProvider extends LocalCredentialProvider {
  /** Config schema: the file-backed fields plus the declarative pool map. */
  static override Config = Config

  /** Declared pools keyed by pool reference; empty leaves the provider inert. */
  private readonly pools: Record<string, PoolSpec>
  /**
   * Per-pool round-robin cursor, in memory only. It starts at zero every boot:
   * which member a fresh process begins on carries no meaning, only that
   * successive resolutions advance, so there is nothing to persist.
   */
  private readonly cursors = new Map<string, number>()

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    // Brand the declared pools into runtime specs once, at load: a malformed
    // reference fails here rather than at first resolution.
    this.pools = resolvePools(config.pools)
  }

  /**
   * The declared pool for a reference, or `undefined` when the reference is not
   * a pool and must pass straight through to the base provider.
   * @param ref - the reference an adapter asked for.
   * @returns the pool declaration, or `undefined`.
   */
  private poolFor(ref: CredentialRef): PoolSpec | undefined {
    return Object.prototype.hasOwnProperty.call(this.pools, ref) ? this.pools[ref] : undefined
  }

  /**
   * Pick the next member of a pool and advance its cursor. The picked member is
   * what the base provider then resolves or describes.
   * @param ref - the pool reference.
   * @param spec - its declaration.
   * @returns the chosen member reference.
   */
  private nextMember(ref: CredentialRef, spec: PoolSpec): CredentialRef {
    const cursor = this.cursors.get(ref) ?? 0
    const { ref: member, nextCursor } = pickMember(spec, cursor)
    this.cursors.set(ref, nextCursor)
    return member
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const spec = this.poolFor(ref)
    if (spec === undefined) return super.resolve(ref)
    return super.resolve(this.nextMember(ref, spec))
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const spec = this.poolFor(ref)
    if (spec === undefined) return super.describe(ref)
    return this.describePool(spec)
  }

  /**
   * Describe a pool without advancing its cursor: the pool is configured when
   * any member is, sourced from the first configured member, and never
   * writable — a pool reference maps to no single stored slot, so
   * {@link set}/{@link unset} reject it and `writable` reports that. The
   * returned {@link CredentialInfo.pool} block names the policy and every
   * member with its own `configured`/`source`, so a configuration surface can
   * show which members are missing while the pool still reports configured. It
   * carries no value, and it names only this pool's own members, so it stays
   * value-free and adds no enumeration path.
   * @param spec - the pool declaration.
   * @returns the aggregate description with its rotation topology.
   */
  private async describePool(spec: PoolSpec): Promise<CredentialInfo> {
    // One base describe per member, bounded by the declared member count.
    const members = await Promise.all(spec.members.map(async (member): Promise<PoolMemberView> => {
      const info = await super.describe(member)
      return {
        ref: member,
        configured: info.configured,
        ...info.source === undefined ? {} : { source: info.source },
      }
    }))
    const pool: PoolView = { policy: spec.policy, members }
    // The aggregate is the first configured member's source; a pool reference
    // maps to no single stored slot, so it is never writable.
    const firstConfigured = members.find(member => member.configured)
    if (firstConfigured === undefined) return { configured: false, writable: false, pool }
    return {
      configured: true,
      ...firstConfigured.source === undefined ? {} : { source: firstConfigured.source },
      writable: false,
      pool,
    }
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    if (this.poolFor(ref) !== undefined) {
      return Promise.reject(new Error(
        `credentials-keypool: "${ref}" is a rotation pool, not a stored key; set its members instead`,
      ))
    }
    return super.set(ref, value)
  }

  override unset(ref: CredentialRef): Promise<void> {
    if (this.poolFor(ref) !== undefined) {
      return Promise.reject(new Error(
        `credentials-keypool: "${ref}" is a rotation pool, not a stored key; unset its members instead`,
      ))
    }
    return super.unset(ref)
  }
}

export default KeypoolCredentialProvider
