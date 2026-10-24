import nacl from './vendor/nacl.js'
import { wordlist } from './vendor/bip39-english.js'

// Recovery words in the BIP39 layout: 12 words hold 16 bytes and a 4-bit checksum, 24 words 32 bytes and 8 bits.
// The checksum comes from SHA-512 (nacl.hash), so the words are not a Bitcoin wallet's and open nothing else.

const encode = (s: string) => new TextEncoder().encode(s)

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

const bitsOf = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(2).padStart(8, '0')).join('')

export function toWords(entropy: Uint8Array): string[] {
  const checksum = bitsOf(nacl.hash(entropy).slice(0, 1)).slice(0, entropy.length / 4)
  const bits = bitsOf(entropy) + checksum
  const words: string[] = []
  for (let i = 0; i < bits.length; i += 11) words.push(wordlist[parseInt(bits.slice(i, i + 11), 2)]!)
  return words
}

// Resolves to the 16 or 32 bytes the words hold, or undefined when a word is unknown or the checksum fails.
export function fromWords(text: string): Uint8Array | undefined {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean)
  if (words.length !== 12 && words.length !== 24) return undefined
  let bits = ''
  for (const w of words) {
    const i = wordlist.indexOf(w)
    if (i < 0) return undefined
    bits += i.toString(2).padStart(11, '0')
  }
  const checksumBits = words.length === 12 ? 4 : 8
  const entropy = new Uint8Array((bits.length - checksumBits) / 8)
  for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  const checksum = bitsOf(nacl.hash(entropy).slice(0, 1)).slice(0, checksumBits)
  return checksum === bits.slice(bits.length - checksumBits) ? entropy : undefined
}

// 16 bytes seed an identity made with recovery words. An identity made before them has no seed, so its
// 32-byte secret key is what its 24 words hold. Either way the ML-KEM seed follows from the secret key.
export function keysFromEntropy(entropy: Uint8Array): { secretKey: Uint8Array; kemSeed: Uint8Array } {
  const secretKey = entropy.length === 32 ? entropy : nacl.hash(join(entropy, encode('buddy-chat x25519 v1'))).slice(0, 32)
  return { secretKey, kemSeed: nacl.hash(join(secretKey, encode('buddy-chat ml-kem v1'))) }
}

// From the secret key, so every device of the identity, and the words, open the same backup.
export const backupKey = (secretKey: Uint8Array) => nacl.hash(join(secretKey, encode('buddy-chat backup v1'))).slice(0, 32)
