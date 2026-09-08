#!/usr/bin/env node
// `coldstar-encrypt-key` — turn a plaintext root key into an encrypted one.
//
//   coldstar-encrypt-key --in root.json --out root.coldstar.json
//
// Run this on the AIR-GAPPED machine, then destroy the plaintext original. The
// output is the same container the Coldstar signer uses (Argon2id + AES-256-GCM
// over the Ed25519 seed), so it is one artifact rather than a second format.
//
// Argon2id at 64 MB takes a moment on purpose: that cost is what a passphrase
// guess costs an attacker holding the file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { encryptRootKey, decryptRootKey, wipe } from "../policy/keyfile.js";
import { decryptLegacyRootKey, isLegacyKeyContainer } from "../policy/legacyKeyfile.js";
import { checkAirGap, describeAirGap } from "../policy/airgap.js";
import { readNewPassphrase, readPassphrase } from "./passphrase.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg: string): never {
  process.stderr.write(`coldstar-encrypt-key: ${msg}\n`);
  process.exit(2);
}

const inPath = arg("in") ?? fail("--in <plaintext keyfile> is required");
const outPath = arg("out") ?? fail("--out <encrypted keyfile> is required");
if (existsSync(outPath) && !process.argv.includes("--force")) {
  fail(`${outPath} already exists; pass --force to overwrite`);
}

const gap = checkAirGap();
if (!gap.airGapped && !process.argv.includes("--allow-network")) {
  process.stderr.write(
    `coldstar-encrypt-key: ${describeAirGap(gap)}\n` +
      "Refusing to read a plaintext root key on a networked machine. Pass --allow-network to override.\n",
  );
  process.exit(3);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(inPath, "utf8"));
} catch (e) {
  fail(`cannot read ${inPath}: ${(e as Error).message}`);
}
// Two kinds of input: a plaintext solana-keygen array, or an older Coldstar
// container that needs upgrading to the current format. The second case is the
// migration Coldstar's own wallet performs on first open.
let secret: Uint8Array;
if (isLegacyKeyContainer(raw)) {
  process.stderr.write(`${inPath} is a legacy Coldstar key file; it will be re-encrypted in the current format.\n`);
  const oldPass = await readPassphrase("Existing passphrase: ");
  process.stderr.write("deriving the key (Argon2id, libsodium parameters)…\n");
  try {
    secret = decryptLegacyRootKey(raw, oldPass);
  } catch (e) {
    fail((e as Error).message);
  }
} else if (Array.isArray(raw)) {
  secret = Uint8Array.from(raw as number[]);
  if (secret.length !== 64 && secret.length !== 32) fail(`expected 32 or 64 bytes, got ${secret.length}`);
} else {
  fail(`${inPath} is neither a solana-keygen key file nor a Coldstar key container`);
}

const keypair = secret.length === 64 ? Keypair.fromSecretKey(secret) : Keypair.fromSeed(secret);
process.stderr.write(`root public key: ${keypair.publicKey.toBase58()}\n`);

let passphrase: string;
try {
  passphrase = await readNewPassphrase();
} catch (e) {
  fail((e as Error).message);
}
process.stderr.write("deriving the key (Argon2id, 64 MB — this is meant to be slow)…\n");
const container = encryptRootKey(secret, passphrase, keypair.publicKey.toBase58());

// Never write a container we cannot open again.
const check = decryptRootKey(container, passphrase);
const roundTrips = Keypair.fromSeed(check).publicKey.equals(keypair.publicKey);
wipe(check, secret);
if (!roundTrips) fail("internal error: the encrypted key did not round-trip; nothing was written");

writeFileSync(outPath, JSON.stringify(container, null, 2) + "\n", { mode: 0o600 });
process.stderr.write(
  `wrote ${outPath} (mode 0600), verified it decrypts back to ${keypair.publicKey.toBase58()}\n\n` +
    `Keep the original until you have confirmed the new file works, then destroy it:\n  rm -P ${inPath}\n` +
    "If you lose the passphrase the key is gone. There is no recovery, by design.\n",
);
