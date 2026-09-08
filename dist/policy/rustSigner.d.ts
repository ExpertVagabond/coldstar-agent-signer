/**
 * Locate the signer, or return null. Never throws: absence is the normal case,
 * not an error, and the caller falls back to the in-process path.
 */
export declare function findRustSigner(): string | null;
export interface RustSignerCapabilities {
    /** True when the binary reports it can lock memory on this machine. */
    memoryLocking: boolean;
    raw: unknown;
}
/** Ask the binary what it can do here. Memory locking can fail at runtime. */
export declare function rustSignerCapabilities(bin: string): RustSignerCapabilities;
export interface RustSignature {
    /** Base58 detached Ed25519 signature over the bytes given. */
    signature: string;
    /** Base58 public key the signer used, for checking it held the key you meant. */
    publicKey: string;
}
/**
 * Sign arbitrary bytes with a key that never leaves the Rust process.
 *
 * The command is named `sign` and its field is `transaction`, but the signer
 * Ed25519-signs whatever bytes it is given and returns a detached signature
 * (`sign_with_secure_key` in `crypto.rs`), so a canonical policy payload works.
 * The `signed_transaction` field it also returns is meaningless here; ignore it.
 */
export declare function signWithRustSigner(bin: string, containerJson: string, passphrase: string, payload: Uint8Array): RustSignature;
//# sourceMappingURL=rustSigner.d.ts.map