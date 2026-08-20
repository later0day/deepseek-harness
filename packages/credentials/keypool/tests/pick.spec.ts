import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { pickMember } from '../src/pick.ts'
import type { PoolSpec } from '../src/types.ts'

const M1 = credentialRef('DSH_KEYPOOL_M1')
const M2 = credentialRef('DSH_KEYPOOL_M2')
const M3 = credentialRef('DSH_KEYPOOL_M3')

describe('pickMember round_robin', () => {
  const spec: PoolSpec = { policy: 'round_robin', members: [M1, M2, M3] }

  it('walks the members in declaration order and advances the cursor', () => {
    expect(pickMember(spec, 0)).toEqual({ ref: M1, nextCursor: 1 })
    expect(pickMember(spec, 1)).toEqual({ ref: M2, nextCursor: 2 })
    expect(pickMember(spec, 2)).toEqual({ ref: M3, nextCursor: 3 })
  })

  it('wraps around the members as the cursor grows', () => {
    expect(pickMember(spec, 3)).toEqual({ ref: M1, nextCursor: 4 })
    expect(pickMember(spec, 4)).toEqual({ ref: M2, nextCursor: 5 })
  })
})

describe('pickMember manual', () => {
  it('resolves the pinned active member and never advances', () => {
    const spec: PoolSpec = { policy: 'manual', members: [M1, M2, M3], active: M2 }
    expect(pickMember(spec, 7)).toEqual({ ref: M2, nextCursor: 7 })
  })

  it('falls back to the first member when no active is pinned', () => {
    const spec: PoolSpec = { policy: 'manual', members: [M1, M2] }
    expect(pickMember(spec, 3)).toEqual({ ref: M1, nextCursor: 3 })
  })

  it('falls back to the first member when the pin is not a member', () => {
    const spec: PoolSpec = { policy: 'manual', members: [M1, M2], active: M3 }
    expect(pickMember(spec, 0)).toEqual({ ref: M1, nextCursor: 0 })
  })
})

describe('pickMember exhaustiveness', () => {
  it('throws on an unhandled policy', () => {
    const bogus = { policy: 'lru', members: [M1] } as unknown as PoolSpec
    expect(() => pickMember(bogus, 0)).toThrow('unhandled rotation policy: lru')
  })
})
