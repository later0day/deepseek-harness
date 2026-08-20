/**
 * Key-pool credentials provider package entry: a rotating
 * {@link KeypoolCredentialProvider} over the file-backed provider, exported as
 * the plugin's default so a composition mounts it in the `credentials` slot in
 * place of `dsh-credentials-local`.
 * @module @deepseek-ai/dsh-credentials-keypool
 */

export { KeypoolCredentialProvider, default } from './provider.ts'
export { Config } from './config.ts'
export type { Policy, PoolSpec } from './types.ts'
export { pickMember } from './pick.ts'
export type { Pick } from './pick.ts'
