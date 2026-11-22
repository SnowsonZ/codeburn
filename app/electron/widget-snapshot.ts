import { stat } from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteSecureFile, readSecureFile } from './quota/security'
import type { QuotaProvider, QuotaWindow } from './quota/types'

export const WIDGET_EXTENSION_ID = 'local.codeburn.bigmodel.widgets'
export const WIDGET_AGENTS = ['codex', 'zcode', 'antigravity'] as const
const PROBE_INTERVAL_MS = 30_000
const SNAPSHOT_INTERVAL_MS = 5 * 60_000
const ROUND_TIMEOUT_MS = 15 * 60_000
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
  agents: Array<{ id: Agent; windows: QuotaWindow[]; stale?: true }>
}
type WidgetSnapshot = { version: 1; updatedAt: string; usage: WidgetUsage; quota: WidgetQuota }
type UsageReader = (args: string[], options: { priority: 'background'; signal: AbortSignal }) => Promise<unknown>
type QuotaReader = (signal: AbortSignal) => Promise<QuotaProvider[]>
type DiagnosticReason =
  | { stage: 'startup'; result: 'started' | 'unsupported' | 'extension_missing' }
  | { stage: 'container'; result: 'ready' | 'unavailable' }
  | { stage: 'usage'; result: 'failed' | 'incomplete'; provider: Agent }
  | { stage: 'round'; result: 'deadline' | 'payload_too_large' }
  | { stage: 'fence'; result: 'stale' }
  | { stage: 'quota'; result: 'deadline' | 'invalid_providers' }
  | { stage: 'quota'; result: 'started' | 'backoff' | 'in_flight' | 'fresh' | 'disconnected' | 'not_fresh' |
        'failed' | 'no_usable_windows' | 'invalid_windows' | 'validation_collision'; provider: Agent }
  | { stage: 'write'; result: 'success' | 'failed' }
const DIAGNOSTIC_ERRNOS = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOSPC', 'EROFS', 'EIO'] as const
type DiagnosticErrno = typeof DIAGNOSTIC_ERRNOS[number]
export type WidgetDiagnostic = (reason: DiagnosticReason & { errno?: DiagnosticErrno }) => void | Promise<void>

export function reportWidgetDiagnostic(sink: WidgetDiagnostic | undefined, reason: DiagnosticReason, error?: unknown): void {
  if (!sink) return
  let errno: DiagnosticErrno | undefined
  try {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    errno = DIAGNOSTIC_ERRNOS.find(value => value === code)
  } catch { /* A hostile error accessor supplies no errno. */ }
  try {
    const completion = sink(errno ? { ...reason, errno } : reason)
    if (completion) void completion.catch(() => {})
  } catch { /* Diagnostics must never fail a widget round. */ }
}

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
    if (!row || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date ||
      days.has(row.date)) return null
    days.set(row.date, row)
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
  const tokens = input + outputTokens
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(tokens)) {
    return { tokens: null, input: null, cached: null }
  }
  return { tokens, input, cached: cacheReadTokens }
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
      const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      return { day: date, tokens: values.some(value => value === null) || !Number.isSafeInteger(total) ? null : total }
    }),
  }
}

export function makeWidgetQuota(rows: readonly QuotaProvider[], now: Date, previous?: WidgetQuota | null): WidgetQuota {
  return {
    updatedAt: now.toISOString(),
    agents: WIDGET_AGENTS.map(id => {
      const row = rows.find(entry => entry.provider === id)
      const retrying = row?.connection === 'transientFailure' || row?.connection === 'stale'
      const reported = row && (row.connection === 'connected' || retrying)
        ? [row.primary, ...row.details].filter((window): window is QuotaWindow => Boolean(window))
        : []
      const last = Array.isArray(previous?.agents) ? previous.agents.find(agent => agent?.id === id)?.windows : undefined
      // After an app restart, the provider service may have no retained copy.
      // Reuse the widget's last snapshot only for a temporary failure.
      const source = retrying && reported.length === 0 && Array.isArray(last) ? last : reported
      const valid = source.filter(window => window && typeof window.label === 'string'
        && Number.isFinite(window.percent) && window.percent >= 0 && window.percent <= 1)
      const unique = new Map(valid.map(window => [window.label, window]))
      const windows = [...unique.values()]
        .slice(0, id === 'antigravity' ? 24 : 2)
        .map(window => ({
          label: window.label.slice(0, 120),
          percent: window.percent,
          resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
        }))
      return retrying && windows.length > 0 ? { id, windows, stale: true } : { id, windows }
    }),
  }
}

