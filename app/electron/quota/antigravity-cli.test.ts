import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { userInfo } from 'node:os'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAntigravityCliReader, decodeAntigravityCliUsage } from './antigravity-cli'
import { fetchAntigravityQuotaWithCli } from './antigravity'
import usage from './fixtures/antigravity-cli-usage.json'

vi.mock('node:child_process', { spy: true })

const group = usage.command.data.groups[0]!
const exhausted = group.buckets[0]!
const withBuckets = (buckets: unknown[]) => ({
  ...usage,
  command: { ...usage.command, data: { ...usage.command.data, groups: [{ ...group, buckets }] } },
})
const alternateCounters = {
  input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0,
}
const stdout = JSON.stringify(usage)
const agy = '/fake-home/.local/bin/agy'
const hardenedArgs = [
  '--disable-slash-commands=false', '--settings', '{"disableSlashCommands":false}',
  '-p', '/usage', '--output-format', 'json', '--print-timeout', '10s',
]
const direct = {
  platform: 'darwin',
  execFile: async () => ({ stdout: '' }),
  request: vi.fn(async () => { throw new Error('unexpected RPC') }),
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('official Antigravity CLI output', () => {
  it.each([
    ['original', usage.usage],
    ['alternate', alternateCounters],
    ['alternate with an extra zero counter', { ...alternateCounters, extra_tokens: 0 }],
  ])('decodes the %s envelope with four enabled windows', (_shape, counters) => {
    expect(decodeAntigravityCliUsage({ ...usage, usage: counters })).toEqual([
      { label: 'Fixture Group A · Fixture Bucket A1 · weekly', percent: 1, resetsAt: '2026-11-24T12:00:00.000Z' },
      { label: 'Fixture Group A · Fixture Bucket A2 · daily', percent: 0, resetsAt: '2026-11-23T00:00:00.000Z' },
      { label: 'Fixture Group B · Fixture Bucket B2 · weekly', percent: 0.25, resetsAt: '2026-11-24T13:00:00.000Z' },
      { label: 'Fixture Group C · Fixture Bucket C1 · weekly', percent: 0.5, resetsAt: '2026-11-24T14:00:00.000Z' },
    ])
  })

  it.each([
    ['nonzero extra counter', { ...alternateCounters, extra_tokens: 1 }],
    ['missing counter', { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 }],
    ['mixed incomplete schemas', {
      input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, reasoning_output_tokens: 0,
    }],
    ['string counter', { ...alternateCounters, total_tokens: '0' }],
    ['nonnumeric extra counter', { ...alternateCounters, extra_tokens: false }],
  ])('rejects the alternate counter envelope with %s', (_reason, counters) => {
    expect(decodeAntigravityCliUsage({ ...usage, usage: counters })).toEqual([])
  })

  it('rejects wrong commands, failed envelopes and any evidence of a model turn', () => {
    for (const invalid of [
      { ...usage, command: { ...usage.command, name: '/usage' } },
      { ...usage, status: 'success' },
      { ...usage, status: 'ERROR' },
      { ...usage, num_turns: 1 },
      { ...usage, num_turns: '0' },
      { ...usage, num_turns: undefined },
      { ...usage, conversation_id: 'fixture-conversation' },
      { ...usage, conversation_id: undefined },
      { ...usage, usage: {} },
      { ...usage, usage: { ...usage.usage, input_tokens: undefined } },
      { ...usage, usage: { ...usage.usage, output_tokens: '0' } },
      { ...usage, usage: { ...usage.usage, reasoning_output_tokens: 1 } },
      { ...usage, usage: { ...usage.usage, total_tokens: 1 } },
      { status: 'SUCCESS', result: usage.command.data },
    ]) expect(decodeAntigravityCliUsage(invalid)).toEqual([])
  })

  it('rejects the entire result if any active bucket or group is malformed', () => {
    for (const bad of [
      null, {}, { ...exhausted, disabled: 'false' }, { ...exhausted, remaining_fraction: undefined },
      { ...exhausted, remaining_fraction: '0' }, { ...exhausted, remaining_fraction: -1 },
      { ...exhausted, remaining_fraction: 2 }, { ...exhausted, remaining_fraction: Infinity },
      { ...exhausted, reset_time: null }, { ...exhausted, reset_time: 'invalid' },
      { ...exhausted, reset_time: '2026-02-30T12:00:00Z' },
      { ...exhausted, reset_time: '2026-11-24T24:00:00Z' },
    ]) expect(decodeAntigravityCliUsage(withBuckets([exhausted, bad]))).toEqual([])
    const malformedGroup = structuredClone(usage)
    malformedGroup.command.data.groups.push({ ...group, name: '' })
    expect(decodeAntigravityCliUsage(malformedGroup)).toEqual([])
  })

  it('skips explicitly disabled rows and allows an omitted reset on an active zero', () => {
    const disabled = { disabled: true }
    expect(decodeAntigravityCliUsage(withBuckets([disabled]))).toEqual([])
    expect(decodeAntigravityCliUsage(withBuckets([disabled, { ...exhausted, reset_time: undefined }]))).toEqual([
      { label: 'Fixture Group A · Fixture Bucket A1 · weekly', percent: 1, resetsAt: null },
    ])
  })
})

describe('desktop Antigravity fallback', () => {
  it('shows a retryable status while a widget owns the CLI and recovers on the next read', async () => {
    let enter!: () => void
    let finish!: (text: string) => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const cli = createAntigravityCliReader({
      executable: async () => agy,
      run: async (_file, args) => {
        if (args[0] === '--version') return '1.5.14'
        enter()
        return new Promise(resolve => { finish = resolve })
      },
    })
    const widget = cli()
    await entered
    const busy = await fetchAntigravityQuotaWithCli({ ...direct, cli })
    finish(stdout)
    await widget
    expect(busy.connection).toBe('transientFailure')
    const previousFinish = finish
    const retry = fetchAntigravityQuotaWithCli({ ...direct, cli })
    await vi.waitFor(() => expect(finish).not.toBe(previousFinish))
    finish(stdout)
    expect((await retry).connection).toBe('connected')
  })

  it('prefers usable CSRF-protected legacy windows and recovers on discovery failure', async () => {
    const request = vi.fn(async () => ({
      status: 200,
      text: JSON.stringify({ groups: [{ displayName: 'Direct', buckets: [{ bucketId: 'week', remainingFraction: 0 }] }] }),
    }))
    const cli = vi.fn(async () => decodeAntigravityCliUsage(usage))
    const quota = await fetchAntigravityQuotaWithCli({
      ...direct, cli, request,
      execFile: async file => ({
        stdout: file === 'ps' ? '1234 /Applications/Antigravity.app/language_server --app_data_dir antigravity --csrf_token fixture --extension_server_port 54321' : '',
      }),
    })
    expect(quota.primary?.label).toBe('Direct · week')
    expect(request).toHaveBeenCalledWith(54321, true, expect.any(String), '{}', 'fixture')
    expect(cli).not.toHaveBeenCalled()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recovered = await fetchAntigravityQuotaWithCli({
      ...direct, cli, execFile: async () => { throw new Error('fixture discovery failure') },
    })
    expect(recovered).toMatchObject({ connection: 'connected', source: 'antigravity-cli', primary: { percent: 1 } })
    expect(direct.request).not.toHaveBeenCalled()
  })

  it('falls back when the protected server provides only disabled and out-of-range windows', async () => {
    const cli = vi.fn(async () => decodeAntigravityCliUsage(usage))
    const result = await fetchAntigravityQuotaWithCli({
      ...direct, cli,
      execFile: async file => ({
        stdout: file === 'ps' ? '1234 /Applications/Antigravity.app/language_server --app_data_dir antigravity --csrf_token fixture --extension_server_port 54321' : '',
      }),
      request: async () => ({ status: 200, text: JSON.stringify({ groups: [{ buckets: [
        { bucketId: 'disabled', disabled: true, remainingFraction: 0 },
        { bucketId: 'invalid', remainingFraction: 2 },
      ] }] }) }),
    })
    expect(cli).toHaveBeenCalledOnce()
    expect(result.source).toBe('antigravity-cli')
  })

  it('spawns without shell, stdin or inherited credentials and kills excess output', async () => {
    const kill = vi.fn()
    const mockSpawn = vi.mocked(spawn).mockImplementation((_file, args) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill })
      queueMicrotask(() => {
        if (Array.isArray(args) && args[0] === '--version') child.stdout.write('agy version 1.5.14')
        else {
          child.stdout.write(stdout)
          child.stderr.write(Buffer.alloc(256 * 1024))
        }
        child.emit('close', 0, null)
      })
      return child as unknown as ReturnType<typeof spawn>
    })
    const cli = createAntigravityCliReader({ executable: async () => agy })
    expect(await cli()).toBeNull()
    expect(mockSpawn.mock.calls.map(([file, args]) => [file, args])).toEqual([
      [agy, ['--version']],
      [agy, hardenedArgs],
    ])
    for (const [, , options] of mockSpawn.mock.calls) {
      expect(options).toMatchObject({ shell: false, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] })
      expect(options?.env).toEqual({
        HOME: userInfo().homedir,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      })
    }
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it('uses only the fixed read-only arguments after the version gate', async () => {
    const run = vi.fn(async (_path: string, args: string[]) => args[0] === '--version' ? '1.5.14\n' : stdout)
    const cli = createAntigravityCliReader({ executable: async () => agy, run })
    expect((await fetchAntigravityQuotaWithCli({ ...direct, cli })).primary?.percent).toBe(1)
    expect(run.mock.calls.map(([file, args]) => [file, args])).toEqual([
      [agy, ['--version']],
      [agy, hardenedArgs],
    ])
    for (const version of ['1.1.11', '1.5.12', '1.5.13', '1.5.15', '2.0.0', '1.5.14-rc.1']) {
      run.mockClear().mockResolvedValue(version)
      expect((await fetchAntigravityQuotaWithCli({ ...direct, cli })).connection).toBe('disconnected')
      expect(run.mock.calls.map(([, args]) => args)).toEqual([['--version']])
    }
  })

  it('times out, rejects overlapping calls and discards a late answer', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const run = vi.fn(async (_file: string, args: string[]) => args[0] === '--version' ? '1.5.14'
      : new Promise<string>(resolve => { finish = resolve }))
    const cli = createAntigravityCliReader({ executable: async () => agy, run, timeoutMs: 25 })
    const first = cli()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(25)
    expect(await first).toBeNull()
    expect(await cli()).toBeNull()
    expect(run).toHaveBeenCalledTimes(2)
    finish(stdout)
    await vi.advanceTimersByTimeAsync(0)
    run.mockResolvedValueOnce('1.5.14').mockResolvedValueOnce(stdout)
    expect(await cli()).toHaveLength(4)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('cancels promptly on disconnect and suppresses rejected or oversized output', async () => {
    const parent = new AbortController()
    const run = vi.fn(async (_file: string, args: string[], signal: AbortSignal) => {
      if (args[0] === '--version') return '1.5.14'
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Error('private output')), { once: true })
        parent.abort()
      })
    })
    const cli = createAntigravityCliReader({ executable: async () => agy, run })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await fetchAntigravityQuotaWithCli({ ...direct, cli, signal: parent.signal })).connection).toBe('transientFailure')
    expect(warn).not.toHaveBeenCalled()
    const oversized = createAntigravityCliReader({ executable: async () => agy,
      run: async (_file, args) => args[0] === '--version' ? '1.5.14' : stdout + ' '.repeat(1024 * 1024) })
    expect((await fetchAntigravityQuotaWithCli({ ...direct, cli: oversized })).connection).toBe('transientFailure')
  })

  it('kills a child when cancellation lands before the spawn listener is registered', async () => {
    const parent = new AbortController()
    const kill = vi.fn()
    const mockSpawn = vi.mocked(spawn).mockImplementation((_file, args) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill })
      if (Array.isArray(args) && args[0] === '--version') {
        queueMicrotask(() => {
          child.stdout.write('1.5.14')
          child.emit('close', 0, null)
        })
      } else {
        parent.abort()
        queueMicrotask(() => child.emit('close', 0, null))
      }
      return child as unknown as ReturnType<typeof spawn>
    })
    const cli = createAntigravityCliReader({ executable: async () => agy })
    expect(await cli(parent.signal)).toBeNull()
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })
})
