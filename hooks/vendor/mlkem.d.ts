export declare const ml_kem768: {
  keygen(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array }
  encapsulate(publicKey: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array }
  decapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array
}
