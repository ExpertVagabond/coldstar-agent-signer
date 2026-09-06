import { describe, it, expect } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ColdstarWallet, InMemorySpendLedger } from "../wallet/coldstarWallet.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, MEMO_PROGRAM_ID } from "../adapter/parseTx.js";
import type { Policy } from "./schema.js";

const session = Keypair.generate();
const payee = Keypair.generate().publicKey;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const ourAta = getAssociatedTokenAddressSync(USDC, session.publicKey, true);
const payeeAta = getAssociatedTokenAddressSync(USDC, payee, true);

function policy(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    limits: { perTxSol: 0.1, dailySol: 1 },
    allowPrograms: [
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      COMPUTE_BUDGET_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      MEMO_PROGRAM_ID,
    ],
    allowRecipients: [payee.toBase58()],
    allowTokens: ["SOL", USDC.toBase58()],
    tokenLimits: { [USDC.toBase58()]: { perTx: "25000000" } },
    blockRecipients: [],
    escalateAboveSol: 0.1,
    ...over,
  };
}
const wallet = (p: Policy = policy()) =>
  new ColdstarWallet({ policy: p, session, rpcUrl: "http://127.0.0.1:1", ledger: new InMemorySpendLedger() });
const tx = (...ixs: TransactionInstruction[]) =>
  new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH }).add(...ixs);
const pay = () => createTransferCheckedInstruction(ourAta, USDC, payeeAta, session.publicKey, 10_000_000n, 6);
const solTransfer = (sol: number) =>
  SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: payee, lamports: Math.round(sol * LAMPORTS_PER_SOL) });

describe("priority fees are spending too", () => {
  // A fee is real SOL leaving the wallet and is not a transfer, so before this
  // the amount limits never saw it and an allowlisted ComputeBudget program was
  // an unbounded drain.
  const fee = (microLamports: number, units?: number) =>
    units === undefined
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports })]
      : [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];

  it("an ordinary priority fee is counted but tiny", async () => {
    const v = await wallet().evaluateTx(tx(...fee(1_000, 200_000), solTransfer(0.01)));
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.outSol).toBeCloseTo(0.01 + 0.0000002, 9);
  });

  it("a fee large enough to drain the wallet escalates", async () => {
    const v = await wallet().evaluateTx(tx(...fee(71_428_572, 1_400_000), solTransfer(0.000000001)));
    expect(v.decision).toBe("ESCALATE");
    expect(v.intent?.outSol).toBeGreaterThanOrEqual(0.1);
  });

  it("with no explicit unit limit, Solana's default budget is assumed", async () => {
    // 200k compute units per instruction, capped at 1.4M for the transaction.
    // Two instructions here, so 400k units x 5e8 microlamports / 1e6 = 0.2 SOL.
    const v = await wallet().evaluateTx(tx(...fee(500_000_000), solTransfer(0.000000001)));
    expect(v.decision).toBe("ESCALATE");
    expect(v.intent?.outSol).toBeCloseTo(0.2, 6);
  });

  it("the assumed budget is capped at 1.4M however many instructions there are", async () => {
    const many = Array.from({ length: 10 }, () => solTransfer(0.0000000001));
    const v = await wallet().evaluateTx(tx(...fee(500_000_000), ...many));
    // 200k x 11 would be 2.2M, but the ceiling is 1.4M -> 0.7 SOL
    expect(v.intent?.outSol).toBeCloseTo(0.7, 5);
  });

  it("the fee counts toward the daily cap, not just the per-transaction limit", async () => {
    const w = wallet(policy({ limits: { perTxSol: 0.5, dailySol: 0.1 }, escalateAboveSol: 0.5 }));
    const v = await w.evaluateTx(tx(...fee(100_000_000, 1_400_000), solTransfer(0.000000001)));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/daily cap/);
  });

  it("an unknown compute budget instruction escalates", async () => {
    const raw = new TransactionInstruction({ programId: new PublicKey(COMPUTE_BUDGET_PROGRAM_ID), keys: [], data: Buffer.from([9, 1, 2, 3, 4]) });
    const v = await wallet().evaluateTx(tx(raw, solTransfer(0.001)));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/unknown compute budget/);
  });
});

describe("paying someone who has no token account yet", () => {
  // The ordinary case: the payee has never held this mint, so the payment
  // creates their account first. Treating that program as opaque escalated
  // every first payment.
  it("create-then-pay auto-signs, with the rent counted", async () => {
    const v = await wallet().evaluateTx(
      tx(createAssociatedTokenAccountIdempotentInstruction(session.publicKey, payeeAta, payee, USDC), pay()),
    );
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.outSol).toBeCloseTo(0.0025, 9);
  });

  it("the non-idempotent builder works the same way", async () => {
    const v = await wallet().evaluateTx(
      tx(createAssociatedTokenAccountInstruction(session.publicKey, payeeAta, payee, USDC), pay()),
    );
    expect(v.decision).toBe("AUTO_SIGN");
  });

  it("rent is not free: creating accounts in a loop hits the limit", async () => {
    // 41 x 0.0025 SOL is 0.1025, over the 0.1 per-transaction limit.
    const many = Array.from({ length: 41 }, () => {
      const owner = Keypair.generate().publicKey;
      return createAssociatedTokenAccountIdempotentInstruction(
        session.publicKey, getAssociatedTokenAddressSync(USDC, owner, true), owner, USDC,
      );
    });
    const v = await wallet().evaluateTx(tx(...many));
    expect(v.decision).toBe("ESCALATE");
    expect(v.intent?.outSol).toBeCloseTo(0.1025, 6);
  });

  it("rent has no recipient, so it is not checked against the recipient allowlist", async () => {
    // The account being funded belongs to a stranger; that is not a payment to them.
    const stranger = Keypair.generate().publicKey;
    const v = await wallet().evaluateTx(
      tx(createAssociatedTokenAccountIdempotentInstruction(
        session.publicKey, getAssociatedTokenAddressSync(USDC, stranger, true), stranger, USDC,
      )),
    );
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.recipients).toEqual([]);
  });

  it("an account someone else funds is not our spend", async () => {
    const other = Keypair.generate().publicKey;
    const v = await wallet().evaluateTx(
      tx(createAssociatedTokenAccountIdempotentInstruction(other, payeeAta, payee, USDC), pay()),
    );
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.outSol).toBe(0);
  });
});

describe("memo", () => {
  it("is read as moving nothing", async () => {
    const memo = new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from("invoice 41", "utf8"),
    });
    const v = await wallet().evaluateTx(tx(memo, solTransfer(0.01)));
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.outSol).toBeCloseTo(0.01, 9);
  });
});

describe("a program still has to be allowlisted", () => {
  it("decoding is not permission: ComputeBudget outside allowPrograms escalates", async () => {
    const w = wallet(policy({ allowPrograms: [SystemProgram.programId.toBase58()] }));
    const v = await w.evaluateTx(tx(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), solTransfer(0.001)));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/not in allowPrograms/);
  });
});
