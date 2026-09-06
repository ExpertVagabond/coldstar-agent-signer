import { Connection, type PublicKey } from "@solana/web3.js";
import { type EvalState } from "../policy/schema.js";
import type { SpendLedger } from "./coldstarWallet.js";
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
export declare class ChainSpendLedger implements SpendLedger {
    private readonly connection;
    private readonly address;
    private readonly local;
    private readonly signatureLimit;
    private readonly now;
    /** Lamports debited from `address` today, per the chain, by signature. */
    private counted;
    /** Token base units debited today, by signature then mint. */
    private countedTokens;
    private countedDay;
    /** Set when the most recent sync could not reach the chain. Callers should log it. */
    lastSyncError: string | undefined;
    constructor(opts: ChainSpendLedgerOptions);
    /**
     * Refresh the chain figure. Called by ColdstarWallet before every evaluation.
     * A failure keeps the previous figure and records `lastSyncError`; it never
     * lowers the number, so an attacker cannot spend more by breaking the RPC.
     */
    sync(): Promise<void>;
    /** SOL debited from the session wallet today, per the chain alone. */
    chainSpentSol(): number;
    /** Base units debited per mint today, per the chain alone. */
    chainSpentByMint(): Record<string, bigint>;
    get(): EvalState;
    add(sol: number): void;
    addToken(mint: string, baseUnits: bigint): void;
}
//# sourceMappingURL=chainLedger.d.ts.map