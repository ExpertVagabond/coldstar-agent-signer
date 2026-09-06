// Coldstar Agent-Safe Signing — on-chain revocation.
//
// WHAT THIS STOPS, AND WHAT IT DOES NOT
//
// A policy envelope is a grant with an expiry. Revocation cancels one early.
// The check has to live somewhere an attacker cannot quietly remove, so it
// lives on Solana: an authority publishes a signed memo transaction naming the
// session key, and the signer reads the chain before every decision.
//
//   Stops: a compromised AGENT — the case this whole package exists for. A
//   prompt-injected or hijacked agent proposes transactions THROUGH the signer,
//   so once the grant is revoked on chain the signer refuses everything, and no
//   amount of local file tampering brings it back.
//
//   Does NOT stop: an attacker who has exfiltrated the session SECRET KEY. They
//   do not need this package at all — they can sign with web3.js directly. No
//   off-chain control can help there, and neither can this one. The answer to a
//   leaked secret key is to hold funds behind an on-chain program that enforces
//   membership itself (Squads spending limits are the production option on
//   Solana), so the key alone cannot move anything. Revocation here bounds the
//   agent, not a stolen key. See docs and the README; we would rather say this
//   plainly than let it be assumed.
//
// Authority: the ROOT may always revoke. An envelope (version 2) may also name
// a REVOKER — a hot key that can publish revocations but has no spending power,
// so an emergency stop does not require a trip to the safe.
//
// Cost: one getSignaturesForAddress per authority per check, cached. The memo
// text comes back on that call, so the common case (no revocation) costs
// nothing more. A candidate memo is verified by fetching that one transaction
// and confirming the authority actually signed it.

import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

/** SPL Memo v2. */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** The exact on-chain marker that revokes a session key. */
export function revocationMemo(sessionPubkey: string): string {
  return `coldstar:revoke:v1:${sessionPubkey}`;
}

/**
 * Build the revocation transaction. Sign it with the root (on the air-gapped
 * machine) or with the envelope's revoker (a hot key with no spending power),
 * then broadcast. It moves no value; it only writes the marker.
 */
export function buildRevocationTransaction(args: {
  authority: PublicKey;
  sessionPubkey: string;
  recentBlockhash: string;
}): Transaction {
  const tx = new Transaction({ feePayer: args.authority, recentBlockhash: args.recentBlockhash });
  tx.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: args.authority, isSigner: true, isWritable: false }],
      data: Buffer.from(revocationMemo(args.sessionPubkey), "utf8"),
    }),
  );
  return tx;
}

export type RevocationStatus =
  | { state: "active"; checkedAt: number }
  | { state: "revoked"; by: string; signature: string; checkedAt: number }
  | { state: "unknown"; reason: string; checkedAt: number };

export interface RevocationCheckerOptions {
  connection: Connection | string;
  /** The session key whose grant may be revoked. */
  sessionPubkey: string;
  /** Keys allowed to revoke: the root, plus the envelope's revoker if it names one. */
  authorities: string[];
  /** How long a successful check stays fresh. Default 60s. */
  freshnessMs?: number;
  /** Signatures to scan per authority. Default 100. */
  signatureLimit?: number;
  now?: () => number;
}

/**
 * Reads the chain to answer "is this grant still live?".
 *
 * Fail-closed by design: `status()` returns `unknown` when the chain cannot be
 * reached or the last good answer has gone stale, and the wallet escalates on
 * `unknown` rather than signing. An attacker who cuts the signer off from RPC
 * stops the agent; they do not free it.
 */
export class RevocationChecker {
  private readonly connection: Connection;
  private readonly sessionPubkey: string;
  private readonly authorities: PublicKey[];
  private readonly freshnessMs: number;
  private readonly signatureLimit: number;
  private readonly now: () => number;
  private last: RevocationStatus | undefined;

  constructor(opts: RevocationCheckerOptions) {
    this.connection = typeof opts.connection === "string" ? new Connection(opts.connection, "confirmed") : opts.connection;
    this.sessionPubkey = opts.sessionPubkey;
    this.authorities = opts.authorities.map((a) => new PublicKey(a));
    this.freshnessMs = opts.freshnessMs ?? 60_000;
    this.signatureLimit = opts.signatureLimit ?? 100;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Cached status; refreshes when stale. Revocation is permanent and never re-checked. */
  async status(): Promise<RevocationStatus> {
    if (this.last?.state === "revoked") return this.last;
    if (this.last?.state === "active" && this.now() - this.last.checkedAt < this.freshnessMs) return this.last;
    this.last = await this.check();
    return this.last;
  }

  private async check(): Promise<RevocationStatus> {
    const marker = revocationMemo(this.sessionPubkey);
    const at = this.now();
    try {
      for (const authority of this.authorities) {
        const sigs = await this.connection.getSignaturesForAddress(authority, { limit: this.signatureLimit }, "confirmed");
        // getSignaturesForAddress returns the memo as "[<len>] <text>".
        const candidates = sigs.filter((s) => !s.err && typeof s.memo === "string" && s.memo.includes(marker));
        for (const c of candidates) {
          // The listing only proves the authority was REFERENCED. Confirm it signed.
          const tx = await this.connection.getTransaction(c.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          if (!tx || tx.meta?.err) continue;
          const keys = tx.transaction.message.staticAccountKeys ?? [];
          const required = tx.transaction.message.header.numRequiredSignatures;
          const signed = keys.slice(0, required).some((k) => k.equals(authority));
          if (signed) {
            return { state: "revoked", by: authority.toBase58(), signature: c.signature, checkedAt: at };
          }
        }
      }
      return { state: "active", checkedAt: at };
    } catch (e) {
      return { state: "unknown", reason: (e as Error).message ?? String(e), checkedAt: at };
    }
  }
}