function completeQuota(rows: readonly QuotaProvider[], now: Date, diagnostic?: WidgetDiagnostic): WidgetQuota | null {
  if (rows.length !== WIDGET_AGENTS.length) {
    reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'invalid_providers' })
    return null
  }
  if (WIDGET_AGENTS.some(id => {
    const matches = rows.filter(row => row?.provider === id)
    if (matches.length !== 1) {
      reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'invalid_providers' })
      return true
    }
    const row = matches[0]!
    if (row.source === 'antigravity-cli' || row.connection !== 'connected' || row.rateLimited) {
      const result = row.source === 'antigravity-cli' ? 'not_fresh' : row.rateLimited ? 'backoff' : row.connection === 'disconnected' ? 'disconnected' : 'not_fresh'
      reportWidgetDiagnostic(diagnostic, { stage: 'quota', result, provider: id })
      return true
    }
    if (!Array.isArray(row.details)) {
      reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'invalid_windows', provider: id })
      return true
    }
    const windows = row.primary === null ? row.details : [row.primary, ...row.details]
    if (windows.length === 0) {
      reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'no_usable_windows', provider: id })
      return true
    }
    const byWireLabel = new Map<string, QuotaWindow>()
    return windows.some(window => {
      if (!window || typeof window.label !== 'string' || !window.label.trim() ||
        !Number.isFinite(window.percent) || window.percent < 0 || window.percent > 1 ||
        (window.resetsAt !== null && (typeof window.resetsAt !== 'string' || !Number.isFinite(Date.parse(window.resetsAt))))) {
        reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'invalid_windows', provider: id })
        return true
      }
      const wireLabel = window.label.slice(0, 120)
      const previous = byWireLabel.get(wireLabel)
      byWireLabel.set(wireLabel, window)
      // Providers commonly repeat the same window in primary and details.
      // Accept that, but never commit two distinct windows that consumers will
      // see under one truncated label (or inconsistent data for one label).
      if (!wireLabel.trim()) {
        reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'invalid_windows', provider: id })
        return true
      }
      const collision = Boolean(previous && (previous.label !== window.label ||
        previous.percent !== window.percent || previous.resetsAt !== window.resetsAt))
      if (collision) reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'validation_collision', provider: id })
      return collision
    })
  })) return null
  return makeWidgetQuota(rows, now)
}

function recordedTime(value: unknown): number {
  const row = object(value)
  if (row?.version !== 1) return 0
  return Math.max(0, ...[row.updatedAt, object(row.usage)?.updatedAt, object(row.quota)?.updatedAt]
    .map(value => typeof value === 'string' ? Date.parse(value) : NaN).filter(Number.isFinite))
}

