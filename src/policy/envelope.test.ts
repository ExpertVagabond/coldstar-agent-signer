import { describe, it, expect } from "vitest";
import { Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { signPolicyEnvelope, verifyPolicyEnvelope, parsePolicy, isEnvelope } from "./envelope.js";
import { ColdstarWallet } from "../wallet/coldstarWallet.js";
import type { Policy } from "./schema.js";

const root = Keypair.generate();
const session = Keypair.generate();
const other = Keypair.generate();
const allowed = Keypair.generate().publicKey;
const policy: Policy = {
  version: 1,
  limits: { perTxSol: 0.1, dailySol: 0.25 },
  allowPrograms: [SystemProgram.programId.toBase58()],
  allowRecipients: [allowed.toBase58()],
  allowTokens: ["SOL"],
  blockRecipients: [],
  escalateAboveSol: 0.1,
};

function sign(overrides: Partial<Parameters<typeof signPolicyEnvelope>[0]> = {}) {
  return signPolicyEnvelope({ rootSecretKey: root.secretKey, policy, sessionPubkey: session.publicKey.toBase58(), ...overrides });
}

describe("policy envelope", () => {
  it("round-trips: the root signs, the signer verifies with the root pinned", () => {
    const env = sign();
    expect(env.rootPubkey).toBe(root.publicKey.toBase58());
    const r = verifyPolicyEnvelope(env, { expectedRoot: root.publicKey.toBase58(), sessionPubkey: session.publicKey.toBase58() });
    expect(r.ok).toBe(true);
    // JSON round trip (this is how it crosses the air gap)
    const r2 = verifyPolicyEnvelope(JSON.parse(JSON.stringify(env)), { expectedRoot: root.publicKey.toBase58(), sessionPubkey: session.publicKey.toBase58() });
    expect(r2.ok).toBe(true);
  });

  it("a policy edited after signing fails: the whole point", () => {
    const env = JSON.parse(JSON.stringify(sign()));
    env.policy.limits.perTxSol = 100; // the online host tries to loosen its own leash
    const r = verifyPolicyEnvelope(env, { sessionPubkey: session.publicKey.toBase58() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not verify/);
  });

  it("key order in the JSON does not matter (canonical encoding)", () => {
    const env = sign();
    const reordered = JSON.parse(JSON.stringify({ signature: env.signature, rootPubkey: env.rootPubkey, expiresAt: env.expiresAt, issuedAt: env.issuedAt, sessionPubkey: env.sessionPubkey, policy: { escalateAboveSol: env.policy.escalateAboveSol, blockRecipients: [], allowTokens: ["SOL"], allowRecipients: env.policy.allowRecipients, allowPrograms: env.policy.allowPrograms, limits: { dailySol: 0.25, perTxSol: 0.1 }, version: 1 }, version: 1 }));
    expect(verifyPolicyEnvelope(reordered, { sessionPubkey: session.publicKey.toBase58() }).ok).toBe(true);
  });

  it("a different root fails when the expected root is pinned", () => {
    const env = signPolicyEnvelope({ rootSecretKey: other.secretKey, policy, sessionPubkey: session.publicKey.toBase58() });
    const r = verifyPolicyEnvelope(env, { expectedRoot: root.publicKey.toBase58(), sessionPubkey: session.publicKey.toBase58() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expected root/);
  });

  it("an envelope for a different session key is refused", () => {
    const env = sign();
    const r = verifyPolicyEnvelope(env, { sessionPubkey: other.publicKey.toBase58() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/authorises session/);
  });

  it("expiry is enforced", () => {
    const env = sign({ issuedAt: new Date("2026-09-05T00:00:00Z"), expiresAt: new Date("2026-09-05T12:00:00Z") });
    expect(verifyPolicyEnvelope(env, { sessionPubkey: session.publicKey.toBase58(), now: new Date("2026-09-05T11:59:00Z") }).ok).toBe(true);
    const late = verifyPolicyEnvelope(env, { sessionPubkey: session.publicKey.toBase58(), now: new Date("2026-09-05T12:00:00Z") });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toMatch(/expired/);
  });

  it("malformed envelopes and malformed policies fail closed with a path", () => {
    expect(verifyPolicyEnvelope({ version: 1 }, { sessionPubkey: "x" }).ok).toBe(false);
    expect(() => parsePolicy({ ...policy, allowRecipients: "not-an-array" })).toThrow(/allowRecipients/);
    expect(() => parsePolicy({ ...policy, extra: 1 })).toThrow(); // strict: unknown keys are refused
    expect(() => parsePolicy({ ...policy, limits: { perTxSol: -1, dailySol: 1 } })).toThrow(/perTxSol/);
  });

  it("isEnvelope distinguishes a signed envelope from a bare policy", () => {
    expect(isEnvelope(sign())).toBe(true);
    expect(isEnvelope(policy)).toBe(false);
  });
});

describe("ColdstarWallet with an envelope", () => {
  const tx = () => new Transaction({ feePayer: session.publicKey, recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" })
    .add(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: allowed, lamports: 0.01 * LAMPORTS_PER_SOL }));

  it("constructs from a valid envelope and enforces the policy inside", async () => {
    const w = ColdstarWallet.fromEnvelope({ envelope: sign(), expectedRoot: root.publicKey.toBase58(), session, rpcUrl: "http://127.0.0.1:1" });
    const out = await w.signTransaction(tx());
    expect(out.verifySignatures()).toBe(true);
    expect(w.envelope?.rootPubkey).toBe(root.publicKey.toBase58());
  });

  it("refuses to construct from a tampered envelope", () => {
    const env = JSON.parse(JSON.stringify(sign()));
    env.policy.blockRecipients = [];
    env.policy.allowRecipients.push(other.publicKey.toBase58());
    expect(() => ColdstarWallet.fromEnvelope({ envelope: env, expectedRoot: root.publicKey.toBase58(), session, rpcUrl: "http://127.0.0.1:1" }))
      .toThrow(/does not verify/);
  });

  it("refuses to construct when the session key is not the one the root authorised", () => {
    expect(() => ColdstarWallet.fromEnvelope({ envelope: sign(), session: other, rpcUrl: "http://127.0.0.1:1" })).toThrow(/authorises session/);
  });
});
