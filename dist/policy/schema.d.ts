export type Decision = "AUTO_SIGN" | "ESCALATE" | "REJECT";
export declare const LAMPORTS_PER_SOL = 1000000000;
export interface Policy {
    version: number;
    limits: {
        perTxSol: number;
        dailySol: number;
    };
    allowPrograms: string[];
    allowRecipients: string[];
    /**
     * Which assets may move: the literal "SOL", and/or SPL mint addresses.
     * ENFORCED — a token movement whose mint is not listed escalates. (Before
     * 0.3.0 this field was declared and never read; a policy could say "SOL"
     * while an allowlisted Token program moved USDC without limit.)
     */
    allowTokens: string[];
    /**
     * Per-mint limits in BASE UNITS, as decimal strings (USDC has 6 decimals, so
     * "10000000" is 10 USDC). A mint in `allowTokens` with no entry here is
     * bounded only by the allowlists, so set one for anything that matters.
     */
    tokenLimits?: Record<string, {
        perTx?: string;
        daily?: string;
    }>;
    /**
     * Destination TOKEN ACCOUNTS the agent may pay. Usually left unset: the
     * wallet derives the associated token account of every allowRecipients ×
     * allowTokens pair and adds them, so ordinary payments to allowlisted people
     * work without listing token accounts by hand.
     */
    allowTokenAccounts?: string[];
    blockRecipients: string[];
    escalateAboveSol: number;
}
/**
 * SPL token value leaving the wallet. `mint` is undefined for a bare Token
 * `Transfer`, whose account list does not include the mint — that is why a bare
 * Transfer cannot be attributed to a token statically and must escalate.
 * Amounts are BASE UNITS (a bigint), never floats: USDC has 6 decimals and
 * float arithmetic on money is how rounding bugs become losses.
 */
export interface TokenMovement {
    mint?: string;
    amount: bigint;
    decimals?: number;
    /** The destination TOKEN ACCOUNT (not the owner's wallet address). */
    destination?: string;
    source?: string;
}
export interface TxInstruction {
    programId: string;
    recipient?: string;
    lamports?: number;
}
export interface TxIntent {
    instructions: TxInstruction[];
    outSol: number;
    recipients: string[];
    /** SPL token value leaving the wallet, one entry per decoded instruction. */
    tokenMovements: TokenMovement[];
}
export interface EvalState {
    dailySpentSol: number;
    /** Base units spent per mint in the current UTC day, as decimal strings. */
    dailySpentByMint?: Record<string, string>;
}
export interface EvalResult {
    decision: Decision;
    reason: string;
}
//# sourceMappingURL=schema.d.ts.map