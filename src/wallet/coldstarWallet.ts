// Coldstar Agent-Safe Signing — the wallet an agent framework actually holds.
//
// `ColdstarWallet` is structurally compatible with Solana Agent Kit's
// `BaseWallet` (publicKey, signTransaction, signAllTransactions,
// signAndSendTransaction, sendTransaction, signMessage), so it drops in where
// `KeypairWallet` would. The difference is what happens inside `sign*`:
//
//   tx ──project──▶ DecompiledMessage ──parseTx──▶ TxIntent ──evaluate──▶
//        AUTO_SIGN  → sign with the SESSION key (never the root)
//        ESCALATE   → hand the unsigned tx to the escalation handler (air-gap/QR);
//                     default handler throws ColdstarEscalation — no signature
//        REJECT     → throw ColdstarRejected — no signature, ever
//
// A parse or projection failure is treated as ESCALATE, per parseTx's contract:
// "could not be accounted for" is not "safe".
//
// Nothing here imports Solana Agent Kit. The interface is copied structurally
// so this package has no dependency on the framework and works with any
// caller that speaks web3.js transactions.

import {
  Connection,
  type Keypair,
  type PublicKey,
  type SendOptions,
  type Transaction,
  type TransactionSignature,
  type VersionedTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { evaluate } from "../policy/evaluate";
import type { Decision, EvalState, Policy, TxIntent } from "../policy/schema";
import { parseTx } from "../adapter/parseTx";
import { isVersionedTransaction, projectTransaction } from "./project";

export type SolanaTx = Transaction | VersionedTransaction;

/** Structural copy of Solana Agent Kit's BaseWallet — no import needed. */
export interface BaseWalletLike {
  readonly publicKey: PublicKey;
  signTransaction<T extends SolanaTx>(transaction: T): Promise<T>;
  signAllTransactions<T extends SolanaTx>(transactions: T[]): Promise<T[]>;
  sendTransaction?: <T extends SolanaTx>(transaction: T) => Promise<string>;
  signAndSendTransaction: <T extends SolanaTx>(
    transaction: T,
    options?: SendOptions,
  ) => Promise<{ signature: TransactionSignature }>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * The session signer. In the MVP this is a web3.js Keypair authorised by the
 * cold root (the root signs the policy envelope offline; this key acts inside
 * it). It is disposable: rotate it and the root never moves.
 */
export type SessionSigner = Keypair;

/**
 * Called on ESCALATE with the still-unsigned transaction. Return the signed
 * transaction if a human approved it out-of-band (air-gapped QR round-trip),
 * or return `null` to decline. The default handler throws `ColdstarEscalation`.
 */
export type EscalationHandler = <T extends SolanaTx>(
  tx: T,
  reason: string,
  intent: TxIntent | undefined,
) => Promise<T | null>;

/** Where the daily-spend counter lives. In-memory by default; inject to persist. */
export interface SpendLedger {
  /** Running SOL spent in the current UTC day. */
  get(): EvalState;
  /** Record a spend that was actually signed. */
  add(sol: number): void;
}

export class InMemorySpendLedger implements SpendLedger {
  private day = utcDay();
  private spent = 0;
  constructor(private readonly now: () => Date = () => new Date()) {}
  get(): EvalState {
    this.roll();
    return { dailySpentSol: this.spent };
  }
  add(sol: number): void {
    this.roll();
    this.spent += sol;
  }
  private roll(): void {
    const d = utcDay(this.now());
    if (d !== this.day) {
      this.day = d;
      this.spent = 0;
    }
  }
}

function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class ColdstarRejected extends Error {
  override readonly name = "ColdstarRejected";
  readonly decision: Decision = "REJECT";
  constructor(public readonly reason: string, public readonly intent: TxIntent | undefined) {
    super(`Coldstar policy REJECT: ${reason}`);
  }
}

export class ColdstarEscalation extends Error {
  override readonly name = "ColdstarEscalation";
  readonly decision: Decision = "ESCALATE";
  constructor(
    public readonly reason: string,
    public readonly intent: TxIntent | undefined,
    /** base64 of the UNSIGNED transaction, for the air-gapped hand-off (QR). */
    public readonly unsignedTxBase64: string,
  ) {
    super(`Coldstar policy ESCALATE: ${reason}`);
  }
}

export interface ColdstarWalletOptions {
  policy: Policy;
  session: SessionSigner;
  rpcUrl: string;
  ledger?: SpendLedger;
  onEscalate?: EscalationHandler;
  /**
   * Off-chain message signing (SIWS, order signatures) can authorise things the
   * transaction policy never sees. Off by default; enable deliberately.
   */
  allowMessageSigning?: boolean;
  /** Observability hook — every decision, including AUTO_SIGN. */
  onDecision?: (d: Verdict) => void;
}

/** What the wallet decided for one transaction, before any signing happens. */
export interface Verdict {
  decision: Decision;
  reason: string;
  /** Undefined when the transaction could not be projected/parsed (always ESCALATE). */
  intent: TxIntent | undefined;
}

export class ColdstarWallet implements BaseWalletLike {
  readonly publicKey: PublicKey;
  private readonly policy: Policy;
  private readonly session: SessionSigner;
  private readonly rpcUrl: string;
  private readonly ledger: SpendLedger;
  private readonly onEscalate: EscalationHandler;
  private readonly allowMessageSigning: boolean;
  private readonly onDecision: ColdstarWalletOptions["onDecision"];

  constructor(opts: ColdstarWalletOptions) {
    this.policy = opts.policy;
    this.session = opts.session;
    this.publicKey = opts.session.publicKey;
    this.rpcUrl = opts.rpcUrl;
    this.ledger = opts.ledger ?? new InMemorySpendLedger();
    this.onEscalate = opts.onEscalate ?? defaultEscalate;
    this.allowMessageSigning = opts.allowMessageSigning ?? false;
    this.onDecision = opts.onDecision;
  }

  /**
   * Evaluate without signing. Pure with respect to the ledger (reads only).
   * Exposed so an agent can pre-flight a plan and so tests can assert on it.
   */
  verdict(tx: SolanaTx, extraSpendSol = 0): Verdict {
    const projected = projectTransaction(tx);
    if (!projected.ok) return { decision: "ESCALATE", reason: projected.reason, intent: undefined };
    const parsed = parseTx(projected.message);
    if (!parsed.ok) return { decision: "ESCALATE", reason: parsed.reason, intent: undefined };
    const state = this.ledger.get();
    const r = evaluate(parsed.intent, this.policy, {
      dailySpentSol: state.dailySpentSol + extraSpendSol,
    });
    return { decision: r.decision, reason: r.reason, intent: parsed.intent };
  }

  async signTransaction<T extends SolanaTx>(transaction: T): Promise<T> {
    const [signed] = await this.signAllTransactions([transaction]);
    return signed as T;
  }

  /**
   * Batch semantics: every transaction is evaluated first, with the daily cap
   * accumulating across the batch, and NOTHING is signed if any one of them is
   * REJECTED. Escalations are handled per transaction after the batch clears.
   */
  async signAllTransactions<T extends SolanaTx>(transactions: T[]): Promise<T[]> {
    const verdicts: Verdict[] = [];
    let pending = 0;
    for (const tx of transactions) {
      const v = this.verdict(tx, pending);
      verdicts.push(v);
      if (v.decision === "AUTO_SIGN") pending += v.intent?.outSol ?? 0;
    }

    const rejected = verdicts.find((v) => v.decision === "REJECT");
    if (rejected) {
      this.onDecision?.(rejected);
      throw new ColdstarRejected(rejected.reason, rejected.intent);
    }

    const out: T[] = [];
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i] as T;
      const v = verdicts[i] as Verdict;
      this.onDecision?.(v);
      if (v.decision === "AUTO_SIGN") {
        this.signWithSession(tx);
        this.ledger.add(v.intent?.outSol ?? 0);
        out.push(tx);
        continue;
      }
      // ESCALATE
      const approved = await this.onEscalate(tx, v.reason, v.intent);
      if (approved === null) {
        throw new ColdstarEscalation(v.reason, v.intent, serializeUnsigned(tx));
      }
      // A human approved it on the cold side; count the spend, pass it through.
      this.ledger.add(v.intent?.outSol ?? 0);
      out.push(approved);
    }
    return out;
  }

  async sendTransaction<T extends SolanaTx>(transaction: T): Promise<string> {
    const { signature } = await this.signAndSendTransaction(transaction);
    return signature;
  }

  async signAndSendTransaction<T extends SolanaTx>(
    transaction: T,
    options?: SendOptions,
  ): Promise<{ signature: TransactionSignature }> {
    const signed = await this.signTransaction(transaction);
    const connection = new Connection(this.rpcUrl);
    const signature = await connection.sendRawTransaction(signed.serialize(), options);
    return { signature };
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.allowMessageSigning) {
      const reason = "off-chain message signing is disabled by policy (allowMessageSigning=false)";
      this.onDecision?.({ decision: "REJECT", reason, intent: undefined });
      throw new ColdstarRejected(reason, undefined);
    }
    return nacl.sign.detached(message, this.session.secretKey);
  }

  private signWithSession(tx: SolanaTx): void {
    if (isVersionedTransaction(tx)) tx.sign([this.session]);
    else tx.partialSign(this.session);
  }
}

const defaultEscalate: EscalationHandler = async () => null;

function serializeUnsigned(tx: SolanaTx): string {
  const bytes = isVersionedTransaction(tx)
    ? tx.serialize()
    : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return Buffer.from(bytes).toString("base64");
}
