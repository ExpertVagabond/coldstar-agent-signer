// Coldstar Agent-Safe Signing — simulation-based accounting (posture (b)).
//
// Static decoding cannot tell how much SOL a swap through an allowlisted
// program will move; only the runtime knows. A Simulator answers one question:
// if this transaction executed now, how many lamports would leave the fee
// payer? The wallet takes the LARGER of the static and simulated figures, so
// simulation can only make the policy stricter, never looser.
//
// Fail-closed: anything the simulator cannot answer is `{ ok: false }`, and
// the wallet escalates.
import { Connection } from "@solana/web3.js";
/**
 * RPC-backed simulator. Reads the fee payer's balance, simulates with signature
 * verification off and a fresh blockhash substituted, and reads the post-state
 * balance of the fee payer from the simulation. The debit INCLUDES the fee —
 * over-reporting is the safe direction.
 */
export function rpcSimulator(rpcOrConnection) {
    const connection = typeof rpcOrConnection === "string" ? new Connection(rpcOrConnection, "confirmed") : rpcOrConnection;
    return async (tx, feePayer) => {
        try {
            const pre = BigInt(await connection.getBalance(feePayer, "confirmed"));
            const res = await connection.simulateTransaction(tx, {
                sigVerify: false,
                replaceRecentBlockhash: true,
                commitment: "confirmed",
                accounts: { encoding: "base64", addresses: [feePayer.toBase58()] },
            });
            if (res.value.err) {
                return { ok: false, reason: `simulation error: ${JSON.stringify(res.value.err)}` };
            }
            const acct = res.value.accounts?.[0];
            if (!acct) {
                return { ok: false, reason: "simulation returned no post-state for the fee payer" };
            }
            const post = BigInt(acct.lamports);
            const debit = pre > post ? pre - post : 0n;
            return { ok: true, debitLamports: debit };
        }
        catch (e) {
            return { ok: false, reason: e.message ?? String(e) };
        }
    };
}
//# sourceMappingURL=simulate.js.map