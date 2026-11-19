import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { spawnCli } from './cli'
import type { getQuota } from './quota'
import { atomicWriteSecureFile, readSecureFile } from './quota/security'
import type { QuotaProvider, QuotaWindow } from './quota/types'

export const WIDGET_EXTENSION_ID = 'local.codeburn.bigmodel.widgets'
export const WIDGET_AGENTS = ['codex', 'zcode', 'antigravity'] as const
const OTHER_QUOTA_PROVIDERS = ['claude', 'gemini', 'copilot', 'kimi', 'grokbot']
const PROBE_INTERVAL_MS = 30_000
const SNAPSHOT_INTERVAL_MS = 5 * 60_000
const MAX_SNAPSHOT_BYTES = 32 * 1024

type Agent = typeof WIDGET_AGENTS[number]
type ObjectFields = Record<string, unknown>
type WidgetCounts = { tokens: number | null; input: number | null; cached: number | null }
type WidgetUsage = {
  day: string
  updatedAt: string
  agents: Array<WidgetCounts & { id: Agent }>
  days: Array<{ day: string; tokens: number | null }>
}
type WidgetQuota = {
  updatedAt: string
  agents: Array<{ id: Agent; windows: QuotaWindow[] }>
}
type WidgetSnapshot = { version: 1; usage: WidgetUsage | null; quota: WidgetQuota | null }

function object(value: unknown): ObjectFields | null {
  return value !== null && typeof value === 'object' ? value as ObjectFields : null
}

function dayKey(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-')
}

function weekDays(now: Date): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - index), 12)))
}

function reportDays(report: unknown): Map<string, ObjectFields> | null {
  const fields = object(report)
  const daily = object(fields?.history)?.daily
  if (!Array.isArray(daily) || fields?.stale === true || object(fields?.hydration)?.complete === false) return null

  const days = new Map<string, ObjectFields>()
  for (const entry of daily) {
    const row = object(entry)
    if (row && typeof row.date === 'string') days.set(row.date, row)
  }
  return days
}

function countsFor(row: ObjectFields | undefined): WidgetCounts {
  if (!row) return { tokens: 0, input: 0, cached: 0 }
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = row
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number' ||
    typeof cacheReadTokens !== 'number' || typeof cacheWriteTokens !== 'number' ||
    ![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
    return { tokens: null, input: null, cached: null }
  }
  const input = inputTokens + cacheReadTokens + cacheWriteTokens
  return { tokens: input + outputTokens, input, cached: cacheReadTokens }
}

export function makeWidgetUsage(reports: readonly unknown[], now: Date): WidgetUsage | null {
  if (reports.length !== WIDGET_AGENTS.length) return null
  const maps = reports.map(reportDays)
  if (maps.some(map => map === null)) return null
  const day = dayKey(now)
  return {
    day,
    updatedAt: now.toISOString(),
    agents: WIDGET_AGENTS.map((id, index) => ({ id, ...countsFor(maps[index]?.get(day)) })),
    days: weekDays(now).map(date => {
      const values = maps.map(map => countsFor(map?.get(date)).tokens)
      return { day: date, tokens: values.some(value => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0) }
    }),
  }
}

export function makeWidgetQuota(rows: readonly QuotaProvider[], now: Date): WidgetQuota {
  return {
    updatedAt: now.toISOString(),
    agents: WIDGET_AGENTS.map(id => {
      const row = rows.find(entry => entry.provider === id && entry.connection === 'connected')
      const windows = row ? [row.primary, ...row.details].filter((window): window is QuotaWindow => Boolean(window)) : []
      const unique = new Map(windows.map(window => [window.label, window]))
      return {
        id,
        windows: [...unique.values()].filter(window => Number.isFinite(window.percent) && window.percent >= 0 && window.percent <= 1)
          // Model groups use the full bucket label to pair their time windows.
          .slice(0, id === 'antigravity' ? 24 : 2)
          .map(window => ({ label: window.label.slice(0, 120), percent: window.percent, resetsAt: window.resetsAt })),
      }
    }),
  }
}

export function startWidgetSnapshots(home: string, readUsage: typeof spawnCli, readQuota: typeof getQuota): () => void {
  const container = path.join(home, 'Library', 'Containers', WIDGET_EXTENSION_ID, 'Data')
  const file = path.join(container, 'Library', 'Application Support', 'CodeBurn Widgets', 'snapshot.json')
  let lastAttempt = 0
  let running = false
  let stopped = false

  async function publish(): Promise<void> {
    if (running || stopped || Date.now() - lastAttempt < SNAPSHOT_INTERVAL_MS) return
    running = true
    try {
      // macOS owns the sandbox container. Until it exists there is no widget
      // consumer, and the main app has no reason to fetch data or create it.
      if (!await stat(container).then(info => info.isDirectory(), () => false)) return
      lastAttempt = Date.now()
      const before = new Date()
      const [usageResult, quotaResult] = await Promise.allSettled([
        Promise.all(WIDGET_AGENTS.map(id => readUsage(
          ['status', '--format', 'menubar-json', '--period', 'week', '--provider', id, '--no-optimize', '--no-timeline'],
          { priority: 'background' },
        ))),
        readQuota({ disabled: OTHER_QUOTA_PROVIDERS }),
      ])
      if (stopped) return
      const now = new Date()
      const old = await readSecureFile(file, MAX_SNAPSHOT_BYTES).then(text => {
        const value = text ? JSON.parse(text) as WidgetSnapshot : null
        return value?.version === 1 ? value : null
      }).catch(() => null)
      const usage = dayKey(before) === dayKey(now) && usageResult.status === 'fulfilled'
        ? makeWidgetUsage(usageResult.value, now) : null
      const quota = quotaResult.status === 'fulfilled' ? makeWidgetQuota(quotaResult.value, now) : null
      await atomicWriteSecureFile(file, JSON.stringify({
        version: 1, usage: usage ?? old?.usage ?? null, quota: quota ?? old?.quota ?? null,
      } satisfies WidgetSnapshot))
    } catch {
      // A widget may disappear, or macOS may withhold container access.
      // Neither should interrupt CodeBurn or invalidate the last good snapshot.
    } finally {
      running = false
    }
  }

  void publish()
  const timer = setInterval(() => { void publish() }, PROBE_INTERVAL_MS)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