export function startWidgetSnapshots(home: string, readUsage: UsageReader, readQuota: QuotaReader,
  options: { timeoutMs?: number; cadenceMs?: number; now?: () => Date; elapsed?: () => number; timeZone?: () => string; diagnostic?: WidgetDiagnostic } = {}): () => void {
  const container = path.join(home, 'Library', 'Containers', WIDGET_EXTENSION_ID, 'Data')
  const file = path.join(container, 'Library', 'Application Support', 'CodeBurn Widgets', 'snapshot.json')
  const timeoutMs = options.timeoutMs ?? ROUND_TIMEOUT_MS
  const cadenceMs = options.cadenceMs ?? SNAPSHOT_INTERVAL_MS
  const now = options.now ?? (() => new Date())
  const elapsed = options.elapsed ?? (() => performance.now())
  const timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const diagnostic = options.diagnostic
  let lastAttempt: number | null = null
  let active: AbortController | null = null
  let stopped = false

  async function publish(): Promise<void> {
    if (active || stopped || (lastAttempt !== null && elapsed() - lastAttempt < cadenceMs)) return
    const controller = new AbortController()
    const signal = controller.signal
    active = controller
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    let timedOut = false
    try {
      const deadline = elapsed() + timeoutMs
      const cancel = new Promise<never>((_, reject) => {
        abortListener = () => reject(signal.reason)
        signal.addEventListener('abort', abortListener, { once: true })
        deadlineTimer = setTimeout(() => {
          timedOut = true
          controller.abort(new Error('Widget snapshot timed out'))
        }, timeoutMs)
        deadlineTimer.unref()
      })
      const isDirectory = await Promise.race([stat(container).then(info => info.isDirectory(), error => {
        if (!signal.aborted) reportWidgetDiagnostic(diagnostic, { stage: 'container', result: 'unavailable' }, error)
        return null
      }), cancel])
      if (stopped || isDirectory === null) return
      if (!isDirectory) {
        reportWidgetDiagnostic(diagnostic, { stage: 'container', result: 'unavailable' })
        return
      }
      reportWidgetDiagnostic(diagnostic, { stage: 'container', result: 'ready' })
      lastAttempt = elapsed()
      const startedAt = now()
      const day = dayKey(startedAt)
      const zone = timeZone()
      // Keep every read local to this attempt. A failed/expired attempt can never
      // feed a newer attempt. Validate usage per provider to fail early on a bad report.
      const [reports, quotaRows, previousTime] = await Promise.race([
        Promise.all([
          (async () => {
            const reports: unknown[] = []
            // Each CLI process is round-owned and cancellable. Read serially as
            // with the former resident server so our own scans do not contend
            // for the session-cache refresh lock and trigger stale fallback.
            for (const id of WIDGET_AGENTS) {
              signal.throwIfAborted()
              let report: unknown
              try {
                report = await readUsage(
                  ['status', '--format', 'menubar-json', '--period', 'week', '--provider', id, '--no-optimize', '--no-timeline'],
                  { priority: 'background', signal },
                )
              } catch (error) {
                if (!signal.aborted) reportWidgetDiagnostic(diagnostic, { stage: 'usage', result: 'failed', provider: id })
                throw error
              }
              const days = reportDays(report)
              if (!days || weekDays(startedAt).some(date => countsFor(days.get(date)).tokens === null)) {
                if (!signal.aborted) reportWidgetDiagnostic(diagnostic, { stage: 'usage', result: 'incomplete', provider: id })
                throw new Error('Incomplete widget usage')
              }
              reports.push(report)
            }
            return reports
          })(),
          Promise.resolve().then(() => readQuota(signal)).then(rows => {
            if (!completeQuota(rows, startedAt, signal.aborted ? undefined : diagnostic)) throw new Error('Incomplete widget quota')
            return rows
          }),
          readSecureFile(file, MAX_SNAPSHOT_BYTES).then(text => text ? recordedTime(JSON.parse(text)) : 0)
            .catch(() => 0),
        ] as const),
        cancel,
      ])
      const commitAt = now()
      let fenced = false
      const assertCurrent = () => {
        const current = now()
        if (active !== controller || stopped || signal.aborted || (timedOut = elapsed() >= deadline) ||
          timeZone() !== zone || dayKey(current) !== day || current.getTime() < commitAt.getTime()) {
          fenced = true
          if (!timedOut) reportWidgetDiagnostic(diagnostic, { stage: 'fence', result: 'stale' })
          throw new Error('Obsolete widget snapshot')
        }
      }
      assertCurrent()
      if (commitAt.getTime() < startedAt.getTime() || commitAt.getTime() <= previousTime) {
        reportWidgetDiagnostic(diagnostic, { stage: 'fence', result: 'stale' })
        return
      }
      const usage = makeWidgetUsage(reports, commitAt)
      const quota = completeQuota(quotaRows, commitAt, diagnostic)
      if (!usage || !quota || usage.days.some(value => value.tokens === null)) return
      const payload = JSON.stringify({ version: 1, updatedAt: commitAt.toISOString(), usage, quota } satisfies WidgetSnapshot)
      if (Buffer.byteLength(payload) > MAX_SNAPSHOT_BYTES) {
        reportWidgetDiagnostic(diagnostic, { stage: 'round', result: 'payload_too_large' })
        return
      }
      try {
        await atomicWriteSecureFile(file, payload, assertCurrent)
        reportWidgetDiagnostic(diagnostic, { stage: 'write', result: 'success' })
      } catch (error) {
        if (!fenced) reportWidgetDiagnostic(diagnostic, { stage: 'write', result: 'failed' }, error)
        throw error
      }
    } catch {
      if (timedOut) reportWidgetDiagnostic(diagnostic, { stage: 'round', result: 'deadline' })
      // A rejected, incomplete or overdue attempt never replaces a prior snapshot.
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      if (abortListener) signal.removeEventListener('abort', abortListener)
      controller.abort()
      active = null
    }
  }

  reportWidgetDiagnostic(diagnostic, { stage: 'startup', result: 'started' })
  void publish()
  const timer = setInterval(() => { void publish() }, Math.min(PROBE_INTERVAL_MS, cadenceMs))
  timer.unref()
  return () => { stopped = true; clearInterval(timer); active?.abort() }
}
