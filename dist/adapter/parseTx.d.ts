import { TxIntent } from "../policy/schema.js";
export declare const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export declare const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export declare const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export declare const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export declare const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export declare const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export declare const MEMO_LEGACY_PROGRAM_ID = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
/** Squads Protocol v4 multisig, mainnet and devnet. */
export declare const SQUADS_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
/**
 * The subset of a decompiled message this decoder needs. Deliberately
 * structural: it matches @solana/kit's decompiled instruction shape
 * (`{ programAddress, accounts: [{ address }], data: Uint8Array }`) without
 * importing it, so the security-critical decode has no dependency surface.
 */
export interface CompiledInstruction {
    programAddress: string;
    accounts?: readonly {
        readonly address: string;
    }[];
    data?: Uint8Array;
}
export interface DecompiledMessage {
    /** The wallet whose SOL is at risk — value leaving THIS account is what counts. */
    feePayer: string;
    instructions: readonly CompiledInstruction[];
}
export type ParseResult = {
    ok: true;
    intent: TxIntent;
} | {
    ok: false;
    reason: string;
};
/**
 * Parse a decompiled message into a TxIntent.
 *
 * Callers MUST treat `{ ok: false }` as ESCALATE. It means "this transaction
 * could not be fully accounted for", which is not the same as "it is safe".
 */
export declare function parseTx(message: DecompiledMessage): ParseResult;
/**
 * Seam for the real SDK. @solana/kit's `decompileTransactionMessage` yields
 * instructions shaped like `CompiledInstruction` above, so this is a shallow
 * projection rather than a second decoder — keeping the kit dependency out of
 * the security-critical path.
 */
export declare function fromKitTransaction(kitMessage: {
    feePayer: string | {
        address: string;
    };
    instructions: readonly CompiledInstruction[];
}): ParseResult;
//# sourceMappingURL=parseTx.d.ts.map