// Web e2e scenario: the Models settings page renders a rotation pool end to
// end through the real wire. The keypool lane swaps the shipped file-backed
// credentials row for the opt-in `dsh-credentials-keypool` provider, declares
// one `QWEN_API_KEY` pool over eight member references, seeds seven of them
// with synthetic placeholders, and hand-declares a `qwen` pi-ai route whose
// `apiKeyEnv` names that pool. Opening the route's editor surfaces the pool
// block the ordinary reference view never shows: the `Key pool` label, the
// `round_robin` policy badge, a `7/8 configured` count, and one chip per
// member with a configured/missing dot. Zero model calls: the page is pure
// settings/credentials/llm-domain traffic, so there is no fixture and a stray
// stream would fail loud because the adapter registry is empty. The pool is
// read-only and value-free by construction, so the captured page carries no
// member value — the snapshot proves the rotation topology reaches the user
// without any stored key leaving the host.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/models-settings-keypool', import.meta.url))
const POOL_EXPECTED = join(SNAPSHOT_DIR, 'pool.expected.md')
const MODE = webSnapshotMode()

// The eight member references the pool rotates over; seven are seeded so the
// snapshot shows both configured and missing member state. Never a real key:
// the pool is read-only and value-free, and the scenario asserts no synthetic
// value reaches the page.
const MEMBERS = Array.from({ length: 8 }, (_, i) => `QWEN_API_KEY_${String(i + 1)}`)
const SEEDED = MEMBERS.filter(ref => ref !== 'QWEN_API_KEY_2')

describe('web e2e: Models settings page renders a rotation pool', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      keypool: {
        pools: { QWEN_API_KEY: { policy: 'round_robin', members: MEMBERS } },
        members: Object.fromEntries(SEEDED.map(ref => [ref, `synthetic-${ref}`])),
        piAiProviders: {
          qwen: {
            displayName: 'Qwen',
            apiKeyEnv: 'QWEN_API_KEY',
            api: 'openai-completions',
            baseURL: 'https://dashscope.example/compatible-mode/v1',
            models: [{ id: 'qwen-max' }],
          },
        },
      },
    })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('surfaces the pool block for a route whose key reference describes as a pool', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-keypool'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '模型' }).click()
    await dialog.getByText('填入各提供方的 API 密钥即可使用其模型。').waitFor({ timeout: 10_000 })

    // The seeded qwen route lands as a row after topology resolution; it is in
    // no installed catalog, so it carries the declared tag.
    const row = dialog.locator('li').filter({ hasText: 'Qwen' }).first()
    await row.waitFor({ timeout: 10_000 })
    await expect.poll(async () => row.getByText('自定义').count(), { timeout: 10_000 }).toBe(1)

    await dialog.getByRole('button', { name: '编辑 Qwen (qwen)' }).click()
    // The pool block only renders once the credential describe answers with a
    // pool view; the ordinary reference row never shows it.
    await dialog.getByText('密钥池', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('轮换', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByText('7/8 已配置', { exact: true }).waitFor({ timeout: 10_000 })
    for (const ref of MEMBERS) {
      await dialog.getByText(ref, { exact: true }).waitFor({ timeout: 10_000 })
    }

    // The read-only pool carries no member value onto the page: no synthetic
    // placeholder, and no stored value of any member reaches the wire.
    const content = await page.content()
    for (const ref of SEEDED) expect(content).not.toContain(`synthetic-${ref}`)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(POOL_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['pool.expected.md'])
  })
})
