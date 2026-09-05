import { Transaction, VersionedTransaction } from "@solana/web3.js";
import type { DecompiledMessage } from "../adapter/parseTx.js";
export type ProjectResult = {
    ok: true;
    message: DecompiledMessage;
} | {
    ok: false;
    reason: string;
};
export declare function isVersionedTransaction(tx: Transaction | VersionedTransaction): tx is VersionedTransaction;
/** Project a web3.js transaction into the SDK-free shape `parseTx` decodes. */
export declare function projectTransaction(tx: Transaction | VersionedTransaction): ProjectResult;
//# sourceMappingURL=project.d.ts.map