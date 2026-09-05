import { type Keypair, type PublicKey, type SendOptions, type Transaction, type TransactionSignature, type VersionedTransaction } from "@solana/web3.js";
import type { Decision, EvalState, Policy, TxIntent } from "../policy/schema.js";
export type SolanaTx = Transaction | VersionedTransaction;
/** Structural copy of Solana Agent Kit's BaseWallet — no import needed. */
export interface BaseWalletLike {
    readonly publicKey: PublicKey;
    signTransaction<T extends SolanaTx>(transaction: T): Promise<T>;
    signAllTransactions<T extends SolanaTx>(transactions: T[]): Promise<T[]>;
    sendTransaction?: <T extends SolanaTx>(transaction: T) => Promise<string>;
    signAndSendTransaction: <T extends SolanaTx>(transaction: T, options?: SendOptions) => Promise<{
        signature: TransactionSignature;
    }>;
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
export type EscalationHandler = <T extends SolanaTx>(tx: T, reason: string, intent: TxIntent | undefined) => Promise<T | null>;
/** Where the daily-spend counter lives. In-memory by default; inject to persist. */
export interface SpendLedger {
    /** Running SOL spent in the current UTC day. */
    get(): EvalState;
    /** Record a spend that was actually signed. */
    add(sol: number): void;
}
export declare class InMemorySpendLedger implements SpendLedger {
    private readonly now;
    private day;
    private spent;
    constructor(now?: () => Date);
    get(): EvalState;
    add(sol: number): void;
    private roll;
}
export declare class ColdstarRejected extends Error {
    readonly reason: string;
    readonly intent: TxIntent | undefined;
    readonly name = "ColdstarRejected";
    readonly decision: Decision;
    constructor(reason: string, intent: TxIntent | undefined);
}
export declare class ColdstarEscalation extends Error {
    readonly reason: string;
    readonly intent: TxIntent | undefined;
    /** base64 of the UNSIGNED transaction, for the air-gapped hand-off (QR). */
    readonly unsignedTxBase64: string;
    readonly name = "ColdstarEscalation";
    readonly decision: Decision;
    constructor(reason: string, intent: TxIntent | undefined, 
    /** base64 of the UNSIGNED transaction, for the air-gapped hand-off (QR). */
    unsignedTxBase64: string);
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
export declare class ColdstarWallet implements BaseWalletLike {
    readonly publicKey: PublicKey;
    private readonly policy;
    private readonly session;
    private readonly rpcUrl;
    private readonly ledger;
    private readonly onEscalate;
    private readonly allowMessageSigning;
    private readonly onDecision;
    constructor(opts: ColdstarWalletOptions);
    /**
     * Evaluate without signing. Pure with respect to the ledger (reads only).
     * Exposed so an agent can pre-flight a plan and so tests can assert on it.
     */
    verdict(tx: SolanaTx, extraSpendSol?: number): Verdict;
    /** SOL signed so far in the current UTC day, per the ledger. */
    dailySpentSol(): number;
    signTransaction<T extends SolanaTx>(transaction: T): Promise<T>;
    /**
     * Batch semantics: every transaction is evaluated first, with the daily cap
     * accumulating across the batch, and NOTHING is signed if any one of them is
     * REJECTED. Escalations are handled per transaction after the batch clears.
     */
    signAllTransactions<T extends SolanaTx>(transactions: T[]): Promise<T[]>;
    sendTransaction<T extends SolanaTx>(transaction: T): Promise<string>;
    signAndSendTransaction<T extends SolanaTx>(transaction: T, options?: SendOptions): Promise<{
        signature: TransactionSignature;
    }>;
    signMessage(message: Uint8Array): Promise<Uint8Array>;
    private signWithSession;
}
//# sourceMappingURL=coldstarWallet.d.ts.map