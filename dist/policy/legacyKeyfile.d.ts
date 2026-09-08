export interface LegacyKeyContainer {
    version?: number;
    algo?: string;
    opslimit?: number;
    memlimit?: number;
    salt: string;
    nonce: string;
    ciphertext: string;
}
/**
 * A libsodium-era container, as opposed to the current one.
 *
 * The discriminator is `algo`, exactly as Coldstar's own loader uses it. A
 * container with no `algo` at all predates the Argon2id upgrade and is argon2i,
 * so it is only claimed here when the field sizes also match libsodium's.
 */
export declare function isLegacyKeyContainer(v: unknown): v is LegacyKeyContainer;
/**
 * Decrypt a legacy container, returning the 32-byte Ed25519 seed so callers can
 * treat it exactly like a current one. The caller must wipe it.
 */
export declare function decryptLegacyRootKey(container: LegacyKeyContainer, passphrase: string): Uint8Array;
//# sourceMappingURL=legacyKeyfile.d.ts.map