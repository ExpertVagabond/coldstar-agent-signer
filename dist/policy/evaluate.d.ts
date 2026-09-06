import { Policy, TxIntent, EvalState, EvalResult } from "./schema.js";
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
 *   7) SPL token rules (see below)          -> ESCALATE
 *   8) otherwise                           -> AUTO_SIGN
 *
 * Token rules exist because allowlisting the Token program so an agent can pay
 * in USDC used to disable every amount control: the SOL limits count lamports,
 * and a token transfer moves none.
 *
 * The agent NEVER holds the root key. AUTO_SIGN uses a policy-gated session
 * signer; ESCALATE hands an unsigned tx to the cold device (QR/air-gap);
 * REJECT returns no signature.
 */
export declare function evaluate(intent: TxIntent, policy: Policy, state: EvalState): EvalResult;
//# sourceMappingURL=evaluate.d.ts.map