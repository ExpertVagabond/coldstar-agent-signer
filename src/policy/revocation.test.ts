import { describe, it, expect, vi } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { RevocationChecker, revocationMemo, buildRevocationTransaction, MEMO_PROGRAM_ID } from "./revocation.js";
import { signPolicyEnvelope } from "./envelope.js";
import { ColdstarWallet } from "../wallet/coldstarWallet.js";
import type { Policy } from "./schema.js";

const root = Keypair.generate();
const revoker = Keypair.generate();
const session = Keypair.generate();
const allowed = Keypair.generate().publicKey;
const SESSION = session.publicKey.toBase58();
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

/** entries: [authorityBase58, memoText, signedByAuthority] */
function fakeConnection(entries: Array<[string, string, boolean]>, opts: { throws?: boolean } = {}): Connection {
  return {
    getSignaturesForAddress: vi.fn(async (addr: { toBase58(): string }) => {
      if (opts.throws) throw new Error("RPC unreachable");
      return entries
        .filter(([a]) => a === addr.toBase58())
        .map(([, memo], i) => ({ signature: `sig${i}${addr.toBase58().slice(0, 4)}`, memo: `[${memo.length}] ${memo}`, err: null, blockTime: 1 }));
    }),
    getTransaction: vi.fn(async (sig: string) => {
      const idx = Number(sig.replace("sig", "").charAt(0));
      const authority = entries[idx]?.[0];
      const signedBy = entries[idx]?.[2];
      if (!authority) return null;
      const signer = signedBy ? authority : Keypair.generate().publicKey.toBase58();
      return {
        meta: { err: null },
        transaction: {
          message: {
            header: { numRequiredSignatures: 1 },
            staticAccountKeys: [{ equals: (k: { toBase58(): string }) => k.toBase58() === signer, toBase58: () => signer }],
          },
        },
      };
    }),
  } as unknown as Connection;
}

const checker = (entries: Array<[string, string, boolean]>, authorities: string[], o: { throws?: boolean } = {}) =>
  new RevocationChecker({ connection: fakeConnection(entries, o), sessionPubkey: SESSION, authorities });

