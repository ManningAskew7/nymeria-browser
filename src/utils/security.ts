import { logger } from './logger'

const SALT = 'nymeria-browser-salt-v1'

async function getEncryptionKey(): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(chrome.runtime.id + SALT),
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(SALT),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptData(plaintext: string): Promise<string> {
  if (!plaintext) return ''
  const key = await getEncryptionKey()
  const encoder = new TextEncoder()
  const data = encoder.encode(plaintext)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  const combined = new Uint8Array(iv.length + encrypted.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(encrypted), iv.length)
  return btoa(String.fromCharCode(...combined))
}

export async function decryptData(encryptedBase64: string): Promise<string> {
  if (!encryptedBase64) return ''
  try {
    const key = await getEncryptionKey()
    const combined = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0))
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(decrypted)
  } catch (error) {
    logger.error('Decryption failed:', error)
    return ''
  }
}
