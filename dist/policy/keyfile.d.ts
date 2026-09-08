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
/**
 * Coldstar's passphrase rules, from `validate_password_strength` in
 * `src/security_validation.py`. Matched deliberately rather than improved on:
 * two tools guarding one key should not disagree about what protects it, and a
 * key file moves between them.
 */
export declare const MIN_PASSPHRASE_LENGTH = 12;
/** Returns null when acceptable, or the reason it is not. */
export declare function passphraseWeakness(passphrase: string): string | null;
/**
 * Coerce a container into the shape this module reads.
 *
 * Coldstar's `_normalize_container_format` exists because containers are found
 * in the wild with `salt`, `nonce`, `ciphertext` and `public_key` as JSON arrays
 * of bytes rather than encoded strings. Rejecting those would mean telling a
 * Coldstar user their own key file is not a key file.
 */
export declare function normalizeKeyContainer(raw: unknown): unknown;
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