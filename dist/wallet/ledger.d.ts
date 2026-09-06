import type { EvalState } from "../policy/schema.js";
import type { SpendLedger } from "./coldstarWallet.js";
export declare class FileSpendLedger implements SpendLedger {
    private readonly path;
    private readonly now;
    private state;
    constructor(path: string, now?: () => Date);
    get(): EvalState;
    add(sol: number): void;
    addToken(mint: string, baseUnits: bigint): void;
    private roll;
    private load;
    private persist;
}
//# sourceMappingURL=ledger.d.ts.map