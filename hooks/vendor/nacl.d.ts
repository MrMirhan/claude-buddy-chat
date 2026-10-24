type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }

declare const nacl: {
  box: {
    (msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array
    before(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array
    after(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array
    open: {
      (box: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null
      after(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null
    }
    keyPair: {
      (): KeyPair
      fromSecretKey(secretKey: Uint8Array): KeyPair
    }
    nonceLength: number
  }
  secretbox: {
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null
  }
  randomBytes(n: number): Uint8Array
  hash(msg: Uint8Array): Uint8Array
}

export default nacl
