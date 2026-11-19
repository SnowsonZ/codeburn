import { rm } from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteSecureFile, readSecureFile } from './quota/security'
import { fetchZcodeQuota } from './quota/zcode'

export type BigModelKeyResult = 'saved' | 'removed' | 'invalid-key' | 'unavailable' | 'storage-error'

const KEY_FILE = 'bigmodel-coding-plan.key'

export async function readBigModelApiKey(): Promise<string | null> {
  const { app, safeStorage } = await import('electron')
  const encrypted = await readSecureFile(path.join(app.getPath('userData'), KEY_FILE), 4096)
  if (!encrypted) return null
  return (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result
}

/** Validate against the quota API before replacing a saved key. Only the
 * main process receives or reads the secret, and the IPC reply is an enum. */
export async function setBigModelApiKey(value: unknown): Promise<BigModelKeyResult> {
  const { app, safeStorage } = await import('electron')
  const file = path.join(app.getPath('userData'), KEY_FILE)
  try {
    if (value === null) {
      await rm(file, { force: true })
      return 'removed'
    }
    const key = typeof value === 'string' ? value.trim() : ''
    if (key.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return 'invalid-key'
    const { quota } = await fetchZcodeQuota({ readBigModelApiKey: async () => key })
    if (quota.connection === 'terminalFailure') return 'invalid-key'
    if (quota.connection !== 'connected') return 'unavailable'
    if (!await safeStorage.isAsyncEncryptionAvailable()) return 'storage-error'
    const encrypted = await safeStorage.encryptStringAsync(key)
    await atomicWriteSecureFile(file, encrypted.toString('base64'))
    return 'saved'
  } catch {
    return 'storage-error'
  }
}
