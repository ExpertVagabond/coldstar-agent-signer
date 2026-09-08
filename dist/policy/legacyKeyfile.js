// Reading the OLDER Coldstar key containers.
//
// Coldstar's Python wallet (`src/secure_memory.py`) encrypted keys with libsodium
// long before the Rust signer existed, and `src/wallet.py` still opens those files,
// converts them to the current format and rewrites them. So any wallet that has
// been opened by a recent Coldstar build is already the format `keyfile.ts` reads.
//
// A wallet that has NOT been opened since is still in one of these shapes, and
// refusing it would mean telling a Coldstar user their own key file is not a key
// file. Hence this module. It reads; it never writes. Anything encrypted here goes
// back out through `encryptRootKey`, in the current format.
//
// Three things differ from the current container, and each one alone is enough to
// make the files mutually unreadable:
//
//   - libsodium fixes Argon2 at ONE lane. Same memory and time cost, different key.
//   - The cipher is XSalsa20-Poly1305 (NaCl secretbox), not AES-256-GCM, with a
//     24-byte nonce and the 16-byte tag placed FIRST.
//   - The payload is the whole 64-byte keypair, not the 32-byte seed, and the
//     fields are hex rather than base64. The salt is 16 bytes, not 32.
//
// Verified against containers produced by Coldstar's own SecureWalletHandler, not
// by a reimplementation of it. See legacyKeyfile.test.ts.
import { argon2i, argon2id } from "@noble/hashes/argon2";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { wipe } from "./keyfile.js";
/** libsodium's `crypto_pwhash` always uses a single lane, whatever the cost. */
const LIBSODIUM_LANES = 1;
const LIBSODIUM_SALT_SIZE = 16;
const SECRETBOX_NONCE_SIZE = 24;
const SECRETBOX_TAG_SIZE = 16;
const KEY_SIZE = 32;
const SEED_SIZE = 32;
const KEYPAIR_SIZE = 64;
/** Defaults from Coldstar's `secure_memory.py` when a container omits them. */
const ARGON2ID_OPSLIMIT = 3;
const ARGON2ID_MEMLIMIT = 64 * 1024 * 1024; // bytes
/** libsodium's argon2i INTERACTIVE limits, used by containers with no `algo`. */
const ARGON2I_OPSLIMIT = 4;
const ARGON2I_MEMLIMIT = 32 * 1024 * 1024; // bytes
/**
 * A libsodium-era container, as opposed to the current one.
 *
 * The discriminator is `algo`, exactly as Coldstar's own loader uses it. A
 * container with no `algo` at all predates the Argon2id upgrade and is argon2i,
 * so it is only claimed here when the field sizes also match libsodium's.
 */
export function isLegacyKeyContainer(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        return false;
    const c = v;
    if (typeof c.salt !== "string" || typeof c.nonce !== "string" || typeof c.ciphertext !== "string") {
        return false;
    }
    if (typeof c.algo === "string")
        return c.algo.endsWith("_xsalsa20poly1305");
    // No `algo`: fall back to shape. Hex, and libsodium's sizes.
    if (!/^[0-9a-fA-F]+$/.test(c.salt) || !/^[0-9a-fA-F]+$/.test(c.nonce))
        return false;
    return c.salt.length === LIBSODIUM_SALT_SIZE * 2 && c.nonce.length === SECRETBOX_NONCE_SIZE * 2;
}
function fromHex(s, what) {
    if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) {
        throw new Error(`${what} is not valid hex`);
    }
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
}
/**
 * Derive the key the way libsodium would.
 *
 * `opslimit` maps to Argon2's time cost and `memlimit` is in BYTES, so it becomes
 * kibibytes here. Parallelism is not a parameter: libsodium hardcodes one lane,
 * which is why matching only the memory and time costs would still give a
 * different key.
 */
function deriveLegacyKey(passphrase, salt, container) {
    const algo = container.algo ?? "argon2i_xsalsa20poly1305";
    const isId = algo.startsWith("argon2id");
    const ops = container.opslimit ?? (isId ? ARGON2ID_OPSLIMIT : ARGON2I_OPSLIMIT);
    const mem = container.memlimit ?? (isId ? ARGON2ID_MEMLIMIT : ARGON2I_MEMLIMIT);
    const opts = { t: ops, m: Math.floor(mem / 1024), p: LIBSODIUM_LANES, dkLen: KEY_SIZE };
    const pass = new TextEncoder().encode(passphrase);
    return isId ? argon2id(pass, salt, opts) : argon2i(pass, salt, opts);
}
/**
 * Decrypt a legacy container, returning the 32-byte Ed25519 seed so callers can
 * treat it exactly like a current one. The caller must wipe it.
 */
export function decryptLegacyRootKey(container, passphrase) {
    if (!isLegacyKeyContainer(container))
        throw new Error("not a legacy key container");
    const salt = fromHex(container.salt, "salt");
    const nonce = fromHex(container.nonce, "nonce");
    const sealed = fromHex(container.ciphertext, "ciphertext");
    if (salt.length !== LIBSODIUM_SALT_SIZE) {
        throw new Error(`legacy salt must be ${LIBSODIUM_SALT_SIZE} bytes, got ${salt.length}`);
    }
    if (nonce.length !== SECRETBOX_NONCE_SIZE) {
        throw new Error(`legacy nonce must be ${SECRETBOX_NONCE_SIZE} bytes, got ${nonce.length}`);
    }
    if (sealed.length <= SECRETBOX_TAG_SIZE)
        throw new Error("ciphertext is too short to contain a tag");
    const key = deriveLegacyKey(passphrase, salt, container);
    let plaintext;
    try {
        plaintext = xsalsa20poly1305(key, nonce).decrypt(sealed);
    }
    catch {
        // Poly1305 authenticates, so a bad key and a bad file are indistinguishable.
        throw new Error("wrong passphrase, or the key file has been altered");
    }
    finally {
        wipe(key);
    }
    // These containers hold the full keypair. Everything downstream wants the seed.
    if (plaintext.length !== KEYPAIR_SIZE && plaintext.length !== SEED_SIZE) {
        wipe(plaintext);
        throw new Error(`decrypted key is ${plaintext.length} bytes, expected ${KEYPAIR_SIZE} or ${SEED_SIZE}`);
    }
    const seed = plaintext.slice(0, SEED_SIZE);
    wipe(plaintext);
    return seed;
}
//# sourceMappingURL=legacyKeyfile.js.map