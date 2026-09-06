// Coldstar Agent-Safe Signing — chain-derived spend ledger.
//
// THE HOLE THIS CLOSES: FileSpendLedger keeps the day's spend in a local JSON
// file. It refuses to start from a *corrupt* file, but a file that has simply
// been *deleted* looks like a fresh day, so an attacker with write access to
// the agent's host can reset the daily cap with `rm`.
//
// Solana's history cannot be deleted. ChainSpendLedger reads what the session
// wallet actually spent today from the chain and reports the LARGER of that and
// the local figure:
//
//   local  — everything this signer approved, including transactions that have
//            not landed yet. Fast, but erasable.
//   chain  — everything that actually landed, fees included. Lags by a
//            confirmation, but an attacker cannot rewrite it.
//
// max() is the right operator: a transaction counted in both is counted once,
// and neither source can lower the other.
//
// Cost: one getSignaturesForAddress per sync, plus a batched getParsedTransactions
// for signatures not seen before. Steady state is one cheap call per evaluation.

import { Connection, type PublicKey } from "@solana/web3.js";
import { LAMPORTS_PER_SOL, type EvalState } from "../policy/schema.js";
import type { SpendLedger } from "./coldstarWallet.js";
import { InMemorySpendLedger } from "./coldstarWallet.js";

export interface ChainSpendLedgerOptions {
  connection: Connection | string;
  /** The session wallet whose debits are counted. */
  address: PublicKey;
  /** Records what this signer approved, including not-yet-landed transactions. */
  local?: SpendLedger;
  /** Signatures to scan per sync. A busy agent may need more than the default. */
  signatureLimit?: number;
  now?: () => Date;
}

function utcDayStart(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

export class ChainSpendLedger implements SpendLedger {
  private readonly connection: Connection;
  private readonly address: PublicKey;
  private readonly local: SpendLedger;
  private readonly signatureLimit: number;
  private readonly now: () => Date;

  /** Lamports debited from `address` today, per the chain, by signature. */
  private counted = new Map<string, bigint>();
  private countedDay = 0;
  /** Set when the most recent sync could not reach the chain. Callers should log it. */
  lastSyncError: string | undefined;

  constructor(opts: ChainSpendLedgerOptions) {
    this.connection = typeof opts.connection === "string" ? new Connection(opts.connection, "confirmed") : opts.connection;
    this.address = opts.address;
    this.local = opts.local ?? new InMemorySpendLedger();
    this.signatureLimit = opts.signatureLimit ?? 200;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Refresh the chain figure. Called by ColdstarWallet before every evaluation.
   * A failure keeps the previous figure and records `lastSyncError`; it never
   * lowers the number, so an attacker cannot spend more by breaking the RPC.
   */
  async sync(): Promise<void> {
    const dayStart = utcDayStart(this.now());
    if (dayStart !== this.countedDay) {
      this.counted.clear();
      this.countedDay = dayStart;
    }
    try {
      const sigs = await this.connection.getSignaturesForAddress(this.address, { limit: this.signatureLimit }, "confirmed");
      const fresh = sigs
        .filter((s) => !s.err && (s.blockTime ?? 0) >= dayStart && !this.counted.has(s.signature))
        .map((s) => s.signature);
      for (let i = 0; i < fresh.length; i += 25) {
        const chunk = fresh.slice(i, i + 25);
        const txs = await this.connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        txs.forEach((tx, j) => {
          const sig = chunk[j] as string;
          if (!tx || tx.meta?.err) {
            this.counted.set(sig, 0n); // failed transactions move nothing but the fee payer's fee
            return;
          }
          const keys = tx.transaction.message.accountKeys;
          const idx = keys.findIndex((k) => k.pubkey.equals(this.address));
          if (idx < 0 || !tx.meta) {
            this.counted.set(sig, 0n);
            return;
          }
          const pre = BigInt(tx.meta.preBalances[idx] ?? 0);
          const post = BigInt(tx.meta.postBalances[idx] ?? 0);
          this.counted.set(sig, pre > post ? pre - post : 0n);
        });
      }
      this.lastSyncError = undefined;
    } catch (e) {
      this.lastSyncError = (e as Error).message ?? String(e);
    }
  }

  /** SOL debited from the session wallet today, per the chain alone. */
  chainSpentSol(): number {
    let total = 0n;
    for (const v of this.counted.values()) total += v;
    return Number(total) / LAMPORTS_PER_SOL;
  }

  get(): EvalState {
    const localSol = this.local.get().dailySpentSol;
    return { dailySpentSol: Math.max(localSol, this.chainSpentSol()) };
  }

  add(sol: number): void {
    this.local.add(sol);
  }
}
