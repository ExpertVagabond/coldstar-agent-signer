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
  VersionedTransaction,
} from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "../policy/schema.js";
import nacl from "tweetnacl";
import { evaluate } from "../policy/evaluate.js";
import type { Decision, EvalState, Policy, TxIntent } from "../policy/schema.js";
import { parseTx } from "../adapter/parseTx.js";
import { isVersionedTransaction, projectTransaction } from "./project.js";
import { SYSTEM_PROGRAM_ID } from "../adapter/parseTx.js";
import type { Simulator } from "./simulate.js";
import { verifyPolicyEnvelope, type PolicyEnvelope } from "../policy/envelope.js";
import { RevocationChecker } from "../policy/revocation.js";

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
  /**
   * Optional: refresh from an external source before `get()` is trusted.
   * Awaited by `evaluateTx` when present — see ChainSpendLedger, which reads
   * the day's real spend off the chain so deleting a local file cannot reset
   * the cap.
   */
  sync?(): Promise<void>;
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
  /**
   * Posture (b): simulation-based accounting. A transaction through an
   * allowlisted non-System program (a Jupiter swap, say) cannot be statically
   * decoded to a SOL amount, so by default the program allowlist is the only
   * control. With a simulator configured, the fee payer's simulated debit is
   * measured and the LARGER of the static and simulated amounts is what the
   * limits and daily cap see. Simulation failure escalates (fail-closed).
   *   when: "opaque" (default) simulates only when a non-System program is
   *         present; "always" simulates every transaction.
   */
  preflight?: { simulate: Simulator; when?: "opaque" | "always" };
  /**
   * On-chain revocation. When set, every decision first asks the chain whether
   * this grant is still live. Revoked is a hard REJECT; a chain the signer
   * cannot reach is an ESCALATE, so cutting the signer off from RPC stops the
   * agent rather than freeing it.
   */
  revocation?: RevocationChecker;
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
  /** Set when the wallet was built from a root-signed envelope. */
  readonly envelope: PolicyEnvelope | undefined;
  private readonly policy: Policy;
  private readonly session: SessionSigner;
  private readonly rpcUrl: string;
  private readonly ledger: SpendLedger;
  private readonly onEscalate: EscalationHandler;
  private readonly allowMessageSigning: boolean;
  private readonly onDecision: ColdstarWalletOptions["onDecision"];
  private readonly preflight: ColdstarWalletOptions["preflight"];
  private readonly revocation: RevocationChecker | undefined;

  /**
   * Build a wallet from a ROOT-SIGNED policy envelope. Verifies the root's
   * signature, that the envelope names this session key, and expiry, and
   * throws otherwise: an edited policy or an unauthorised session key never
   * gets a running signer. Pin `expectedRoot` in anything beyond a demo.
   */
  static fromEnvelope(
    opts: Omit<ColdstarWalletOptions, "policy"> & {
      envelope: unknown;
      expectedRoot?: string;
      now?: Date;
      /** true: check revocation on chain, using the root and the envelope's revoker as authorities. */
      checkRevocation?: boolean;
    },
  ): ColdstarWallet {
    const check = verifyPolicyEnvelope(opts.envelope, {
      sessionPubkey: opts.session.publicKey.toBase58(),
      ...(opts.expectedRoot ? { expectedRoot: opts.expectedRoot } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    if (!check.ok) throw new Error(`Coldstar: refusing to start — ${check.reason}`);
    const { envelope: _e, expectedRoot: _r, now: _n, checkRevocation, ...rest } = opts;
    const env = check.envelope;
    const revocation =
      rest.revocation ??
      (checkRevocation
        ? new RevocationChecker({
            connection: rest.rpcUrl,
            sessionPubkey: env.sessionPubkey,
            authorities: [env.rootPubkey, ...(env.revoker ? [env.revoker] : [])],
          })
        : undefined);
    return new ColdstarWallet({ ...rest, policy: env.policy, ...(revocation ? { revocation } : {}) }, env);
  }

  constructor(opts: ColdstarWalletOptions, envelope?: PolicyEnvelope) {
    this.envelope = envelope;
    this.policy = opts.policy;
    this.session = opts.session;
    this.publicKey = opts.session.publicKey;
    this.rpcUrl = opts.rpcUrl;
    this.ledger = opts.ledger ?? new InMemorySpendLedger();
    this.onEscalate = opts.onEscalate ?? defaultEscalate;
    this.allowMessageSigning = opts.allowMessageSigning ?? false;
    this.onDecision = opts.onDecision;
    this.preflight = opts.preflight;
    this.revocation = opts.revocation;
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

  /** SOL signed so far in the current UTC day, per the ledger. */
  dailySpentSol(): number {
    return this.ledger.get().dailySpentSol;
  }

  /**
   * The full evaluation `sign*` uses: the static verdict, plus simulation-based
   * accounting when `preflight` is configured. The returned intent carries the
   * EFFECTIVE outSol (max of static and simulated), which is what the ledger
   * records on AUTO_SIGN.
   */
  async evaluateTx(tx: SolanaTx, extraSpendSol = 0): Promise<Verdict> {
    // Revocation first: a cancelled grant signs nothing, whatever the policy says.
    if (this.revocation) {
      const r = await this.revocation.status();
      if (r.state === "revoked") {
        return { decision: "REJECT", reason: `grant revoked on chain by ${r.by} (${r.signature.slice(0, 8)}…)`, intent: undefined };
      }
      if (r.state === "unknown") {
        return { decision: "ESCALATE", reason: `cannot confirm the grant is still live: ${r.reason}`, intent: undefined };
      }
    }
    // A ledger backed by an external source (the chain) refreshes here, before
    // any verdict reads it.
    await this.ledger.sync?.();
    const v = this.verdict(tx, extraSpendSol);
    if (!this.preflight || v.decision === "REJECT" || !v.intent) return v;
    const opaque = v.intent.instructions.some((ix) => ix.programId !== SYSTEM_PROGRAM_ID);
    if ((this.preflight.when ?? "opaque") === "opaque" && !opaque) return v;

    const vtx = isVersionedTransaction(tx) ? tx : new VersionedTransaction(tx.compileMessage());
    const sim = await this.preflight.simulate(vtx, this.publicKey).catch((e: unknown) => ({
      ok: false as const,
      reason: `simulator threw: ${(e as Error).message ?? String(e)}`,
    }));
    if (!sim.ok) {
      return { decision: "ESCALATE", reason: `simulation failed: ${sim.reason}`, intent: v.intent };
    }
    const simulatedSol = Number(sim.debitLamports) / LAMPORTS_PER_SOL;
    if (simulatedSol <= v.intent.outSol) return v; // static accounting already covers it
    const intent: TxIntent = { ...v.intent, outSol: simulatedSol };
    const state = this.ledger.get();
    const r = evaluate(intent, this.policy, { dailySpentSol: state.dailySpentSol + extraSpendSol });
    return { decision: r.decision, reason: `${r.reason} (simulated debit ${simulatedSol} SOL)`, intent };
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
    // Idempotence: a transaction that already carries a valid session signature over
    // its current message bytes is returned as-is — not re-evaluated, not re-counted.
    // Re-signing identical bytes creates no new spending power, so a retry loop that
    // calls signTransaction twice must not drain the daily cap twice.
    const fresh = transactions.filter((tx) => !this.alreadySignedBySession(tx));
    const verdicts: Verdict[] = [];
    let pending = 0;
    for (const tx of fresh) {
      const v = await this.evaluateTx(tx, pending);
      verdicts.push(v);
      if (v.decision === "AUTO_SIGN") pending += v.intent?.outSol ?? 0;
    }

    const rejected = verdicts.find((v) => v.decision === "REJECT");
    if (rejected) {
      this.onDecision?.(rejected);
      throw new ColdstarRejected(rejected.reason, rejected.intent);
    }

    const out: T[] = [];
    let vi = 0;
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i] as T;
      if (!fresh.includes(tx)) {
        out.push(tx); // already signed by us; pass through
        continue;
      }
      const v = verdicts[vi++] as Verdict;
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

  /** True if `tx` already carries a valid signature by the session key over its current message. */
  private alreadySignedBySession(tx: SolanaTx): boolean {
    const pub = this.session.publicKey;
    if (isVersionedTransaction(tx)) {
      const keys = tx.message.staticAccountKeys;
      const n = tx.message.header.numRequiredSignatures;
      for (let i = 0; i < n; i++) {
        if (keys[i]?.equals(pub)) {
          const sig = tx.signatures[i];
          return !!sig && sig.some((b) => b !== 0) && nacl.sign.detached.verify(tx.message.serialize(), sig, pub.toBytes());
        }
      }
      return false;
    }
    const entry = tx.signatures.find((s) => s.publicKey.equals(pub));
    if (!entry || !entry.signature) return false;
    return nacl.sign.detached.verify(tx.serializeMessage(), entry.signature, pub.toBytes());
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
  return base64(bytes);
}

// Dependency-free base64 so this file needs neither Node's Buffer nor the DOM lib.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number, b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += b === undefined ? "=" : B64.charAt((n >> 6) & 63);
    out += c === undefined ? "=" : B64.charAt(n & 63);
  }
  return out;
}
