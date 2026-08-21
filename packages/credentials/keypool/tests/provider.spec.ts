import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { KeypoolCredentialProvider } from '../src/provider.ts'
import type { Policy } from '../src/types.ts'

const POOL = credentialRef('QWEN_API_KEY')
const PLAIN = credentialRef('DEEPSEEK_API_KEY')

/**
 * Pool declarations as the plugin config accepts them at input: member and
 * active references are plain strings that Schemastery brands on validation, so
 * a test writes ordinary identifiers rather than pre-branded refs.
 */
type PoolInput = { policy?: Policy; members: string[]; active?: string }

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Eight member keys, exactly the fan-out the base bundle declares for QWEN. */
function eightMembers(): Record<string, string> {
  const doc: Record<string, string> = {}
  for (let i = 1; i <= 8; i += 1) doc[`QWEN_API_KEY_${i}`] = `key-${i}`
  return doc
}

async function seededHome(entries: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-keypool-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const text = Object.entries(entries).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n'
  await writeFile(join(dir, '.credentials.yaml'), text, { mode: 0o600 })
  return dir
}

async function boot(dir: string, pools: Record<string, PoolInput>): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(KeypoolCredentialProvider, {
    path: join(dir, '.credentials.yaml'),
    watch: false,
    pools,
  })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

async function values(ctx: Context, ref: typeof POOL, times: number): Promise<Array<string | undefined>> {
  const out: Array<string | undefined> = []
  for (let i = 0; i < times; i += 1) {
    const resolved: ResolvedCredential | undefined = await ctx.credentials.resolve(ref)
    out.push(resolved?.value)
  }
  return out
}

describe('round_robin rotation', () => {
  it('walks all eight members in order and wraps around', async () => {
    const dir = await seededHome(eightMembers())
    const members = Array.from({ length: 8 }, (_unused, i) => `QWEN_API_KEY_${i + 1}`)
    const ctx = await boot(dir, { QWEN_API_KEY: { policy: 'round_robin', members } })
    const seen = await values(ctx, POOL, 10)
    expect(seen).toEqual([
      'key-1', 'key-2', 'key-3', 'key-4', 'key-5', 'key-6', 'key-7', 'key-8', 'key-1', 'key-2',
    ])
  })
})

describe('manual rotation', () => {
  it('always resolves the pinned active member', async () => {
    const dir = await seededHome(eightMembers())
    const ctx = await boot(dir, {
      QWEN_API_KEY: { policy: 'manual', members: ['QWEN_API_KEY_1', 'QWEN_API_KEY_5'], active: 'QWEN_API_KEY_5' },
    })
    expect(await values(ctx, POOL, 3)).toEqual(['key-5', 'key-5', 'key-5'])
  })
})

