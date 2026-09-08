// Coldstar Agent-Safe Signing — the root key, encrypted at rest.
//
// This package used to read its root from a plaintext solana-keygen file, which
// is precisely what Coldstar exists to tell people not to do. The root is now
// held in the SAME container the Coldstar signer already uses, so the file is
// one artifact rather than a third format:
//
//   Argon2id (v1.3, m = 64 MiB, t = 3, p = 4) over the passphrase and a 32-byte
//   salt, giving a 32-byte key; AES-256-GCM with a 12-byte nonce over the
//   32-byte Ed25519 SEED; ciphertext and tag concatenated, everything base64,
//   public key in base58 so a tool can identify the key without the passphrase.
//
// Matched against secure_signer/src/crypto.rs in devsyrem/coldstar.
//
// Argon2id comes from @noble/hashes: audited, pure JavaScript, no native build,
// which matters because the machine this runs on has no network to install from.

import { argon2id } from "@noble/hashes/argon2";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/** Deliberately identical to the Rust constants. Changing one breaks the other. */
export const ARGON2_MEMORY_KIB = 65536; // 64 MB
export const ARGON2_TIME_COST = 3;
export const ARGON2_PARALLELISM = 4;
const KEY_SIZE = 32;
const NONCE_SIZE = 12;
const SALT_SIZE = 32;
const SEED_SIZE = 32;
const TAG_SIZE = 16;

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
export const MIN_PASSPHRASE_LENGTH = 12;

const COMMON_PASSPHRASES = new Set([
  "password", "12345678", "123456789", "1234567890",
  "qwerty", "abc123", "password123", "admin",
  "letmein", "welcome", "monkey", "1234",
  "password1", "123456", "qwerty123",
]);

