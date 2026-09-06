import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { ChainSpendLedger } from "./chainLedger.js";
import { FileSpendLedger } from "./ledger.js";
import { ColdstarWallet } from "./coldstarWallet.js";
import type { Policy } from "../policy/schema.js";

const session = Keypair.generate();
const allowed = Keypair.generate().publicKey;
const ADDR = session.publicKey;
const DAY = new Date("2026-09-06T12:00:00Z");
const dayStart = Math.floor(Date.UTC(2026, 8, 6) / 1000);

/** A Connection stand-in: `history` is [signature, blockTime, debitLamports, err?]. */
function fakeConnection(history: Array<[string, number, number, boolean?]>, opts: { throwOn?: "sigs" | "txs" } = {}): Connection {
  return {
    getSignaturesForAddress: vi.fn(async () => {
      if (opts.throwOn === "sigs") throw new Error("RPC 429");
      return history.map(([signature, blockTime, , err]) => ({ signature, blockTime, err: err ? {} : null }));
    }),
    getParsedTransactions: vi.fn(async (sigs: string[]) => {
      if (opts.throwOn === "txs") throw new Error("RPC timeout");
      return sigs.map((s) => {
        const row = history.find(([sig]) => sig === s);
        if (!row) return null;
        const [, , debit, err] = row;
        return {
          meta: { err: err ? {} : null, preBalances: [10 * LAMPORTS_PER_SOL, 0], postBalances: [10 * LAMPORTS_PER_SOL - debit, 0] },
          transaction: { message: { accountKeys: [{ pubkey: ADDR }, { pubkey: new PublicKey(allowed) }] } },
        };
      });
    }),
  } as unknown as Connection;
}

const ledger = (history: Array<[string, number, number, boolean?]>, local?: FileSpendLedger, o: { throwOn?: "sigs" | "txs" } = {}) =>
  new ChainSpendLedger({ connection: fakeConnection(history, o), address: ADDR, ...(local ? { local } : {}), now: () => DAY });

const tmpLedger = () => join(mkdtempSync(join(tmpdir(), "cs-chain-")), "l.json");

describe("ChainSpendLedger", () => {
  it("counts today's on-chain debits and ignores yesterday's", async () => {
    const l = ledger([
      ["sigToday", dayStart + 60, 0.05 * LAMPORTS_PER_SOL],
      ["sigYesterday", dayStart - 3600, 5 * LAMPORTS_PER_SOL],
    ]);
    await l.sync();
    expect(l.chainSpentSol()).toBeCloseTo(0.05, 9);
    expect(l.get().dailySpentSol).toBeCloseTo(0.05, 9);
  });

  it("reports the larger of local and chain, never their sum", async () => {
    const local = new FileSpendLedger(tmpLedger());
    local.add(0.05); // we signed it
    const l = ledger([["sigA", dayStart + 60, 0.05 * LAMPORTS_PER_SOL]], local); // and it landed
    await l.sync();
    expect(l.get().dailySpentSol).toBeCloseTo(0.05, 9);

    local.add(0.02); // signed, not landed yet
    expect(l.get().dailySpentSol).toBeCloseTo(0.07, 9);
  });

  it("DELETING the local ledger no longer resets the cap", async () => {
    const path = tmpLedger();
    const local = new FileSpendLedger(path);
    local.add(0.2);
    expect(local.get().dailySpentSol).toBeCloseTo(0.2, 9);

    // the attacker's move
    unlinkSync(path);
    const freshLocal = new FileSpendLedger(path);
    expect(freshLocal.get().dailySpentSol).toBe(0); // file ledger alone: reset

    // with the chain behind it, the spend is still there
    const l = ledger([["sigA", dayStart + 60, 0.2 * LAMPORTS_PER_SOL]], freshLocal);
    await l.sync();
    expect(l.get().dailySpentSol).toBeCloseTo(0.2, 9);
  });

  it("an RPC failure keeps the last known figure and never lowers it", async () => {
    const l = ledger([["sigA", dayStart + 60, 0.1 * LAMPORTS_PER_SOL]]);
    await l.sync();
    expect(l.chainSpentSol()).toBeCloseTo(0.1, 9);

    const broken = new ChainSpendLedger({ connection: fakeConnection([], { throwOn: "sigs" }), address: ADDR, now: () => DAY });
    // seed it, then break the RPC
    (broken as unknown as { counted: Map<string, bigint> }).counted.set("sigA", BigInt(0.1 * LAMPORTS_PER_SOL));
    (broken as unknown as { countedDay: number }).countedDay = dayStart;
    await broken.sync();
    expect(broken.lastSyncError).toMatch(/429/);
    expect(broken.chainSpentSol()).toBeCloseTo(0.1, 9);
  });

  it("failed transactions contribute nothing", async () => {
    const l = ledger([["sigFailed", dayStart + 60, 2 * LAMPORTS_PER_SOL, true]]);
    await l.sync();
    expect(l.chainSpentSol()).toBe(0);
  });

  it("re-syncing does not double-count a signature", async () => {
    const l = ledger([["sigA", dayStart + 60, 0.1 * LAMPORTS_PER_SOL]]);
    await l.sync();
    await l.sync();
    await l.sync();
    expect(l.chainSpentSol()).toBeCloseTo(0.1, 9);
  });

  it("the wallet syncs the ledger before deciding, so the chain figure bounds the cap", async () => {
    const policy: Policy = {
      version: 1,
      limits: { perTxSol: 0.1, dailySol: 0.25 },
      allowPrograms: [SystemProgram.programId.toBase58()],
      allowRecipients: [allowed.toBase58()],
      allowTokens: ["SOL"],
      blockRecipients: [],
      escalateAboveSol: 0.1,
    };
    // The chain already shows 0.2 spent today; the local ledger is empty (deleted).
    const l = ledger([["sigA", dayStart + 60, 0.2 * LAMPORTS_PER_SOL]], new FileSpendLedger(tmpLedger()));
    const w = new ColdstarWallet({ policy, session, rpcUrl: "http://127.0.0.1:1", ledger: l });
    const tx = new Transaction({ feePayer: session.publicKey, recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k" })
      .add(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: allowed, lamports: 0.1 * LAMPORTS_PER_SOL }));

    // 0.2 (chain) + 0.1 would exceed the 0.25 cap, and evaluateTx syncs first
    const v = await w.evaluateTx(tx);
    expect(v.decision).toBe("ESCALATE");
    expect(v.reason).toMatch(/daily cap/);
  });
});
