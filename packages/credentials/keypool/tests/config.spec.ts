import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Config, resolvePools } from '../src/config.ts'

describe('Config', () => {
  it('defaults pools to empty and the file fields to the base defaults', () => {
    const parsed = new Config({ path: '/tmp/creds.yaml' })
    expect(parsed).toEqual({ path: '/tmp/creds.yaml', watch: true, debounceMs: 100, pools: {} })
  })

  it('defaults a pool policy to round_robin', () => {
    const parsed = new Config({
      path: '/tmp/creds.yaml',
      pools: { QWEN_API_KEY: { members: ['QWEN_API_KEY_1', 'QWEN_API_KEY_2'] } },
    })
    expect(parsed.pools).toEqual({
      QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1', 'QWEN_API_KEY_2'] },
    })
  })

  it('keeps an explicit manual policy and pinned active member', () => {
    const parsed = new Config({
      path: '/tmp/creds.yaml',
      pools: { POOL: { policy: 'manual', members: ['POOL_1', 'POOL_2'], active: 'POOL_2' } },
    })
    expect(parsed.pools?.POOL).toEqual({ policy: 'manual', members: ['POOL_1', 'POOL_2'], active: 'POOL_2' })
  })

  it('rejects a pool with no members', () => {
    expect(() => new Config({
      path: '/tmp/creds.yaml',
      pools: { POOL: { members: [] } },
    })).toThrow()
  })
})

describe('resolvePools', () => {
  it('brands members and the pinned active reference into a pool spec', () => {
    const resolved = resolvePools({
      QWEN_API_KEY: { policy: 'manual', members: ['QWEN_API_KEY_1', 'QWEN_API_KEY_2'], active: 'QWEN_API_KEY_2' },
    })
    expect(resolved).toEqual({
      QWEN_API_KEY: {
        policy: 'manual',
        members: [credentialRef('QWEN_API_KEY_1'), credentialRef('QWEN_API_KEY_2')],
        active: credentialRef('QWEN_API_KEY_2'),
      },
    })
  })

  it('defaults an omitted policy to round_robin', () => {
    const resolved = resolvePools({ POOL: { members: ['POOL_1'] } })
    expect(resolved.POOL?.policy).toBe('round_robin')
  })

  it('omits active when none is pinned', () => {
    const resolved = resolvePools({ POOL: { policy: 'round_robin', members: ['POOL_1'] } })
    expect(resolved.POOL).toEqual({ policy: 'round_robin', members: [credentialRef('POOL_1')] })
    expect('active' in resolved.POOL!).toBe(false)
  })

  it('resolves an omitted map to no pools', () => {
    expect(resolvePools(undefined)).toEqual({})
  })

  it('rejects a member reference that is not a POSIX identifier', () => {
    expect(() => resolvePools({ POOL: { policy: 'round_robin', members: ['not a ref'] } })).toThrow()
  })

  it('rejects a pool reference that is not a POSIX identifier', () => {
    expect(() => resolvePools({ 'not a ref': { policy: 'round_robin', members: ['POOL_1'] } })).toThrow()
  })

  it('rejects a pinned active reference that is not a POSIX identifier', () => {
    expect(() => resolvePools({
      POOL: { policy: 'manual', members: ['POOL_1'], active: 'not a ref' },
    })).toThrow()
  })
})