/** Returns null when acceptable, or the reason it is not. */
export function passphraseWeakness(passphrase: string): string | null {
  if (!passphrase) return "passphrase cannot be empty";
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long`;
  }
  if (!/[A-Z]/.test(passphrase)) return "passphrase must contain at least one uppercase letter";
  if (!/[a-z]/.test(passphrase)) return "passphrase must contain at least one lowercase letter";
  if (!/[0-9]/.test(passphrase)) return "passphrase must contain at least one number";
  if (COMMON_PASSPHRASES.has(passphrase.toLowerCase())) {
    return "passphrase is too common; choose a stronger one";
  }
  return null;
}

/**
 * Coerce a container into the shape this module reads.
 *
 * Coldstar's `_normalize_container_format` exists because containers are found
 * in the wild with `salt`, `nonce`, `ciphertext` and `public_key` as JSON arrays
 * of bytes rather than encoded strings. Rejecting those would mean telling a
 * Coldstar user their own key file is not a key file.
 */
export function normalizeKeyContainer(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const c = { ...(raw as Record<string, unknown>) };
  if (c.version === undefined) c.version = 1;
  for (const field of ["salt", "nonce", "ciphertext"]) {
    const v = c[field];
    if (Array.isArray(v)) c[field] = Buffer.from(Uint8Array.from(v as number[])).toString("base64");
  }
  if (Array.isArray(c.public_key)) {
    c.public_key = base58Encode(Uint8Array.from(c.public_key as number[]));
  }
  return c;
}

export function isEncryptedKeyContainer(v: unknown): v is EncryptedKeyContainer {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.salt !== "string" || typeof c.nonce !== "string" || typeof c.ciphertext !== "string") {
    return false;
  }
  // A legacy libsodium container ALSO has three string fields under these names,
  // so "has the right field names" is not a discriminator. Coldstar tells them
  // apart by `algo`, and so do we. Getting this wrong sends an old key file to
  // the wrong decryptor, which is how the legacy branch became unreachable once.
  if (typeof c.algo === "string" && c.algo.endsWith("_xsalsa20poly1305")) return false;
  // Belt and braces: the sizes are fixed and differ from libsodium's, and hex
  // decoded as base64 does not land on them.
  return (
    Buffer.from(c.salt, "base64").length === SALT_SIZE && Buffer.from(c.nonce, "base64").length === NONCE_SIZE
  );
}

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  return argon2id(new TextEncoder().encode(passphrase), salt, {
    t: ARGON2_TIME_COST,
    m: ARGON2_MEMORY_KIB,
    p: ARGON2_PARALLELISM,
    dkLen: KEY_SIZE,
  });
}

/** Overwrite a secret. Not a guarantee — a garbage collector may have copied it
 *  already — but it shortens the window, and saying otherwise would be a lie. */
export function wipe(...buffers: Array<Uint8Array | undefined>): void {
  for (const b of buffers) b?.fill(0);
}

/**
 * Encrypt a root key. Accepts a 32-byte seed or a 64-byte solana-keygen
 * keypair; only the seed is stored, exactly as the Rust implementation does.
 */
export function encryptRootKey(secret: Uint8Array, passphrase: string, publicKeyBase58?: string): EncryptedKeyContainer {
  if (secret.length !== SEED_SIZE && secret.length !== 64) {
    throw new Error(`root key must be 32 or 64 bytes, got ${secret.length}`);
  }
  const weak = passphraseWeakness(passphrase);
  if (weak) throw new Error(weak);

  const seed = secret.slice(0, SEED_SIZE);
  const salt = randomBytes(SALT_SIZE);
  const nonce = randomBytes(NONCE_SIZE);
  const key = deriveKey(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(seed), cipher.final()]);
    // The Rust `aes-gcm` crate returns ciphertext||tag, so match that layout.
    const ciphertext = Buffer.concat([body, cipher.getAuthTag()]);
    return {
      version: 1,
      salt: Buffer.from(salt).toString("base64"),
      nonce: Buffer.from(nonce).toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      ...(publicKeyBase58 ? { public_key: publicKeyBase58 } : {}),
    };
  } finally {
    wipe(key, seed);
  }
}

/**
 * Decrypt a root key, returning the 32-byte seed. The caller must wipe it.
 * A wrong passphrase fails the GCM tag, so it is reported as such rather than
 * silently producing garbage.
 */
export function decryptRootKey(container: EncryptedKeyContainer, passphrase: string): Uint8Array {
  if (!isEncryptedKeyContainer(container)) throw new Error("not an encrypted key container");
  if (container.version !== 1) throw new Error(`unsupported key container version ${container.version}`);

  const salt = Buffer.from(container.salt, "base64");
  const nonce = Buffer.from(container.nonce, "base64");
  const blob = Buffer.from(container.ciphertext, "base64");
  if (salt.length !== SALT_SIZE) throw new Error(`salt must be ${SALT_SIZE} bytes`);
  if (nonce.length !== NONCE_SIZE) throw new Error(`nonce must be ${NONCE_SIZE} bytes`);
  if (blob.length <= TAG_SIZE) throw new Error("ciphertext is too short to contain a tag");

  const body = blob.subarray(0, blob.length - TAG_SIZE);
  const tag = blob.subarray(blob.length - TAG_SIZE);
  const key = deriveKey(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const seed = Buffer.concat([decipher.update(body), decipher.final()]);
    if (seed.length !== SEED_SIZE) throw new Error(`decrypted key is ${seed.length} bytes, expected ${SEED_SIZE}`);
    return Uint8Array.from(seed);
  } catch (e) {
    const msg = (e as Error).message;
    if (/auth|tag|unable to authenticate/i.test(msg)) {
      throw new Error("wrong passphrase, or the key file has been altered");
    }
    throw e;
  } finally {
    wipe(key);
  }
}

/** Constant-time check that a container holds the key it claims to. */
export function containerMatchesPublicKey(container: EncryptedKeyContainer, publicKey: Uint8Array): boolean {
  if (!container.public_key) return true; // nothing claimed, nothing to contradict
  const claimed = base58Decode(container.public_key);
  return claimed.length === publicKey.length && timingSafeEqual(Buffer.from(claimed), Buffer.from(publicKey));
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character '${c}'`);
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}
