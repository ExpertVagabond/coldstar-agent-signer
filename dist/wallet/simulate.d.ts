import { Connection, type PublicKey, type VersionedTransaction } from "@solana/web3.js";
export type SimulationResult = {
    ok: true;
    debitLamports: bigint;
} | {
    ok: false;
    reason: string;
};
export type Simulator = (tx: VersionedTransaction, feePayer: PublicKey) => Promise<SimulationResult>;
/**
 * RPC-backed simulator. Reads the fee payer's balance, simulates with signature
 * verification off and a fresh blockhash substituted, and reads the post-state
 * balance of the fee payer from the simulation. The debit INCLUDES the fee —
 * over-reporting is the safe direction.
 */
export declare function rpcSimulator(rpcOrConnection: string | Connection): Simulator;
//# sourceMappingURL=simulate.d.ts.map