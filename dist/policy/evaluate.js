/**
 * Pure policy evaluator — no I/O, no side effects. Decides whether an
 * agent-proposed transaction auto-signs on a cold-rooted session key,
 * escalates to an air-gapped human, or is rejected outright.
 *
 * Order matters (first match wins):
 *   1) any blocklisted recipient          -> REJECT   (the compromised-agent guardrail)
 *   2) any program not allowlisted         -> ESCALATE
 *   3) amount over the escalate threshold  -> ESCALATE
 *   4) amount over the per-tx limit        -> ESCALATE
 *   5) recipient not allowlisted (value tx)-> ESCALATE
 *   6) daily cap would be exceeded         -> ESCALATE
 *   7) otherwise                           -> AUTO_SIGN
 *
 * The agent NEVER holds the root key. AUTO_SIGN uses a policy-gated session
 * signer; ESCALATE hands an unsigned tx to the cold device (QR/air-gap);
 * REJECT returns no signature.
 */
export function evaluate(intent, policy, state) {
    // 1) blocklist — hard reject. This is the whole point: even a hijacked agent
    //    cannot produce a signature for a disallowed destination.
    const blocked = intent.recipients.find((r) => policy.blockRecipients.includes(r));
    if (blocked) {
        return { decision: "REJECT", reason: `recipient ${blocked} is blocklisted` };
    }
    // 2) program allowlist
    const badProgram = intent.instructions.find((ix) => !policy.allowPrograms.includes(ix.programId));
    if (badProgram) {
        return { decision: "ESCALATE", reason: `program ${badProgram.programId} not in allowPrograms` };
    }
    // 3) escalate threshold
    if (intent.outSol > policy.escalateAboveSol) {
        return {
            decision: "ESCALATE",
            reason: `amount ${intent.outSol} SOL exceeds escalate threshold ${policy.escalateAboveSol}`,
        };
    }
    // 4) per-tx limit
    if (intent.outSol > policy.limits.perTxSol) {
        return {
            decision: "ESCALATE",
            reason: `amount ${intent.outSol} SOL exceeds per-tx limit ${policy.limits.perTxSol}`,
        };
    }
    // 5) recipient allowlist — only enforced when value actually leaves the wallet
    if (intent.outSol > 0) {
        const notAllowed = intent.recipients.find((r) => !policy.allowRecipients.includes(r));
        if (notAllowed) {
            return { decision: "ESCALATE", reason: `recipient ${notAllowed} not in allowRecipients` };
        }
    }
    // 6) daily cap
    if (state.dailySpentSol + intent.outSol > policy.limits.dailySol) {
        return {
            decision: "ESCALATE",
            reason: `daily cap ${policy.limits.dailySol} SOL would be exceeded (${state.dailySpentSol} + ${intent.outSol})`,
        };
    }
    // 7) within policy — safe to auto-sign
    return { decision: "AUTO_SIGN", reason: "within policy" };
}
//# sourceMappingURL=evaluate.js.map