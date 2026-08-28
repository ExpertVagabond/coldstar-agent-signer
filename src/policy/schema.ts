// Coldstar Agent-Safe Signing — policy types.
// The MCP layer parses a raw Solana tx into a normalized TxIntent; the pure
// policy engine (evaluate.ts) decides on the TxIntent. Keeping evaluate() off
// the raw tx makes it trivially unit-testable — which is the point, since this
// is the security-critical part.

export type Decision = "AUTO_SIGN" | "ESCALATE" | "REJECT";

export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface Policy {
  version: number;
  limits: { perTxSol: number; dailySol: number };
  allowPrograms: string[]; // program IDs the agent may touch without escalation
  allowRecipients: string[]; // pubkeys value may flow to without escalation
  allowTokens: string[]; // e.g. ["SOL"]
  blockRecipients: string[]; // hard blocklist — always rejected
  escalateAboveSol: number; // any single tx moving more than this escalates
}

export interface TxInstruction {
  programId: string;
  recipient?: string; // destination pubkey, if this ix moves value
  lamports?: number; // amount, if a SOL transfer
}

export interface TxIntent {
  instructions: TxInstruction[];
  outSol: number; // total SOL leaving the wallet (sum of outgoing lamports / 1e9)
  recipients: string[]; // distinct destination pubkeys
}

export interface EvalState {
  dailySpentSol: number; // running SOL spent in the current UTC day
}

export interface EvalResult {
  decision: Decision;
  reason: string;
}
