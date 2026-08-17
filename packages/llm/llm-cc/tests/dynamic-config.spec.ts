import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { INVALID_CREDENTIAL_CODE } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmCc from '@deepseek-ai/dsh-llm-cc'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-cc')
const KEY_REF = credentialRef('CC_API_KEY')

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-cc-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  ctx: Context
  settingsFiber: { dispose(): Promise<void> }
}

/**
 * Real dynamic composition: llm + settings-file + credentials-local + llm-cc
 * over one temp harness home. `watch: false` keeps every change flowing through
 * the in-process write path, which is deterministic.
 */
async function boot(dir: string, config: object): Promise<Harness> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await settingsFiber
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmCc, config)
  return { ctx, settingsFiber }
}

function prompt(ctx: Context) {
  return assemble(ctx, { model: 'claude-opus-4-8', messages: [] })
}

describe('request-level dynamic configuration', () => {
  it('routes the next request with the freshly resolved base URL and credential', async () => {
    vi.stubEnv('CC_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'CC_API_KEY: first-key\n', { mode: 0o600 })
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: serverA.url })

    await prompt(ctx)
    expect(serverA.headers[0]?.authorization).toBe('Bearer first-key')

    await ctx.settings.update(NS, { baseURL: serverB.url })
    await ctx.credentials.set(KEY_REF, 'second-key')

    await prompt(ctx)
    expect(serverA.requests).toHaveLength(1)
    expect(serverB.headers[0]?.authorization).toBe('Bearer second-key')
  })

  it('resolves the credential through a mounted seam and stamps the anonymous id lazily', async () => {
    vi.stubEnv('CC_API_KEY', '')
    const dir = await home()
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx } = await boot(dir, { baseURL: server.url })

    const keyless = await prompt(ctx)
    expect(keyless.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    await ctx.credentials.set(KEY_REF, 'sk-arrived')
    await prompt(ctx)
    expect(server.headers[0]?.authorization).toBe('Bearer sk-arrived')
    await expect(access(join(dir, '.anonymous-user-id'))).resolves.toBeUndefined()
  })

  it('rejects a stored credential no header can carry, never echoing it in the failure', async () => {
    vi.stubEnv('CC_API_KEY', '')
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })
    const secret = 'sk-\u{1F600}supersecret'

    await ctx.credentials.set(KEY_REF, secret)
    const result = await prompt(ctx)
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: INVALID_CREDENTIAL_CODE } })
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.message).not.toContain(secret)
    expect(result.finish.failure.message).not.toContain('supersecret')
  })

  it('advertises a live settings catalog without re-registration', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    await expect(ctx.llm.listModels('cc')).resolves.toHaveLength(1)
    await ctx.settings.update(NS, { models: [{ id: 'settings-model', name: 'From Settings' }] })
    await expect(ctx.llm.listModels('cc')).resolves.toEqual([
      { provider: 'cc', id: 'settings-model', name: 'From Settings', inputModalities: ['text'] },
    ])
  })

  it('re-registers the route in place when the captured retry policy changes, without an empty-registry window', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })

    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('cc')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'cc', name: 'Claude Code' }])
    expect(observed).toEqual([['cc']])
  })

  it('leaves the route untouched when a settings change keeps the retry policy', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })
    await ctx.settings.update(NS, { claudeCodeVersion: '9.9.9' })
    expect(observed).toEqual([])
  })

  it('keeps the last good options when a settings snapshot fails beyond-schema validation', async () => {
    const dir = await home()
    const { ctx } = await boot(dir, { baseURL: 'http://127.0.0.1:1' })

    await ctx.settings.update(NS, { models: [{ id: 'dup' }, { id: 'dup' }] })
    await expect(ctx.llm.listModels('cc')).resolves.toHaveLength(1)
    await ctx.settings.update(NS, { models: [{ id: 'recovered' }] })
    await expect(ctx.llm.listModels('cc')).resolves.toEqual([
      { provider: 'cc', id: 'recovered', name: 'recovered', inputModalities: ['text'] },
    ])
  })

  it('falls back to the composition entry when settings detach', async () => {
    vi.stubEnv('CC_API_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'CC_API_KEY: steady-key\n', { mode: 0o600 })
    const serverA = await mockServer([{ kind: 'sse', events: textEvents }])
    const serverB = await mockServer([{ kind: 'sse', events: textEvents }])
    const { ctx, settingsFiber } = await boot(dir, { baseURL: serverA.url })

    await ctx.settings.update(NS, { baseURL: serverB.url })
    await prompt(ctx)
    expect(serverB.requests).toHaveLength(1)

    await settingsFiber.dispose()
    await prompt(ctx)
    expect(serverA.requests).toHaveLength(1)
    expect(serverA.headers[0]?.authorization).toBe('Bearer steady-key')
  })
})
