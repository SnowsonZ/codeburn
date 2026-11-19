import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readBigModelApiKey, setBigModelApiKey } from './bigmodel-key'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  decryptStringAsync: vi.fn(),
  encryptStringAsync: vi.fn(),
  isAsyncEncryptionAvailable: vi.fn(),
  fetchZcodeQuota: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: mocks.getPath }, safeStorage: mocks }))
vi.mock('./quota/zcode', () => ({ fetchZcodeQuota: mocks.fetchZcodeQuota }))

describe('BigModel credential storage', () => {
  const apiKey = 'synthetic-id.synthetic-secret'
  const ciphertext = Buffer.from('mock-encrypted-bytes')
  let directory: string

  beforeEach(async () => {
    vi.resetAllMocks()
    directory = await mkdtemp(path.join(os.tmpdir(), 'codeburn-bigmodel-key-'))
    mocks.getPath.mockReturnValue(directory)
    mocks.fetchZcodeQuota.mockResolvedValue({ quota: { connection: 'connected' } })
    mocks.isAsyncEncryptionAvailable.mockResolvedValue(true)
    mocks.encryptStringAsync.mockResolvedValue(ciphertext)
    mocks.decryptStringAsync.mockResolvedValue({ result: apiKey })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('stores only ciphertext after verification and removes it on request', async () => {
    await expect(setBigModelApiKey(apiKey)).resolves.toBe('saved')
    const file = path.join(directory, 'bigmodel-coding-plan.key')
    expect(await readFile(file, 'utf8')).toBe(ciphertext.toString('base64'))
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o077).toBe(0)
    await expect(readBigModelApiKey()).resolves.toBe(apiKey)
    expect(mocks.decryptStringAsync).toHaveBeenCalledWith(ciphertext)
    await expect(setBigModelApiKey(null)).resolves.toBe('removed')
    await expect(readBigModelApiKey()).resolves.toBeNull()
  })

  it('preserves a working saved key when the replacement is rejected', async () => {
    await expect(setBigModelApiKey(apiKey)).resolves.toBe('saved')
    mocks.fetchZcodeQuota.mockResolvedValue({ quota: { connection: 'terminalFailure' } })
    await expect(setBigModelApiKey('different-id.invalid-secret')).resolves.toBe('invalid-key')
    expect(mocks.encryptStringAsync).toHaveBeenCalledTimes(1)
    await expect(readBigModelApiKey()).resolves.toBe(apiKey)
  })

  it('does not persist key material if system encryption is unavailable', async () => {
    mocks.isAsyncEncryptionAvailable.mockResolvedValue(false)
    await expect(setBigModelApiKey(apiKey)).resolves.toBe('storage-error')
    expect(mocks.encryptStringAsync).not.toHaveBeenCalled()
    await expect(readBigModelApiKey()).resolves.toBeNull()
  })
})
