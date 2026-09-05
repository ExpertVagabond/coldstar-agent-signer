import type { EscalationHandler, SolanaTx } from "../wallet/coldstarWallet.js";
/** Always decline. The wallet then throws ColdstarEscalation with the payload. */
export declare const declineEscalation: EscalationHandler;
export declare function serializeUnsigned(tx: SolanaTx): Uint8Array;
/**
 * Parse whatever the air-gapped side handed back and make sure it is the same
 * transaction (same message bytes) now carrying at least one signature.
 * Returns null if it is not.
 */
export declare function acceptSignedResponse<T extends SolanaTx>(original: T, signedBase64: string): T | null;
/**
 * Interactive terminal hand-off: print the unsigned transaction, wait for the
 * operator to paste the signed transaction (as returned by the cold device),
 * verify it is the same message, and return it. Empty input declines.
 */
export declare function terminalEscalation(io: {
    write: (s: string) => void;
    readLine: () => Promise<string>;
    render?: (base64: string) => void;
}): EscalationHandler;
//# sourceMappingURL=escalate.d.ts.map