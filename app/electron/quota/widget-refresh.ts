import os from 'node:os'
import path from 'node:path'

import { readBigModelApiKey } from '../bigmodel-key'
import { reportWidgetDiagnostic, type WidgetDiagnostic } from '../widget-snapshot'
import { fetchAntigravityQuotaWithCli } from './antigravity'
import { fetchCodexQuota } from './codex'
import { readSecureFile } from './security'
import type { QuotaProvider } from './types'
import { fetchZcodeQuota } from './zcode'

const providers = ['codex', 'zcode', 'antigravity'] as const
type Provider = typeof providers[number]
type Result = { quota: QuotaProvider; retryAfterSeconds?: number }
type Options = {
  poll: Record<Provider, (signal: AbortSignal) => Promise<Result>>
  readBackoff: () => Promise<unknown>
  now: () => number
  timeoutMs: number
  diagnostic?: WidgetDiagnostic
}

export async function pollWidgetAntigravityQuota(
  signal: AbortSignal, deps?: Parameters<typeof fetchAntigravityQuotaWithCli>[0],
): Promise<Result> {
  // This attempt owns the direct probe and any CLI execution. Keep the source
  // tag on Plans rows so the widget's freshness checks reject those rows.
  const { source: _source, ...quota } = await fetchAntigravityQuotaWithCli({ ...deps, signal })
  return { quota }
}

const defaults: Options = {
  poll: {
    // Background Codex auth may renew normally, but does not request keychain access.
    // The provider only shares the credential grant; this quota read is new.
    codex: signal => fetchCodexQuota({ signal }),
    zcode: signal => fetchZcodeQuota({ signal, readBigModelApiKey: process.platform === 'darwin' ? readBigModelApiKey : undefined }),
    antigravity: pollWidgetAntigravityQuota,
  },
  readBackoff: async () => {
    const state = await readSecureFile(path.join(os.homedir(), '.codeburn', 'quota-backoff.json'), 16 * 1024)
    return state ? JSON.parse(state) : null
  },
  now: Date.now,
  timeoutMs: 90_000,
}

export function createWidgetQuotaReader(options: Partial<Options> = {}): (signal: AbortSignal) => Promise<QuotaProvider[]> {
  const { poll, readBackoff, now, timeoutMs, diagnostic } = { ...defaults, ...options }
  // Only admission/backoff survives a round, never credentials or previous quota
  // values. In particular, an uncancellable native decrypt cannot spawn a second
  // pending dialog or have its late result reused in the next round.
  const inFlight = new Set<Provider>()
  const blockedUntil = new Map<Provider, number>()
  return async parent => {
    const attempt = new AbortController()
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([parent, attempt.signal, timeout])
    let onAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([cancelled, (async () => {
        signal.throwIfAborted()
        const persisted = await readBackoff().catch(() => null)
        const blocked = persisted !== null && typeof persisted === 'object'
          ? persisted as Partial<Record<Provider, unknown>> : {}
        signal.throwIfAborted()
        return Promise.all(providers.map(async id => {
          const stored = blocked[id]
          const until = typeof stored === 'string' ? Date.parse(stored) : NaN
          const pending = inFlight.has(id)
          if (pending || (blockedUntil.get(id) ?? 0) > now() || until > now()) {
            reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: pending ? 'in_flight' : 'backoff', provider: id })
            throw new Error('Widget quota provider not ready')
          }
          inFlight.add(id)
          try {
            reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'started', provider: id })
            let result: Result
            try {
              result = await poll[id](signal)
            } catch (error) {
              if (!signal.aborted) reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'failed', provider: id })
              throw error
            }
            const { quota, retryAfterSeconds } = result
            signal.throwIfAborted()
            if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
              blockedUntil.set(id, now() + retryAfterSeconds * 1000)
              reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'backoff', provider: id })
              throw new Error('Widget quota rate limited')
            }
            if (quota.provider !== id || quota.source === 'antigravity-cli' || quota.connection !== 'connected' || quota.rateLimited) {
              const result = quota.provider !== id || quota.source === 'antigravity-cli' ? 'not_fresh'
                : quota.rateLimited ? 'backoff' : quota.connection === 'disconnected' ? 'disconnected' : 'not_fresh'
              reportWidgetDiagnostic(diagnostic, { stage: 'quota', result, provider: id })
              throw new Error('Widget quota not fresh')
            }
            reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'fresh', provider: id })
            return quota
          } finally {
            inFlight.delete(id)
          }
        }))
      })()])
    } finally {
      if (diagnostic && timeout.aborted && signal.reason === timeout.reason) {
        reportWidgetDiagnostic(diagnostic, { stage: 'quota', result: 'deadline' })
      }
      if (onAbort) signal.removeEventListener('abort', onAbort)
      attempt.abort()
    }
  }
}
