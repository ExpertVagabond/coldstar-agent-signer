import { TxIntent } from "../policy/schema.js";
export declare const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
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