describe("on-chain revocation", () => {
  it("the marker names the session key and rides in a memo instruction", () => {
    expect(revocationMemo(SESSION)).toBe(`coldstar:revoke:v1:${SESSION}`);
    const tx = buildRevocationTransaction({ authority: root.publicKey, sessionPubkey: SESSION, recentBlockhash: BLOCKHASH });
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]!.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(tx.instructions[0]!.data.toString("utf8")).toBe(revocationMemo(SESSION));
    expect(tx.feePayer?.equals(root.publicKey)).toBe(true);
  });

  it("reports active when the chain carries no marker", async () => {
    const s = await checker([], [root.publicKey.toBase58()]).status();
    expect(s.state).toBe("active");
  });

  it("reports revoked when the root published the marker", async () => {
    const s = await checker([[root.publicKey.toBase58(), revocationMemo(SESSION), true]], [root.publicKey.toBase58()]).status();
    expect(s.state).toBe("revoked");
    if (s.state === "revoked") expect(s.by).toBe(root.publicKey.toBase58());
  });

  it("the envelope's revoker can revoke without the root", async () => {
    const s = await checker(
      [[revoker.publicKey.toBase58(), revocationMemo(SESSION), true]],
      [root.publicKey.toBase58(), revoker.publicKey.toBase58()],
    ).status();
    expect(s.state).toBe("revoked");
  });

  it("a marker merely REFERENCING an authority does not revoke: it must be signed by one", async () => {
    const s = await checker([[root.publicKey.toBase58(), revocationMemo(SESSION), false]], [root.publicKey.toBase58()]).status();
    expect(s.state).toBe("active");
  });

  it("a marker naming a different session key does not revoke this one", async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const s = await checker([[root.publicKey.toBase58(), revocationMemo(other), true]], [root.publicKey.toBase58()]).status();
    expect(s.state).toBe("active");
  });

  it("an unreachable chain is 'unknown', never 'active'", async () => {
    const s = await checker([], [root.publicKey.toBase58()], { throws: true }).status();
    expect(s.state).toBe("unknown");
    if (s.state === "unknown") expect(s.reason).toMatch(/unreachable/);
  });

  it("revocation is sticky: once revoked, it is not re-checked", async () => {
    const conn = fakeConnection([[root.publicKey.toBase58(), revocationMemo(SESSION), true]]);
    const c = new RevocationChecker({ connection: conn, sessionPubkey: SESSION, authorities: [root.publicKey.toBase58()] });
    expect((await c.status()).state).toBe("revoked");
    const calls = (conn.getSignaturesForAddress as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect((await c.status()).state).toBe("revoked");
    expect((conn.getSignaturesForAddress as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });

  it("an active answer is cached until it goes stale", async () => {
    let now = 1_000_000;
    const conn = fakeConnection([]);
    const c = new RevocationChecker({ connection: conn, sessionPubkey: SESSION, authorities: [root.publicKey.toBase58()], freshnessMs: 60_000, now: () => now });
    await c.status();
    await c.status();
    const m = conn.getSignaturesForAddress as unknown as { mock: { calls: unknown[] } };
    expect(m.mock.calls.length).toBe(1);
    now += 61_000;
    await c.status();
    expect(m.mock.calls.length).toBe(2);
  });
});

describe("ColdstarWallet under revocation", () => {
  const policy: Policy = {
    version: 1,
    limits: { perTxSol: 0.1, dailySol: 0.25 },
    allowPrograms: [SystemProgram.programId.toBase58()],
    allowRecipients: [allowed.toBase58()],
    allowTokens: ["SOL"],
    blockRecipients: [],
    escalateAboveSol: 0.1,
  };
  const tx = () => new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH })
    .add(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: allowed, lamports: 0.01 * LAMPORTS_PER_SOL }));

  it("an in-policy transaction still signs while the grant is live", async () => {
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", revocation: checker([], [root.publicKey.toBase58()]) });
    const out = await w.signTransaction(tx());
    expect(out.verifySignatures()).toBe(true);
  });

  it("a revoked grant REJECTS everything, in policy or not", async () => {
    const w = new ColdstarWallet({
      policy, session, rpcUrl: "http://127.0.0.1:1",
      revocation: checker([[root.publicKey.toBase58(), revocationMemo(SESSION), true]], [root.publicKey.toBase58()]),
    });
    const t = tx();
    await expect(w.signTransaction(t)).rejects.toMatchObject({ decision: "REJECT", reason: expect.stringContaining("revoked on chain") });
    expect(t.signatures.every((s) => s.signature === null)).toBe(true);
  });

  it("an unreachable chain ESCALATES: cutting off RPC stops the agent, it does not free it", async () => {
    const w = new ColdstarWallet({
      policy, session, rpcUrl: "http://127.0.0.1:1",
      revocation: checker([], [root.publicKey.toBase58()], { throws: true }),
    });
    await expect(w.signTransaction(tx())).rejects.toMatchObject({
      decision: "ESCALATE",
      reason: expect.stringContaining("cannot confirm the grant is still live"),
    });
  });

  it("fromEnvelope wires the root and the envelope's revoker as authorities", () => {
    const env = signPolicyEnvelope({
      rootSecretKey: root.secretKey, policy, sessionPubkey: SESSION, revoker: revoker.publicKey.toBase58(),
    });
    expect(env.version).toBe(2);
    expect(env.revoker).toBe(revoker.publicKey.toBase58());
    const w = ColdstarWallet.fromEnvelope({
      envelope: env, expectedRoot: root.publicKey.toBase58(), session, rpcUrl: "https://api.devnet.solana.com", checkRevocation: true,
    });
    expect(w.envelope?.revoker).toBe(revoker.publicKey.toBase58());
  });
});
