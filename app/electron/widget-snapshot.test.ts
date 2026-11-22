import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { makeWidgetUsage, makeWidgetQuota, startWidgetSnapshots, WIDGET_AGENTS, WIDGET_EXTENSION_ID } from './widget-snapshot'
import type { QuotaProvider } from './quota/types'

const now = new Date(2026, 10, 20, 12)
const usage = (date: string, inputTokens = 100, cacheReadTokens = 300) => ({
  date, calls: 1, inputTokens, cacheReadTokens, cacheWriteTokens: 100, outputTokens: 20,
})
const report = (...daily: unknown[]) => ({ history: { daily } })

describe('desktop widget usage snapshot', () => {
  it('includes cached tokens once and computes the weighted cache hit rate', () => {
    const snapshot = makeWidgetUsage([
      report(usage('2026-11-20')),
      report(usage('2026-11-15', 25, 75), usage('2026-11-20', 500, 100)),
      report(),
    ], now)
    expect(snapshot?.agents).toEqual([
      { id: 'codex', tokens: 520, input: 500, cached: 300 },
      { id: 'zcode', tokens: 720, input: 700, cached: 100 },
      { id: 'antigravity', tokens: 0, input: 0, cached: 0 },
    ])
    expect(snapshot?.days).toHaveLength(7)
    expect(snapshot?.days[0]).toEqual({ day: '2026-11-14', tokens: 0 })
    expect(snapshot?.days[1]).toEqual({ day: '2026-11-15', tokens: 220 })
    expect(snapshot?.days[6]).toEqual({ day: '2026-11-20', tokens: 1240 })
  })

  it('rejects a partial or stale CodeBurn scan', () => {
    expect(makeWidgetUsage([report(), { ...report(), hydration: { complete: false } }, report()], now)).toBeNull()
    expect(makeWidgetUsage([report(), report(), { ...report(), stale: true }], now)).toBeNull()
  })

  it('preserves missing counts as unknown even if other agents reported usage', () => {
    const snapshot = makeWidgetUsage([
      report(usage('2026-11-20')),
      report({ date: '2026-11-20', calls: 3, inputTokens: 500 }),
      report(),
    ], now)
    expect(snapshot?.agents[1]).toEqual({ id: 'zcode', tokens: null, input: null, cached: null })
    expect(snapshot?.days.at(-1)?.tokens).toBeNull()
  })
})

describe('desktop widget quota snapshot', () => {
  it('retains the complete five-hour and weekly buckets for each Antigravity model group', () => {
    const windows = [
      { label: 'Claude and GPT models · Five Hour Limit Remaining', percent: 1, resetsAt: null },
      { label: 'Claude and GPT models · Weekly Limit Remaining', percent: 0.69, resetsAt: null },
      { label: 'Gemini 4 Argon · Gemini 4 Argon Weekly Limit Remaining', percent: 0.68, resetsAt: null },
      { label: 'Gemini Models · Five Hour Limit Remaining', percent: 0.24, resetsAt: null },
      { label: 'Gemini Models · Weekly Limit Remaining', percent: 0.25, resetsAt: null },
    ]
    const row: QuotaProvider = {
      provider: 'antigravity', connection: 'connected', primary: windows[0]!,
      details: windows, planLabel: null, footerLines: [],
    }
    expect(makeWidgetQuota([row], now).agents.find(agent => agent.id === 'antigravity')?.windows).toEqual(windows)
  })

  it('keeps the last known Codex quota across temporary failures and clears it on disconnect', () => {
    const weekly = { label: 'Weekly', percent: 0.55, resetsAt: '2026-11-22T00:00:00Z' }
    const codex: QuotaProvider = {
      provider: 'codex', connection: 'connected', primary: weekly, details: [weekly],
      planLabel: 'Pro', footerLines: [],
    }
    const live = makeWidgetQuota([codex], now)
    const empty = { ...codex, primary: null, details: [] }
    const retrying = { ...empty, connection: 'transientFailure' } as const
    const first = makeWidgetQuota([retrying], new Date(now.getTime() + 60_000), live)
    const second = makeWidgetQuota([retrying], new Date(now.getTime() + 120_000), first)
    expect(first.agents[0]).toEqual({ id: 'codex', windows: [weekly], stale: true })
    expect(second.agents[0]).toEqual(first.agents[0])
    expect(makeWidgetQuota([{ ...empty, connection: 'disconnected' }], now, second).agents[0])
      .toEqual({ id: 'codex', windows: [] })
    expect(makeWidgetQuota([codex], now, second).agents[0])
      .toEqual({ id: 'codex', windows: [weekly] })
  })

  it('includes published windows only for the three agents and retains reset time', () => {
    const weekly = { label: 'Weekly', percent: 0.45, resetsAt: '2026-11-22T00:00:00Z' }
    const session = { label: '5-hour', percent: 0.76, resetsAt: null }
    const rows = [
      { provider: 'zcode', connection: 'connected', primary: weekly, details: [session, weekly] },
      { provider: 'antigravity', connection: 'transientFailure', primary: session, details: [session] },
      { provider: 'claude', connection: 'connected', primary: weekly, details: [weekly] },
    ] as QuotaProvider[]
    const snapshot = makeWidgetQuota(rows, now)
    expect(snapshot.agents.map(row => row.id)).toEqual(WIDGET_AGENTS)
    expect(snapshot.agents[1]).toEqual({ id: 'zcode', windows: [weekly, session] })
    expect(snapshot.agents[0]?.windows).toEqual([])
    expect(snapshot.agents[2]).toEqual({ id: 'antigravity', windows: [session], stale: true })
  })
})

it('writes numerical snapshots using the widget’s own sandbox container', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codeburn-widget-test-'))
  const container = path.join(home, 'Library', 'Containers', WIDGET_EXTENSION_ID, 'Data')
  const destination = path.join(container, 'Library', 'Application Support', 'CodeBurn Widgets', 'snapshot.json')
  await mkdir(container, { recursive: true })
  const readUsage = vi.fn(async (_args: string[]) => report())
  const readQuota = vi.fn(async () => WIDGET_AGENTS.map(provider => ({
    provider, connection: 'connected' as const,
    primary: { label: 'Weekly', percent: 0, resetsAt: null }, details: [],
    planLabel: null, footerLines: [],
  })))
  const stop = startWidgetSnapshots(home, readUsage, readQuota)
  try {
    await vi.waitFor(async () => {
      const snapshot = JSON.parse(await readFile(destination, 'utf8'))
      expect(snapshot.version).toBe(1)
      expect(snapshot.usage.agents).toEqual(WIDGET_AGENTS.map(id => ({ id, tokens: 0, input: 0, cached: 0 })))
      expect(snapshot.quota.agents).toEqual(WIDGET_AGENTS.map(id => ({
        id, windows: [{ label: 'Weekly', percent: 0, resetsAt: null }],
      })))
      expect(snapshot.updatedAt).toBe(snapshot.usage.updatedAt)
      expect(snapshot.updatedAt).toBe(snapshot.quota.updatedAt)
    })
    expect(readUsage.mock.calls.map(([args]) => args[args.indexOf('--provider') + 1])).toEqual(WIDGET_AGENTS)
    expect(readQuota).toHaveBeenCalledOnce()
  } finally {
    stop()
    await rm(home, { recursive: true, force: true })
  }
})
