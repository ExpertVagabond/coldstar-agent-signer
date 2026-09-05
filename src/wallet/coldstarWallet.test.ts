import { describe, it, expect, vi } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  ColdstarWallet,
  ColdstarEscalation,
  ColdstarRejected,
  InMemorySpendLedger,
} from "./coldstarWallet.js";
import { projectTransaction } from "./project.js";
import type { Policy } from "../policy/schema.js";

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const session = Keypair.generate();
const allowed = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const blocked = Keypair.generate().publicKey;
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

const policy: Policy = {
  version: 1,
  limits: { perTxSol: 0.1, dailySol: 0.25 },
  allowPrograms: [SystemProgram.programId.toBase58(), JUP.toBase58()],
  allowRecipients: [allowed.toBase58()],
  allowTokens: ["SOL"],
  blockRecipients: [blocked.toBase58()],
  escalateAboveSol: 0.1,
};

function legacyTransfer(to: PublicKey, sol: number, from = session.publicKey): Transaction {
  const tx = new Transaction({ feePayer: from, recentBlockhash: BLOCKHASH });
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  return tx;
}

function versionedTransfer(to: PublicKey, sol: number): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: session.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

function wallet(overrides: Partial<ConstructorParameters<typeof ColdstarWallet>[0]> = {}) {
  return new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", ...overrides });
}

describe("ColdstarWallet — the three decisions", () => {
  it("AUTO_SIGN: in-policy legacy transfer is signed by the session key", async () => {
    const w = wallet();
    const tx = await w.signTransaction(legacyTransfer(allowed, 0.05));
    expect(tx.signatures[0]?.publicKey.equals(session.publicKey)).toBe(true);
    expect(tx.signatures[0]?.signature).not.toBeNull();
    expect(tx.verifySignatures()).toBe(true);
  });

  it("AUTO_SIGN: in-policy versioned (v0) transfer is signed", async () => {
    const w = wallet();
    const tx = await w.signTransaction(versionedTransfer(allowed, 0.05));
    const sig = tx.signatures[0]!;
    expect(nacl.sign.detached.verify(tx.message.serialize(), sig, session.publicKey.toBytes())).toBe(true);
  });

  it("REJECT: transfer to a blocklisted recipient throws and leaves NO signature", async () => {
    const w = wallet();
    const tx = legacyTransfer(blocked, 0.01);
    await expect(w.signTransaction(tx)).rejects.toBeInstanceOf(ColdstarRejected);
    expect(tx.signatures.every((s) => s.signature === null)).toBe(true);
  });

  it("REJECT beats an otherwise tiny, in-policy amount (the compromised-agent case)", async () => {
    const w = wallet();
    await expect(w.signTransaction(legacyTransfer(blocked, 0.000001))).rejects.toMatchObject({
      decision: "REJECT",
      reason: expect.stringContaining("blocklisted"),
    });
  });

  it("ESCALATE: over-threshold transfer throws ColdstarEscalation carrying the unsigned tx", async () => {
    const w = wallet();
    const tx = legacyTransfer(allowed, 0.5);
    const err = await w.signTransaction(tx).catch((e) => e);
    expect(err).toBeInstanceOf(ColdstarEscalation);
    expect(err.reason).toMatch(/escalate threshold/);
    const bytes = Buffer.from(err.unsignedTxBase64, "base64");
    const round = Transaction.from(bytes);
    expect(round.signatures.every((s) => s.signature === null)).toBe(true);
    expect(round.instructions).toHaveLength(1);
  });

  it("ESCALATE: unknown recipient with value escalates rather than signing", async () => {
    const w = wallet();
    await expect(w.signTransaction(legacyTransfer(stranger, 0.01))).rejects.toMatchObject({
      decision: "ESCALATE",
      reason: expect.stringContaining("not in allowRecipients"),
    });
  });

  it("ESCALATE: a human approval handler can return a signed tx, and the spend is counted", async () => {
    const root = Keypair.generate();
    const onEscalate = vi.fn(async <T extends Transaction | VersionedTransaction>(tx: T) => {
      (tx as Transaction).partialSign(root); // pretend the air-gapped device signed it
      return tx;
    });
    const ledger = new InMemorySpendLedger();
    const w = wallet({ onEscalate, ledger });
    const tx = legacyTransfer(root.publicKey, 0.5, root.publicKey);
    tx.feePayer = root.publicKey;
    const out = await w.signTransaction(tx);
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(out.signatures[0]?.signature).not.toBeNull();
    // parseTx counts value leaving the fee payer; the ledger records what was actually signed,
    // whether by the session key or by the human on the cold side.
    expect(ledger.get().dailySpentSol).toBeCloseTo(0.5, 9);
  });
});

