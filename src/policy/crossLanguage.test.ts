import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, SystemProgram } from "@solana/web3.js";
import nacl from "tweetnacl";
import { verifyPolicyEnvelope, signPolicyEnvelope, envelopePayload } from "./envelope.js";
import type { Policy } from "./schema.js";

// The Python signer exists so an air-gapped machine needs only python3. That is
// only true if its output is byte-identical to the TypeScript signer's, so this
// suite runs the real script and verifies with the real verifier.

const TOOL = join(process.cwd(), "tools", "coldstar_sign_policy.py");
const root = Keypair.generate();
const session = Keypair.generate();
const revoker = Keypair.generate();
const allowed = Keypair.generate().publicKey;

const policy: Policy = {
  version: 1,
  limits: { perTxSol: 0.05, dailySol: 0.2 },
  allowPrograms: [SystemProgram.programId.toBase58()],
  allowRecipients: [allowed.toBase58()],
  allowTokens: ["SOL"],
  blockRecipients: [Keypair.generate().publicKey.toBase58()],
  escalateAboveSol: 0.05,
};

let dir: string;
let python: string | undefined;

function havePython(): string | undefined {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe" });
      return bin;
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

/** Run the Python signer. --allow-network because CI and dev machines are online. */
function signWithPython(extra: string[] = []): Record<string, unknown> {
  const out = execFileSync(
    python as string,
    [TOOL, "--root", join(dir, "root.json"), "--policy", join(dir, "policy.json"),
     "--session", session.publicKey.toBase58(), "--allow-network", ...extra],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(out) as Record<string, unknown>;
}

beforeAll(() => {
  python = havePython();
  dir = mkdtempSync(join(tmpdir(), "cs-py-"));
  writeFileSync(join(dir, "root.json"), JSON.stringify(Array.from(root.secretKey)));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
});

describe.runIf(havePython())("the Python signer and the TypeScript verifier agree", () => {
  it("a version 1 envelope from Python verifies in TypeScript", () => {
    const env = signWithPython(["--expires", "7d"]);
    expect(env.version).toBe(1);
    expect(env.rootPubkey).toBe(root.publicKey.toBase58());
    const r = verifyPolicyEnvelope(env, { expectedRoot: root.publicKey.toBase58(), sessionPubkey: session.publicKey.toBase58() });
    expect(r.ok).toBe(true);
  });

  it("a version 2 envelope with a revoker verifies too", () => {
    const env = signWithPython(["--expires", "24h", "--revoker", revoker.publicKey.toBase58()]);
    expect(env.version).toBe(2);
    expect(env.revoker).toBe(revoker.publicKey.toBase58());
    const r = verifyPolicyEnvelope(env, { expectedRoot: root.publicKey.toBase58(), sessionPubkey: session.publicKey.toBase58() });
    expect(r.ok).toBe(true);
  });

  it("both languages sign the SAME BYTES: the canonical payloads are identical", () => {
    const env = signWithPython() as unknown as {
      policy: Policy; sessionPubkey: string; issuedAt: string; expiresAt: string | null; signature: string;
    };
    // Re-sign the Python envelope's own fields with the TypeScript signer and
    // compare signatures. Ed25519 is deterministic, so equal signatures mean
    // equal payload bytes — the canonical encodings match exactly.
    const ts = signPolicyEnvelope({
      rootSecretKey: root.secretKey,
      policy: env.policy,
      sessionPubkey: env.sessionPubkey,
      issuedAt: new Date(env.issuedAt),
      expiresAt: env.expiresAt === null ? null : new Date(env.expiresAt),
    });
    expect(ts.signature).toBe(env.signature);
  });

  it("the Python signature verifies against the payload TypeScript computes", () => {
    const env = signWithPython(["--expires", "1d"]) as unknown as Parameters<typeof envelopePayload>[0] & { signature: string };
    const payload = envelopePayload(env);
    const sig = bs58ToBytes(env.signature);
    expect(nacl.sign.detached.verify(payload, sig, root.publicKey.toBytes())).toBe(true);
  });

  it("an envelope edited after Python signed it is refused", () => {
    const env = signWithPython(["--expires", "7d"]) as Record<string, unknown>;
    (env.policy as Policy).limits.perTxSol = 999;
    const r = verifyPolicyEnvelope(env, { sessionPubkey: session.publicKey.toBase58() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not verify/);
  });

  it("the Python tool refuses a policy with placeholders", () => {
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...policy, allowRecipients: ["<fill me in>"] }));
    expect(() =>
      execFileSync(python as string, [TOOL, "--root", join(dir, "root.json"), "--policy", join(dir, "bad.json"),
        "--session", session.publicKey.toBase58(), "--allow-network"], { stdio: "pipe" }),
    ).toThrow();
  });

  it("the Python tool refuses to read the root key on a networked machine by default", () => {
    // No --allow-network: this machine has interfaces, so it must exit non-zero.
    let code = 0;
    try {
      execFileSync(python as string, [TOOL, "--root", join(dir, "root.json"), "--policy", join(dir, "policy.json"),
        "--session", session.publicKey.toBase58()], { stdio: "pipe" });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(3);
  });
});

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58ToBytes(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
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
