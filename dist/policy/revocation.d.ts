import { Connection, PublicKey, Transaction } from "@solana/web3.js";
/** SPL Memo v2. */
export declare const MEMO_PROGRAM_ID: PublicKey;
/** The exact on-chain marker that revokes a session key. */
export declare function revocationMemo(sessionPubkey: string): string;
/**
 * Build the revocation transaction. Sign it with the root (on the air-gapped
 * machine) or with the envelope's revoker (a hot key with no spending power),
 * then broadcast. It moves no value; it only writes the marker.
 */
export declare function buildRevocationTransaction(args: {
    authority: PublicKey;
    sessionPubkey: string;
    recentBlockhash: string;
}): Transaction;
export type RevocationStatus = {
    state: "active";
    checkedAt: number;
} | {
    state: "revoked";
    by: string;
    signature: string;
    checkedAt: number;
} | {
    state: "unknown";
    reason: string;
    checkedAt: number;
};
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
export declare class RevocationChecker {
    private readonly connection;
    private readonly sessionPubkey;
    private readonly authorities;
    private readonly freshnessMs;
    private readonly signatureLimit;
    private readonly now;
    private last;
    constructor(opts: RevocationCheckerOptions);
    /** Cached status; refreshes when stale. Revocation is permanent and never re-checked. */
    status(): Promise<RevocationStatus>;
    private check;
}
//# sourceMappingURL=revocation.d.ts.map