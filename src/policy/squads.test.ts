import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import { ColdstarWallet, InMemorySpendLedger } from "../wallet/coldstarWallet.js";
import { SQUADS_PROGRAM_ID } from "../adapter/parseTx.js";
import type { Policy } from "./schema.js";

// Instructions are built with @sqds/multisig, so the decoder is tested against
// what the real SDK emits rather than bytes I hand-rolled to match my own reader.

const session = Keypair.generate();
const payee = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const usdc = (n: number) => Math.round(n * 1e6);

const createKey = Keypair.generate().publicKey;
const [multisigPda] = multisig.getMultisigPda({ createKey });
const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
const [spendingLimitPda] = multisig.getSpendingLimitPda({ multisigPda, createKey: Keypair.generate().publicKey });

function policy(over: Partial<Policy> = {}): Policy {
  return {
    version: 1,
    limits: { perTxSol: 0.1, dailySol: 0.25 },
    allowPrograms: [SystemProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58(), SQUADS_PROGRAM_ID],
    allowRecipients: [payee.toBase58()],
    allowTokens: ["SOL", USDC.toBase58()],
    tokenLimits: { [USDC.toBase58()]: { perTx: String(usdc(25)), daily: String(usdc(50)) } },
    blockRecipients: [],
    escalateAboveSol: 0.1,
    ...over,
  };
}

const wallet = (p: Policy = policy()) =>
  new ColdstarWallet({ policy: p, session, rpcUrl: "http://127.0.0.1:1", ledger: new InMemorySpendLedger() });

function tx(ix: Parameters<Transaction["add"]>[0]): Transaction {
  return new Transaction({ feePayer: session.publicKey, recentBlockhash: BLOCKHASH }).add(ix);
}

/** A SOL spend through the vault's spending limit, authorised by the session key. */
function solSpend(amountSol: number, destination = payee, member = session.publicKey) {
  return multisig.instructions.spendingLimitUse({
    multisigPda,
    member,
    spendingLimit: spendingLimitPda,
    vaultIndex: 0,
    amount: Math.round(amountSol * LAMPORTS_PER_SOL),
    decimals: 9,
    destination,
    programId: multisig.PROGRAM_ID,
  });
}

/** A USDC spend through the same limit. */
function usdcSpend(amount: number, destination = payee) {
  return multisig.instructions.spendingLimitUse({
    multisigPda,
    member: session.publicKey,
    spendingLimit: spendingLimitPda,
    mint: USDC,
    vaultIndex: 0,
    amount,
    decimals: 6,
    destination,
    tokenProgram: TOKEN_PROGRAM_ID,
    programId: multisig.PROGRAM_ID,
  });
}

describe("Squads spending limits are read, not treated as opaque", () => {
  it("a SOL spend within policy auto-signs and counts against the daily cap", async () => {
    const w = wallet();
    const v = await w.evaluateTx(tx(solSpend(0.05)));
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.outSol).toBeCloseTo(0.05, 9);
    expect(v.intent?.recipients).toContain(payee.toBase58());
    await w.signTransaction(tx(solSpend(0.05)));
    expect(w.dailySpentSol()).toBeCloseTo(0.05, 9);
  });

  it("a SOL spend over the threshold escalates, even though the vault would allow it", async () => {
    const v = await wallet().evaluateTx(tx(solSpend(5)));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/escalate threshold/);
  });

  it("a spend to a recipient the local policy does not allow escalates", async () => {
    const v = await wallet().evaluateTx(tx(solSpend(0.01, stranger)));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/not in allowRecipients/);
  });

  it("a blocklisted destination is rejected outright", async () => {
    const w = wallet(policy({ blockRecipients: [stranger.toBase58()] }));
    const t = tx(solSpend(0.001, stranger));
    await expect(w.signTransaction(t)).rejects.toMatchObject({ decision: "REJECT" });
    expect(t.signatures.every((s) => s.signature === null)).toBe(true);
  });

  // The SDK fills the system_program slot even for an SPL spend, so a decoder
  // that tests that slot first reads 10 USDC as 0.01 SOL. This is that guard.
  it("a USDC spend is read as a token movement, NOT as lamports", async () => {
    const w = wallet();
    const ok = await w.evaluateTx(tx(usdcSpend(usdc(10))));
    expect(ok.intent?.outSol).toBe(0);
    expect(ok.decision).toBe("AUTO_SIGN");
    expect(ok.intent?.tokenMovements[0]?.mint).toBe(USDC.toBase58());
    expect(ok.intent?.tokenMovements[0]?.amount).toBe(BigInt(usdc(10)));

    const over = await w.evaluateTx(tx(usdcSpend(usdc(30))));
    expect(over.decision).toBe("ESCALATE");
    expect(over.reason).toMatch(/per-transaction limit/);
  });

  it("a spend authorised by a different member is not counted as ours", async () => {
    const v = await wallet().evaluateTx(tx(solSpend(9, payee, Keypair.generate().publicKey)));
    expect(v.decision).toBe("AUTO_SIGN");
    expect(v.intent?.outSol).toBe(0);
  });
});

describe("an agent must not be able to raise its own ceiling", () => {
  const config = { multisigPda, configAuthority: session.publicKey, rentPayer: session.publicKey, programId: multisig.PROGRAM_ID };

  it("adding a spending limit escalates", async () => {
    const ix = multisig.instructions.multisigAddSpendingLimit({
      ...config,
      spendingLimit: spendingLimitPda,
      createKey: Keypair.generate().publicKey,
      vaultIndex: 0,
      mint: new PublicKey("11111111111111111111111111111111"),
      amount: BigInt(1_000_000_000_000),
      period: multisig.types.Period.Day,
      members: [session.publicKey],
      destinations: [stranger],
    });
    const v = await wallet().evaluateTx(tx(ix));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/raises the agent's own ceiling/);
  });

  it("removing a spending limit escalates", async () => {
    const ix = multisig.instructions.multisigRemoveSpendingLimit({
      multisigPda,
      configAuthority: session.publicKey,
      rentCollector: session.publicKey,
      spendingLimit: spendingLimitPda,
      programId: multisig.PROGRAM_ID,
    });
    const v = await wallet().evaluateTx(tx(ix));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/multisig_remove_spending_limit/);
  });

  it("executing an arbitrary vault transaction escalates", async () => {
    // The SDK's builder needs on-chain state to resolve remaining accounts, so
    // this asserts on the discriminator the program actually dispatches on.
    const disc = Buffer.from([194, 8, 161, 87, 153, 164, 25, 171]);
    const raw = { programId: new PublicKey(SQUADS_PROGRAM_ID), keys: [
      { pubkey: multisigPda, isSigner: false, isWritable: false },
      { pubkey: session.publicKey, isSigner: true, isWritable: false },
    ], data: disc };
    const v = await wallet().evaluateTx(tx(raw));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/arbitrary transfer from the vault/);
  });

  it("an unrecognised Squads instruction escalates rather than passing through", async () => {
    const raw = { programId: new PublicKey(SQUADS_PROGRAM_ID), keys: [], data: Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]) };
    const v = await wallet().evaluateTx(tx(raw));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/unknown squads instruction/);
  });

  it("without Squads in allowPrograms nothing Squads-related signs at all", async () => {
    const w = wallet(policy({ allowPrograms: [SystemProgram.programId.toBase58()] }));
    const v = await w.evaluateTx(tx(solSpend(0.001)));
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/not in allowPrograms/);
  });
});
