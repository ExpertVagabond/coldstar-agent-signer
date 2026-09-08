import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { decryptLegacyRootKey, isLegacyKeyContainer } from "./legacyKeyfile.js";
import { encryptRootKey, isEncryptedKeyContainer, normalizeKeyContainer } from "./keyfile.js";

// The fixtures were produced by Coldstar's OWN SecureWalletHandler, not by
// anything in this repository. That is the whole point: a reader tested only
// against its own writer passes just as happily when both have drifted away from
// the format a real user's wallet is in.
const FIXTURES = JSON.parse(
  readFileSync(join(process.cwd(), "src", "policy", "fixtures", "legacy-containers.json"), "utf8"),
) as {
  vectors: Array<{
    passphrase: string;
    expected_public_key: string;
    expected_seed_hex: string;
    container: Record<string, unknown>;
  }>;
};

describe("legacy Coldstar key containers", () => {
  it("has fixtures to test against", () => {
    expect(FIXTURES.vectors.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES.vectors.map((v, i) => [i, v] as const))(
    "opens Coldstar-written container %i and recovers the right key",
    (_i, v) => {
      expect(isLegacyKeyContainer(v.container)).toBe(true);
      const seed = decryptLegacyRootKey(v.container as never, v.passphrase);
      expect(Buffer.from(seed).toString("hex")).toBe(v.expected_seed_hex);
      // The container holds the full 64-byte keypair; we return the seed, and the
      // public key derived from it must be the one Coldstar recorded.
      expect(Keypair.fromSeed(seed).publicKey.toBase58()).toBe(v.expected_public_key);
    },
  );

  it("pins the shape that makes these files mutually unreadable with the current format", () => {
    const c = FIXTURES.vectors[0]!.container as Record<string, string | number>;
    expect(c.version).toBe(2);
    expect(c.algo).toBe("argon2id_xsalsa20poly1305");
    expect(c.opslimit).toBe(3);
    expect(c.memlimit).toBe(64 * 1024 * 1024); // bytes, not KiB
    // libsodium's salt is 16 bytes and its secretbox nonce is 24; the current
    // container uses 32 and 12. Hex, not base64.
    expect(Buffer.from(String(c.salt), "hex").length).toBe(16);
    expect(Buffer.from(String(c.nonce), "hex").length).toBe(24);
    // 64-byte keypair plus a 16-byte Poly1305 tag.
    expect(Buffer.from(String(c.ciphertext), "hex").length).toBe(80);
  });

  it("refuses a wrong passphrase rather than returning garbage", () => {
    const v = FIXTURES.vectors[0]!;
    expect(() => decryptLegacyRootKey(v.container as never, "Definitely-Not-It-9")).toThrow(
      /wrong passphrase, or the key file has been altered/,
    );
  });

  it("refuses a tampered ciphertext", () => {
    const v = FIXTURES.vectors[0]!;
    const ct = Buffer.from(String(v.container.ciphertext), "hex");
    ct.writeUInt8(ct.readUInt8(0) ^ 0xff, 0);
    const tampered = { ...v.container, ciphertext: ct.toString("hex") };
    expect(() => decryptLegacyRootKey(tampered as never, v.passphrase)).toThrow(/wrong passphrase/);
  });

  it("rejects malformed legacy containers instead of guessing", () => {
    const v = FIXTURES.vectors[0]!;
    expect(() => decryptLegacyRootKey({ ...v.container, salt: "00".repeat(32) } as never, v.passphrase)).toThrow(
      /legacy salt must be 16 bytes/,
    );
    expect(() => decryptLegacyRootKey({ ...v.container, nonce: "00".repeat(12) } as never, v.passphrase)).toThrow(
      /legacy nonce must be 24 bytes/,
    );
    expect(() => decryptLegacyRootKey({ ...v.container, ciphertext: "zz" } as never, v.passphrase)).toThrow(
      /not valid hex/,
    );
  });
});

describe("telling the container formats apart", () => {
  it("does not confuse the two formats in either direction", () => {
    const legacy = FIXTURES.vectors[0]!.container;
    const current = encryptRootKey(Keypair.generate().secretKey, "Correct-Horse-Battery-9");

    expect(isLegacyKeyContainer(legacy)).toBe(true);
    expect(isLegacyKeyContainer(current)).toBe(false);
    expect(isEncryptedKeyContainer(current)).toBe(true);
    // The direction that actually bit: a legacy container has salt, nonce and
    // ciphertext as strings too, so the current reader claimed it and the legacy
    // branch in the CLI became unreachable. Caught by an end-to-end run, not by
    // this file, which is why the assertion now exists.
    expect(isEncryptedKeyContainer(legacy)).toBe(false);
    // And a container that merely lacks `algo` is still rejected on field sizes:
    // libsodium's 16-byte salt and 24-byte nonce are not the current 32 and 12.
    const { algo: _dropped, ...noAlgo } = legacy as Record<string, unknown>;
    expect(isEncryptedKeyContainer(noAlgo)).toBe(false);
    expect(isLegacyKeyContainer(noAlgo)).toBe(true);
  });

  it("rejects plaintext key arrays as neither format", () => {
    const plain = [...Keypair.generate().secretKey];
    expect(isLegacyKeyContainer(plain)).toBe(false);
    expect(isEncryptedKeyContainer(plain)).toBe(false);
  });
});

describe("normalizeKeyContainer", () => {
  it("accepts the array-form fields Coldstar normalizes", () => {
    // Coldstar's _normalize_container_format exists because containers are found
    // in the wild with byte arrays instead of encoded strings.
    const kp = Keypair.generate();
    const real = encryptRootKey(kp.secretKey, "Correct-Horse-Battery-9", kp.publicKey.toBase58());
    const arrayForm = {
      salt: [...Buffer.from(real.salt, "base64")],
      nonce: [...Buffer.from(real.nonce, "base64")],
      ciphertext: [...Buffer.from(real.ciphertext, "base64")],
      public_key: [...kp.publicKey.toBytes()],
    };
    expect(isEncryptedKeyContainer(arrayForm)).toBe(false); // before
    const fixed = normalizeKeyContainer(arrayForm);
    expect(isEncryptedKeyContainer(fixed)).toBe(true); // after
    expect(fixed).toMatchObject({
      version: 1,
      salt: real.salt,
      nonce: real.nonce,
      ciphertext: real.ciphertext,
      public_key: kp.publicKey.toBase58(),
    });
  });

  it("leaves an already-normal container alone and passes non-objects through", () => {
    const real = encryptRootKey(Keypair.generate().secretKey, "Correct-Horse-Battery-9");
    expect(normalizeKeyContainer(real)).toMatchObject(real);
    const arr = [1, 2, 3];
    expect(normalizeKeyContainer(arr)).toBe(arr);
    expect(normalizeKeyContainer(null)).toBe(null);
  });
});
