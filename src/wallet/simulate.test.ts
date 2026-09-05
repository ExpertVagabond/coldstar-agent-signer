import { describe, it, expect, vi } from "vitest";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { ColdstarWallet } from "./coldstarWallet.js";
import type { Simulator } from "./simulate.js";
import type { Policy } from "../policy/schema.js";

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const session = Keypair.generate();
const allowed = Keypair.generate().publicKey;
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const policy: Policy = {
  version: 1,
  limits: { perTxSol: 0.1, dailySol: 0.25 },
  allowPrograms: [SystemProgram.programId.toBase58(), JUP.toBase58()],
  allowRecipients: [allowed.toBase58()],
  allowTokens: ["SOL"],
  blockRecipients: [],
  escalateAboveSol: 0.1,
};

function swapTx(): Transaction {
  // An opaque, allowlisted program instruction: static decoding sees 0 SOL.
  return new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH }).add(
    new TransactionInstruction({ programId: JUP, keys: [], data: Buffer.from([1]) }),
  );
}
function transferTx(sol: number): Transaction {
  return new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH }).add(
    SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: allowed, lamports: Math.round(sol * LAMPORTS_PER_SOL) }),
  );
}
const sim = (debitSol: number): Simulator => async () => ({ ok: true, debitLamports: BigInt(Math.round(debitSol * LAMPORTS_PER_SOL)) });
const failing: Simulator = async () => ({ ok: false, reason: "node returned no account state" });

describe("simulation-based accounting (posture b, opt-in)", () => {
  it("without a simulator, an allowlisted opaque program auto-signs at 0 SOL (posture a)", async () => {
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1" });
    const v = await w.evaluateTx(swapTx());
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.outSol).toBe(0);
  });

  it("a simulated 0.5 SOL debit through Jupiter escalates on the threshold", async () => {
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", preflight: { simulate: sim(0.5) } });
    const v = await w.evaluateTx(swapTx());
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/escalate threshold/);
    expect(v.reason).toMatch(/simulated debit 0.5 SOL/);
    expect(v.intent?.outSol).toBe(0.5);
    await expect(w.signTransaction(swapTx())).rejects.toMatchObject({ decision: "ESCALATE" });
  });

  it("a small simulated debit auto-signs and is counted against the daily cap", async () => {
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", preflight: { simulate: sim(0.08) } });
    await w.signTransaction(swapTx());
    expect(w.dailySpentSol()).toBeCloseTo(0.08, 9);
    await w.signTransaction(swapTx());
    await w.signTransaction(swapTx());
    // 0.24 spent; a fourth 0.08 would exceed the 0.25 daily cap
    await expect(w.signTransaction(swapTx())).rejects.toMatchObject({
      decision: "ESCALATE",
      reason: expect.stringContaining("daily cap"),
    });
  });

  it("simulation failure escalates (fail-closed), never auto-signs", async () => {
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", preflight: { simulate: failing } });
    const v = await w.evaluateTx(swapTx());
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/simulation failed: node returned no account state/);
  });

  it("a simulator that throws is treated like a failed simulation", async () => {
    const boom: Simulator = async () => { throw new Error("socket hang up"); };
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", preflight: { simulate: boom } });
    const v = await w.evaluateTx(swapTx());
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/socket hang up/);
  });

  it("when: 'opaque' (default) does not simulate System-only transfers", async () => {
    const spy = vi.fn(sim(9));
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", preflight: { simulate: spy } });
    const v = await w.evaluateTx(transferTx(0.01));
    expect(v.decision).toBe("AUTO_SIGN");
    expect(spy).not.toHaveBeenCalled();
  });

  it("when: 'always' simulates everything and takes the larger figure", async () => {
    const spy = vi.fn(sim(0.3));
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", preflight: { simulate: spy, when: "always" } });
    const v = await w.evaluateTx(transferTx(0.01));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(v.decision).toBe("ESCALATE");
    expect(v.intent?.outSol).toBe(0.3);
  });

  it("simulation can only tighten: a smaller simulated figure keeps the static amount", async () => {
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", preflight: { simulate: sim(0.001), when: "always" } });
    const v = await w.evaluateTx(transferTx(0.05));
    expect(v.intent?.outSol).toBe(0.05);
    expect(v.decision).toBe("AUTO_SIGN");
  });

  it("REJECT is decided statically and never reaches the simulator", async () => {
    const blocked = Keypair.generate().publicKey;
    const spy = vi.fn(sim(0));
    const w = new ColdstarWallet({
      policy: { ...policy, blockRecipients: [blocked.toBase58()] },
      session, rpcUrl: "http://127.0.0.1:1", preflight: { simulate: spy, when: "always" },
    });
    const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH }).add(
      SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: blocked, lamports: 1 }),
    );
    const v = await w.evaluateTx(tx);
    expect(v.decision).toBe("REJECT");
    expect(spy).not.toHaveBeenCalled();
  });
});
