import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'

import type { QuotaWindow } from './types'

const MAX_OUTPUT_BYTES = 256 * 1024
const ATTEMPT_TIMEOUT_MS = 12_000
const USAGE_ARGS = [
  '--disable-slash-commands=false', '--settings', '{"disableSlashCommands":false}',
  '-p', '/usage', '--output-format', 'json', '--print-timeout', '10s',
]
const USAGE_COUNTER_SCHEMAS = [
  ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'],
  ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens'],
]

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function name(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resetEpoch(value: unknown): number {
  if (typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return NaN
  const day = value.slice(0, 10)
  const midnight = new Date(`${day}T00:00:00Z`)
  // Date.parse normalizes some impossible dates, such as February 30.
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().startsWith(day) ? Date.parse(value) : NaN
}

export function decodeAntigravityCliUsage(value: unknown): QuotaWindow[] {
  const result = record(value)
  if (!result || result.status !== 'SUCCESS' || result.num_turns !== 0 || result.conversation_id !== '') return []
  const usage = record(result.usage)
  if (!usage || !USAGE_COUNTER_SCHEMAS.some(keys => keys.every(key => usage[key] === 0)) ||
    Object.values(usage).some(counter => counter !== 0)) return []
  const command = record(result.command)
  if (command?.name !== 'usage') return []
  const data = record(command.data)
  if (!Array.isArray(data?.groups)) return []

  const windows: QuotaWindow[] = []
  for (const value of data.groups) {
    const group = record(value)
    const groupName = name(group?.name)
    if (!groupName || !Array.isArray(group?.buckets)) return []
    for (const value of group.buckets) {
      const bucket = record(value)
      if (bucket?.disabled === true) continue
      if (!bucket || (bucket.disabled !== undefined && bucket.disabled !== false)) return []
      const bucketName = name(bucket.name)
      const windowName = name(bucket.window)
      const remaining = bucket.remaining_fraction
      if (!bucketName || !windowName || typeof remaining !== 'number' ||
        !Number.isFinite(remaining) || remaining < 0 || remaining > 1) return []
      const reset = bucket.reset_time
      const epoch = resetEpoch(reset)
      if (reset !== undefined && !Number.isFinite(epoch)) return []
      windows.push({
        label: [groupName, bucketName, windowName].join(' · '),
        percent: 1 - remaining,
        resetsAt: Number.isFinite(epoch) ? new Date(epoch).toISOString() : null,
      })
    }
  }
  return windows
}

export async function trustedAntigravityCli(home: string, uid: number): Promise<string | null> {
  if (!path.isAbsolute(home) || path.normalize(home) !== home || home === path.parse(home).root) return null
  const executable = path.join(home, '.local', 'bin', 'agy')
  // Use the official per-user install location. Check each component with
  // lstat so neither the executable nor a parent can redirect through a symlink.
  for (let directory = path.dirname(executable); ; directory = path.dirname(directory)) {
    const info = await lstat(directory)
    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== uid) || (info.mode & 0o022)) return null
    if (directory === path.dirname(directory)) break
  }
  const info = await lstat(executable)
  return info.isFile() && info.uid === uid && (info.mode & 0o100) && !(info.mode & 0o6022) ? executable : null
}

async function installedExecutable(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const { homedir, uid } = userInfo()
  try {
    return await trustedAntigravityCli(homedir, uid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

type Run = (file: string, args: string[], signal: AbortSignal) => Promise<string>

const runCli: Run = (file, args, signal) => {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: '/',
      env: {
        HOME: userInfo().homedir,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    const stdout: Buffer[] = []
    let bytes = 0
    let failed = false
    const stop = () => {
      if (failed) return
      failed = true
      child.kill('SIGKILL')
      child.stdout.destroy()
      child.stderr.destroy()
    }
    const count = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT_BYTES) stop()
    }
    child.stdout.on('data', (chunk: Buffer) => {
      count(chunk)
      if (!failed) stdout.push(chunk)
    })
    child.stderr.on('data', count)
    child.on('error', () => { failed = true })
    child.once('close', (code, termination) => {
      signal.removeEventListener('abort', stop)
      if (failed || signal.aborted || code !== 0 || termination !== null) reject(new Error('Antigravity CLI unavailable'))
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
  })
}

function supportsUsage(stdout: string): boolean {
  // The flags and response used by this reader were verified together on 1.5.14.
  return /^(?:(?:agy|Antigravity CLI)(?: version)?[ :]+)?v?1\.5\.14$/i.test(stdout.trim())
}

type Options = { executable: () => Promise<string | null>; run: Run; timeoutMs: number }

export function createAntigravityCliReader({
  executable = installedExecutable, run = runCli, timeoutMs = ATTEMPT_TIMEOUT_MS,
}: Partial<Options> = {}): (signal?: AbortSignal) => Promise<QuotaWindow[] | null> {
  let inFlight = false
  return async parent => {
    // An empty array means the supported CLI is absent. A pending or failed
    // read is retryable and says nothing about whether the user is signed in.
    if (inFlight || parent?.aborted) return null
    inFlight = true
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal
    let cancel!: () => void
    const cancelled = new Promise<null>(resolve => {
      cancel = () => resolve(null)
      if (signal.aborted) cancel()
      else signal.addEventListener('abort', cancel, { once: true })
    })
    const attempt = (async () => {
      try {
        const file = await executable()
        signal.throwIfAborted()
        if (!file || !supportsUsage(await run(file, ['--version'], signal))) return []
        signal.throwIfAborted()
        const output = await run(file, [...USAGE_ARGS], signal)
        signal.throwIfAborted()
        if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return null
        const windows = decodeAntigravityCliUsage(JSON.parse(output))
        return windows.length > 0 ? windows : null
      } catch {
        return null
      } finally {
        // Keep admission closed until a cancelled process has actually exited.
        inFlight = false
      }
    })()
    try {
      const windows = await Promise.race([attempt, cancelled])
      return signal.aborted ? null : windows
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
  }
}