describe('pass-through', () => {
  it('resolves a non-pool reference straight through to the file backend', async () => {
    const dir = await seededHome({ ...eightMembers(), DEEPSEEK_API_KEY: 'ds-key' })
    const ctx = await boot(dir, { QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1'] } })
    expect(await ctx.credentials.resolve(PLAIN)).toEqual({ value: 'ds-key', source: 'file' })
  })

  it('is inert with no pools declared', async () => {
    const dir = await seededHome({ DEEPSEEK_API_KEY: 'ds-key' })
    const ctx = await boot(dir, {})
    expect(await ctx.credentials.resolve(PLAIN)).toEqual({ value: 'ds-key', source: 'file' })
  })

  it('treats omitted pools as empty under programmatic construction', async () => {
    // Constructing the class directly bypasses Schemastery's `pools` default,
    // exercising the constructor's own fallback. No fiber runs the init
    // lifecycle, so the store stays empty and a pool reference — with no pool
    // declared — resolves straight through to `undefined`.
    const dir = await seededHome({ QWEN_API_KEY: 'direct-key' })
    const ctx = new Context()
    const provider = new KeypoolCredentialProvider(ctx, {
      path: join(dir, '.credentials.yaml'),
      watch: false,
    })
    expect(await provider.resolve(POOL)).toBeUndefined()
  })
})

describe('describe', () => {
  it('reports a pool configured, read-only, sourced from the first configured member, with a per-member topology', async () => {
    const dir = await seededHome({ QWEN_API_KEY_2: 'key-2' })
    const ctx = await boot(dir, {
      QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1', 'QWEN_API_KEY_2'] },
    })
    expect(await ctx.credentials.describe(POOL)).toEqual({
      configured: true,
      source: 'file',
      writable: false,
      pool: {
        policy: 'round_robin',
        members: [
          { ref: 'QWEN_API_KEY_1', configured: false },
          { ref: 'QWEN_API_KEY_2', configured: true, source: 'file' },
        ],
      },
    })
  })

  it('reports a pool unconfigured when no member is stored, still carrying the member topology', async () => {
    const dir = await seededHome({})
    const ctx = await boot(dir, {
      QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1'] },
    })
    expect(await ctx.credentials.describe(POOL)).toEqual({
      configured: false,
      writable: false,
      pool: { policy: 'round_robin', members: [{ ref: 'QWEN_API_KEY_1', configured: false }] },
    })
  })

  it('carries an env-sourced member through as read-only, with the member source in the topology', async () => {
    const dir = await seededHome({})
    const ctx = await boot(dir, {
      QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1'] },
    })
    vi.stubEnv('QWEN_API_KEY_1', 'from-env')
    expect(await ctx.credentials.describe(POOL)).toEqual({
      configured: true,
      source: 'env',
      writable: false,
      pool: { policy: 'round_robin', members: [{ ref: 'QWEN_API_KEY_1', configured: true, source: 'env' }] },
    })
  })

  it('preserves the declared member order and manual policy label in the topology', async () => {
    const dir = await seededHome({ QWEN_API_KEY_5: 'key-5' })
    const ctx = await boot(dir, {
      QWEN_API_KEY: { policy: 'manual', members: ['QWEN_API_KEY_5', 'QWEN_API_KEY_1'], active: 'QWEN_API_KEY_5' },
    })
    const info = await ctx.credentials.describe(POOL)
    expect(info.pool).toEqual({
      policy: 'manual',
      members: [
        { ref: 'QWEN_API_KEY_5', configured: true, source: 'file' },
        { ref: 'QWEN_API_KEY_1', configured: false },
      ],
    })
  })

  it('never places a member value in the topology', async () => {
    const dir = await seededHome(eightMembers())
    const members = Array.from({ length: 8 }, (_unused, i) => `QWEN_API_KEY_${i + 1}`)
    const ctx = await boot(dir, { QWEN_API_KEY: { policy: 'round_robin', members } })
    const info = await ctx.credentials.describe(POOL)
    const serialized = JSON.stringify(info)
    for (let i = 1; i <= 8; i += 1) expect(serialized).not.toContain(`key-${i}`)
    const [first] = info.pool!.members
    expect(Object.keys(first!).sort()).toEqual(['configured', 'ref', 'source'])
  })

  it('describes a non-pool reference straight through, with no pool block', async () => {
    const dir = await seededHome({ DEEPSEEK_API_KEY: 'ds-key' })
    const ctx = await boot(dir, { QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1'] } })
    const info = await ctx.credentials.describe(PLAIN)
    expect(info).toEqual({ configured: true, source: 'file', writable: true })
    expect(info.pool).toBeUndefined()
  })
})

describe('writes', () => {
  it('rejects set on a pool reference', async () => {
    const dir = await seededHome({})
    const ctx = await boot(dir, { QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1'] } })
    await expect(ctx.credentials.set(POOL, 'x')).rejects.toThrow('is a rotation pool')
  })

  it('rejects unset on a pool reference', async () => {
    const dir = await seededHome({})
    const ctx = await boot(dir, { QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1'] } })
    await expect(ctx.credentials.unset(POOL)).rejects.toThrow('is a rotation pool')
  })

  it('writes a non-pool reference straight through to the file backend', async () => {
    const dir = await seededHome({})
    const ctx = await boot(dir, { QWEN_API_KEY: { policy: 'round_robin', members: ['QWEN_API_KEY_1'] } })
    await ctx.credentials.set(PLAIN, 'ds-key')
    expect(await ctx.credentials.resolve(PLAIN)).toEqual({ value: 'ds-key', source: 'file' })
    await ctx.credentials.unset(PLAIN)
    expect(await ctx.credentials.resolve(PLAIN)).toBeUndefined()
  })
})
