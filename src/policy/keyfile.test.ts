import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { argon2id } from "@noble/hashes/argon2";
import { createCipheriv } from "node:crypto";
import {
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  containerMatchesPublicKey,
  decryptRootKey,
  encryptRootKey,
  isEncryptedKeyContainer,
  wipe,
  type EncryptedKeyContainer,
} from "./keyfile.js";

// Argon2id is deliberately slow (64 MB, t=3). Each derivation costs ~100ms, and
// several tests here do two. Keep the count of derivations low on purpose.
const PASS = "correct horse battery staple";

describe("encrypted root key container", () => {
  it("round-trips a 64-byte solana-keygen key through the seed", () => {
    const kp = Keypair.generate();
    const container = encryptRootKey(kp.secretKey, PASS, kp.publicKey.toBase58());
    const seed = decryptRootKey(container, PASS);

    expect(seed.length).toBe(32);
    // The container stores only the seed; the full keypair must be recoverable.
    expect(Keypair.fromSeed(seed).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    // And the seed is the first half of the solana-keygen array, as Rust assumes.
    expect(Buffer.from(seed).equals(Buffer.from(kp.secretKey.slice(0, 32)))).toBe(true);
  });

  it("accepts a bare 32-byte seed as well", () => {
    const kp = Keypair.generate();
    const container = encryptRootKey(kp.secretKey.slice(0, 32), PASS);
    expect(Keypair.fromSeed(decryptRootKey(container, PASS)).publicKey.toBase58()).toBe(
      kp.publicKey.toBase58(),
    );
    expect(container.public_key).toBeUndefined();
  });

  it("says 'wrong passphrase' rather than returning garbage", () => {
    const container = encryptRootKey(Keypair.generate().secretKey, PASS);
    expect(() => decryptRootKey(container, "wrong passphrase")).toThrow(/wrong passphrase/i);
  });

  it("refuses a tampered ciphertext", () => {
    const container = encryptRootKey(Keypair.generate().secretKey, PASS);
    const bytes = Buffer.from(container.ciphertext, "base64");
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0); // flip bits in the encrypted seed
    const tampered = { ...container, ciphertext: bytes.toString("base64") };
    // GCM authenticates the ciphertext, so this is indistinguishable from a bad
    // passphrase — which is the correct thing to tell the user either way.
    expect(() => decryptRootKey(tampered, PASS)).toThrow(/wrong passphrase, or the key file has been altered/);
  });

  it("refuses a swapped salt (an attacker cannot downgrade the KDF input)", () => {
    const container = encryptRootKey(Keypair.generate().secretKey, PASS);
    const other = Buffer.alloc(32, 7).toString("base64");
    expect(() => decryptRootKey({ ...container, salt: other }, PASS)).toThrow(/wrong passphrase/i);
  });

  it("rejects malformed containers instead of guessing", () => {
    const good = encryptRootKey(Keypair.generate().secretKey, PASS);
    expect(() => decryptRootKey({ ...good, salt: Buffer.alloc(16).toString("base64") }, PASS)).toThrow(/salt must be 32 bytes/);
    expect(() => decryptRootKey({ ...good, nonce: Buffer.alloc(8).toString("base64") }, PASS)).toThrow(/nonce must be 12 bytes/);
    expect(() => decryptRootKey({ ...good, ciphertext: Buffer.alloc(8).toString("base64") }, PASS)).toThrow(/too short/);
    expect(() => decryptRootKey({ ...good, version: 2 }, PASS)).toThrow(/unsupported key container version 2/);
  });

  it("rejects a weak passphrase at encryption time, not at rest", () => {
    expect(() => encryptRootKey(Keypair.generate().secretKey, "short")).toThrow(/at least 8 characters/);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => encryptRootKey(new Uint8Array(48), PASS)).toThrow(/must be 32 or 64 bytes/);
  });

  it("uses a fresh salt and nonce every time", () => {
    const kp = Keypair.generate();
    const a = encryptRootKey(kp.secretKey, PASS);
    const b = encryptRootKey(kp.secretKey, PASS);
    // Reusing a nonce under one key breaks GCM completely; reusing a salt makes
    // one cracking effort cover both files.
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("container shape and identification", () => {
  it("recognises a container and does not mistake a keypair array for one", () => {
    const container = encryptRootKey(Keypair.generate().secretKey, PASS);
    expect(isEncryptedKeyContainer(container)).toBe(true);
    // The plaintext format the CLIs must still distinguish it from.
    expect(isEncryptedKeyContainer([...Keypair.generate().secretKey])).toBe(false);
    expect(isEncryptedKeyContainer(null)).toBe(false);
    expect(isEncryptedKeyContainer({ salt: "a", nonce: "b" })).toBe(false);
  });

  it("identifies the key without needing the passphrase", () => {
    const kp = Keypair.generate();
    const container = encryptRootKey(kp.secretKey, PASS, kp.publicKey.toBase58());
    // This is why public_key is in the file: tooling can check it holds the
    // right root, and prompt with a recognisable name, before spending 64 MB.
    expect(container.public_key).toBe(kp.publicKey.toBase58());
    expect(containerMatchesPublicKey(container, kp.publicKey.toBytes())).toBe(true);
    expect(containerMatchesPublicKey(container, Keypair.generate().publicKey.toBytes())).toBe(false);
  });

  it("treats a container with no claimed public key as unconstrained", () => {
    const container = encryptRootKey(Keypair.generate().secretKey, PASS);
    expect(containerMatchesPublicKey(container, Keypair.generate().publicKey.toBytes())).toBe(true);
  });

  it("serialises to JSON with the field names the Rust signer writes", () => {
    const kp = Keypair.generate();
    const parsed = JSON.parse(JSON.stringify(encryptRootKey(kp.secretKey, PASS, kp.publicKey.toBase58())));
    expect(Object.keys(parsed).sort()).toEqual(["ciphertext", "nonce", "public_key", "salt", "version"]);
    expect(parsed.version).toBe(1);
    expect(Buffer.from(parsed.salt, "base64").length).toBe(32);
    expect(Buffer.from(parsed.nonce, "base64").length).toBe(12);
    // 32-byte seed plus the 16-byte GCM tag, concatenated as the aes-gcm crate does.
    expect(Buffer.from(parsed.ciphertext, "base64").length).toBe(48);
  });
});

describe("interoperability with the Coldstar signer", () => {
  it("pins the Argon2id parameters", () => {
    // These are not tuning knobs. They are the Rust signer's constants; if they
    // drift, a key encrypted by one tool cannot be opened by the other.
    expect(ARGON2_MEMORY_KIB).toBe(65536);
    expect(ARGON2_TIME_COST).toBe(3);
    expect(ARGON2_PARALLELISM).toBe(4);
  });

  it("matches the RFC 9106 Argon2id test vector", () => {
    // Guards the KDF itself. A silently different Argon2 would still round-trip
    // within this package while being unable to open a real Coldstar key file.
    const out = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      t: 3,
      m: 32,
      p: 4,
      dkLen: 32,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
    });
    expect(Buffer.from(out).toString("hex")).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );
  });

  it("decrypts a container built by hand the way Rust lays it out", () => {
    // Built independently of encryptRootKey: derive, encrypt, append the tag.
    // If our reader only understood our own writer, this test would fail.
    const kp = Keypair.generate();
    const salt = Buffer.alloc(32, 9);
    const nonce = Buffer.alloc(12, 5);
    const key = argon2id(new TextEncoder().encode(PASS), salt, { t: 3, m: 65536, p: 4, dkLen: 32 });
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const body = Buffer.concat([cipher.update(Buffer.from(kp.secretKey.slice(0, 32))), cipher.final()]);
    const container: EncryptedKeyContainer = {
      version: 1,
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
      public_key: kp.publicKey.toBase58(),
    };
    expect(Keypair.fromSeed(decryptRootKey(container, PASS)).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });
});

describe("wipe", () => {
  it("zeroes buffers and tolerates undefined", () => {
    const b = Uint8Array.from([1, 2, 3]);
    expect(() => wipe(b, undefined)).not.toThrow();
    expect([...b]).toEqual([0, 0, 0]);
  });
});