describe("ColdstarWallet — daily cap and batches", () => {
  it("accumulates spend across signatures and escalates once the daily cap would be exceeded", async () => {
    const w = wallet();
    await w.signTransaction(legacyTransfer(allowed, 0.1));
    await w.signTransaction(legacyTransfer(allowed, 0.1));
    await expect(w.signTransaction(legacyTransfer(allowed, 0.1))).rejects.toMatchObject({
      decision: "ESCALATE",
      reason: expect.stringContaining("daily cap"),
    });
  });

  it("signAllTransactions counts the daily cap across the batch", async () => {
    const w = wallet();
    const txs = [legacyTransfer(allowed, 0.1), legacyTransfer(allowed, 0.1), legacyTransfer(allowed, 0.1)];
    await expect(w.signAllTransactions(txs)).rejects.toMatchObject({ decision: "ESCALATE" });
  });

  it("signAllTransactions signs nothing if any transaction in the batch is REJECTED", async () => {
    const w = wallet();
    const good = legacyTransfer(allowed, 0.01);
    const bad = legacyTransfer(blocked, 0.01);
    await expect(w.signAllTransactions([good, bad])).rejects.toBeInstanceOf(ColdstarRejected);
    expect(good.signatures.every((s) => s.signature === null)).toBe(true);
    expect(bad.signatures.every((s) => s.signature === null)).toBe(true);
  });

  it("the ledger rolls over at the UTC day boundary", () => {
    let now = new Date("2026-09-05T23:59:00Z");
    const ledger = new InMemorySpendLedger(() => now);
    ledger.add(0.2);
    expect(ledger.get().dailySpentSol).toBe(0.2);
    now = new Date("2026-09-06T00:01:00Z");
    expect(ledger.get().dailySpentSol).toBe(0);
  });
});

describe("ColdstarWallet — fail-closed edges", () => {
  it("a non-allowlisted program escalates", async () => {
    const w = wallet();
    const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH });
    tx.add(new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1, 2, 3]) }));
    await expect(w.signTransaction(tx)).rejects.toMatchObject({
      decision: "ESCALATE",
      reason: expect.stringContaining("not in allowPrograms"),
    });
  });

  it("an allowlisted opaque program (Jupiter) auto-signs — posture (a) in parseTx", async () => {
    const w = wallet();
    const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH });
    tx.add(new TransactionInstruction({ programId: JUP, keys: [], data: Buffer.from([0]) }));
    const out = await w.signTransaction(tx);
    expect(out.signatures[0]?.signature).not.toBeNull();
  });

  it("an empty transaction escalates (parseTx refuses to call it safe)", async () => {
    const w = wallet();
    const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH });
    await expect(w.signTransaction(tx)).rejects.toMatchObject({ decision: "ESCALATE" });
  });

  it("a v0 message whose account lives in a lookup table is refused by the projection", () => {
    const lookup = { key: Keypair.generate().publicKey, state: { addresses: [stranger, allowed], deactivationSlot: 0n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 } } as any;
    const msg = new TransactionMessage({
      payerKey: session.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: stranger, lamports: 1 })],
    }).compileToV0Message([lookup]);
    const r = projectTransaction(new VersionedTransaction(msg));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/lookup table/);
  });

  it("signMessage is refused by default and allowed only when opted in", async () => {
    const msg = new TextEncoder().encode("sign in with solana");
    await expect(wallet().signMessage(msg)).rejects.toBeInstanceOf(ColdstarRejected);
    const sig = await wallet({ allowMessageSigning: true }).signMessage(msg);
    expect(nacl.sign.detached.verify(msg, sig, session.publicKey.toBytes())).toBe(true);
  });

  it("onDecision observes every verdict, including AUTO_SIGN", async () => {
    const seen: string[] = [];
    const w = wallet({ onDecision: (d) => seen.push(d.decision) });
    await w.signTransaction(legacyTransfer(allowed, 0.01));
    await w.signTransaction(legacyTransfer(blocked, 0.01)).catch(() => {});
    await w.signTransaction(legacyTransfer(allowed, 9)).catch(() => {});
    expect(seen).toEqual(["AUTO_SIGN", "REJECT", "ESCALATE"]);
  });

  it("re-signing an already-signed transaction is a no-op: same bytes, no second ledger entry", async () => {
    const ledger = new InMemorySpendLedger();
    const w = wallet({ ledger });
    const tx = legacyTransfer(allowed, 0.05);
    const once = await w.signTransaction(tx);
    const bytes1 = Buffer.from(once.serialize());
    const twice = await w.signTransaction(once);
    expect(Buffer.from(twice.serialize()).equals(bytes1)).toBe(true);
    expect(ledger.get().dailySpentSol).toBeCloseTo(0.05, 9);
    const v0 = await w.signTransaction(versionedTransfer(allowed, 0.05));
    await w.signTransaction(v0);
    expect(ledger.get().dailySpentSol).toBeCloseTo(0.1, 9);
  });

  it("a tampered message with a stale signature is NOT treated as already signed", async () => {
    const w = wallet();
    const tx = await w.signTransaction(legacyTransfer(allowed, 0.01));
    // Mutate the message after signing: the old signature no longer verifies.
    tx.instructions[0] = SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: blocked, lamports: 1 });
    tx.signatures = tx.signatures.map((s) => ({ ...s })); // keep the stale sig entry
    await expect(w.signTransaction(tx)).rejects.toMatchObject({ decision: "REJECT" });
  });
});
