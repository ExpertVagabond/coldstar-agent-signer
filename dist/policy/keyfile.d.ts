/** Deliberately identical to the Rust constants. Changing one breaks the other. */
export declare const ARGON2_MEMORY_KIB = 65536;
export declare const ARGON2_TIME_COST = 3;
export declare const ARGON2_PARALLELISM = 4;
/** The on-disk container. Field names match the Rust struct's JSON exactly. */
export interface EncryptedKeyContainer {
    version: number;
    salt: string;
    nonce: string;
    ciphertext: string;
    public_key?: string;
}
export declare function isEncryptedKeyContainer(v: unknown): v is EncryptedKeyContainer;
/** Overwrite a secret. Not a guarantee — a garbage collector may have copied it
 *  already — but it shortens the window, and saying otherwise would be a lie. */
export declare function wipe(...buffers: Array<Uint8Array | undefined>): void;
/**
 * Encrypt a root key. Accepts a 32-byte seed or a 64-byte solana-keygen
 * keypair; only the seed is stored, exactly as the Rust implementation does.
 */
export declare function encryptRootKey(secret: Uint8Array, passphrase: string, publicKeyBase58?: string): EncryptedKeyContainer;
/**
 * Decrypt a root key, returning the 32-byte seed. The caller must wipe it.
 * A wrong passphrase fails the GCM tag, so it is reported as such rather than
 * silently producing garbage.
 */
export declare function decryptRootKey(container: EncryptedKeyContainer, passphrase: string): Uint8Array;
/** Constant-time check that a container holds the key it claims to. */
export declare function containerMatchesPublicKey(container: EncryptedKeyContainer, publicKey: Uint8Array): boolean;
//# sourceMappingURL=keyfile.d.ts.map