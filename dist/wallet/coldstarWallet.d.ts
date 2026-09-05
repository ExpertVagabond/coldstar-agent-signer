import { type Keypair, type PublicKey, type SendOptions, type Transaction, type TransactionSignature, VersionedTransaction } from "@solana/web3.js";
import type { Decision, EvalState, Policy, TxIntent } from "../policy/schema.js";
import type { Simulator } from "./simulate.js";
import { type PolicyEnvelope } from "../policy/envelope.js";
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
    preflight?: {
        simulate: Simulator;
        when?: "opaque" | "always";
    };
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
    /** Set when the wallet was built from a root-signed envelope. */
    readonly envelope: PolicyEnvelope | undefined;
    private readonly policy;
    private readonly session;
    private readonly rpcUrl;
    private readonly ledger;
    private readonly onEscalate;
    private readonly allowMessageSigning;
    private readonly onDecision;
    private readonly preflight;
    /**
     * Build a wallet from a ROOT-SIGNED policy envelope. Verifies the root's
     * signature, that the envelope names this session key, and expiry, and
     * throws otherwise: an edited policy or an unauthorised session key never
     * gets a running signer. Pin `expectedRoot` in anything beyond a demo.
     */
    static fromEnvelope(opts: Omit<ColdstarWalletOptions, "policy"> & {
        envelope: unknown;
        expectedRoot?: string;
        now?: Date;
    }): ColdstarWallet;
    constructor(opts: ColdstarWalletOptions, envelope?: PolicyEnvelope);
    /**
     * Evaluate without signing. Pure with respect to the ledger (reads only).
     * Exposed so an agent can pre-flight a plan and so tests can assert on it.
     */
    verdict(tx: SolanaTx, extraSpendSol?: number): Verdict;
    /** SOL signed so far in the current UTC day, per the ledger. */
    dailySpentSol(): number;
    /**
     * The full evaluation `sign*` uses: the static verdict, plus simulation-based
     * accounting when `preflight` is configured. The returned intent carries the
     * EFFECTIVE outSol (max of static and simulated), which is what the ledger
     * records on AUTO_SIGN.
     */
    evaluateTx(tx: SolanaTx, extraSpendSol?: number): Promise<Verdict>;
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
    /** True if `tx` already carries a valid signature by the session key over its current message. */
    private alreadySignedBySession;
    private signWithSession;
}
//# sourceMappingURL=coldstarWallet.d.ts.map