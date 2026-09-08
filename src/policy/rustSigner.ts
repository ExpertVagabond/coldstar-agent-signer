// Delegating to Coldstar's Rust signer when it is installed.
//
// This package decrypts the root key into an ordinary JavaScript heap. Nothing
// locks those pages against swap, and zeroing a buffer afterwards does not reach
// copies the runtime has already made. Coldstar's `secure_signer` does better:
// `secure_buffer.rs` locks with `mlock` and zeroizes on drop, including on panic,
// and `crypto.rs` routes every plaintext-key path through it.
//
// So when the `solana-signer` binary is present, hand it the work. The plaintext
// key then never exists in this process at all. When it is absent, the pure
// TypeScript path still runs, because it is the reason the air-gapped machine
// needs neither Node nor a package installer.
//
// The passphrase and the container go over stdin as one JSON line, never as
// arguments. `solana-signer sign --passphrase …` exists but would put the
// passphrase in `ps` output and shell history, so it is not used here.

import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/** Where to look, in order. An explicit path always wins. */
function candidatePaths(): string[] {
  const out: string[] = [];
  if (process.env.COLDSTAR_SIGNER_BIN) out.push(process.env.COLDSTAR_SIGNER_BIN);
  if (process.env.COLDSTAR_HOME) {
    out.push(join(process.env.COLDSTAR_HOME, "secure_signer", "target", "release", "solana-signer"));
  }
  return out;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the signer, or return null. Never throws: absence is the normal case,
 * not an error, and the caller falls back to the in-process path.
 */
export function findRustSigner(): string | null {
  for (const p of candidatePaths()) if (isExecutable(p)) return p;
  try {
    // `which` rather than a PATH walk, so a shell alias or shim is honoured.
    const found = execFileSync("which", ["solana-signer"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (found && isExecutable(found)) return found;
  } catch {
    /* not on PATH */
  }
  return null;
}

export interface RustSignerCapabilities {
  /** True when the binary reports it can lock memory on this machine. */
  memoryLocking: boolean;
  raw: unknown;
}

interface RustOutput {
  success: boolean;
  data?: unknown;
  error?: string;
}

function runOneCommand(bin: string, command: Record<string, unknown>, timeoutMs = 30_000): RustOutput {
  const line = JSON.stringify(command) + "\n";
  let stdout: string;
  try {
    stdout = execFileSync(bin, ["--stdin"], {
      input: line,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`solana-signer failed: ${(err.stderr || err.message || "unknown").toString().trim()}`);
  }
  const first = stdout.split("\n").find((l) => l.trim().length > 0);
  if (!first) throw new Error("solana-signer returned nothing");
  try {
    return JSON.parse(first) as RustOutput;
  } catch {
    throw new Error(`solana-signer returned unparseable output: ${first.slice(0, 200)}`);
  }
}

/** Ask the binary what it can do here. Memory locking can fail at runtime. */
export function rustSignerCapabilities(bin: string): RustSignerCapabilities {
  const out = runOneCommand(bin, { action: "check" });
  const data = (out.data ?? {}) as Record<string, unknown>;
  const locking =
    data.mlock_supported ?? data.memory_locking ?? data.mlock ?? data.memlock_supported ?? false;
  return { memoryLocking: locking === true || locking === 1, raw: out.data };
}

export interface RustSignature {
  /** Base58 detached Ed25519 signature over the bytes given. */
  signature: string;
  /** Base58 public key the signer used, for checking it held the key you meant. */
  publicKey: string;
}

/**
 * Sign arbitrary bytes with a key that never leaves the Rust process.
 *
 * Uses the `sign_payload` action, which returns only a detached signature and
 * the public key. Older signers do not have it, and for those this falls back to
 * `sign`: that action Ed25519-signs whatever bytes it is given all the same, but
 * calls them a transaction and returns a synthesised `signed_transaction` built
 * by prepending a signature count to them, which is meaningless for a grant.
 */
export function signWithRustSigner(
  bin: string,
  containerJson: string,
  passphrase: string,
  payload: Uint8Array,
): RustSignature {
  const data = Buffer.from(payload).toString("base64");
  const timeout = 120_000; // Argon2id at 64 MB, plus process start

  // `sign_payload` returns just the signature and public key. `sign` returns the
  // same signature plus a `signed_transaction` synthesised by prepending a
  // signature count to the payload, which for a policy grant is meaningless and
  // invites something downstream to try broadcasting it. Prefer the narrower
  // action, and fall back for signers that predate it (devsyrem/coldstar#14).
  let out = runOneCommand(
    bin,
    { action: "sign_payload", container: containerJson, passphrase, payload: data },
    timeout,
  );
  if (!out.success && /invalid json|unknown variant|missing field/i.test(String(out.error ?? ""))) {
    out = runOneCommand(
      bin,
      { action: "sign", container: containerJson, passphrase, transaction: data },
      timeout,
    );
  }
  if (!out.success) {
    const msg = (out.error ?? "unknown error").toString();
    if (/decrypt|passphrase|InvalidTag|DecryptionFailed/i.test(msg)) {
      throw new Error("wrong passphrase, or the key file has been altered");
    }
    throw new Error(`solana-signer: ${msg}`);
  }
  const result = (out.data ?? {}) as Record<string, unknown>;
  const signature = result.signature;
  const publicKey = result.public_key ?? result.publicKey;
  if (typeof signature !== "string" || typeof publicKey !== "string") {
    throw new Error("solana-signer returned no signature");
  }
  return { signature, publicKey };
}
