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
    allowTokens: string[];
    blockRecipients: string[];
    escalateAboveSol: number;
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
}
export interface EvalState {
    dailySpentSol: number;
}
export interface EvalResult {
    decision: Decision;
    reason: string;
}
//# sourceMappingURL=schema.d.ts.map