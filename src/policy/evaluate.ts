import { Policy, TxIntent, EvalState, EvalResult, TokenMovement } from "./schema.js";

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
export function evaluate(intent: TxIntent, policy: Policy, state: EvalState): EvalResult {
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

  // 4b) SOL is an asset like any other: a policy that does not list it does not move it.
  //     Fees are not counted in outSol, so this only fires on explicit transfers.
  if (intent.outSol > 0 && !policy.allowTokens.includes("SOL")) {
    return { decision: "ESCALATE", reason: "policy.allowTokens does not include SOL" };
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

  // 7) SPL tokens
  if (intent.tokenMovements.length > 0) {
    const tokenResult = evaluateTokens(intent.tokenMovements, policy, state);
    if (tokenResult) return tokenResult;
  }

  // 8) within policy — safe to auto-sign
  return { decision: "AUTO_SIGN", reason: "within policy" };
}

/**
 * Token rules, returning the first failure or undefined when every movement
 * passes. Amounts are base units throughout; nothing here touches a float.
 */
function evaluateTokens(movements: TokenMovement[], policy: Policy, state: EvalState): EvalResult | undefined {
  const spentByMint = state.dailySpentByMint ?? {};
  // Several movements of the same mint in one transaction accumulate together.
  const pendingByMint = new Map<string, bigint>();

  for (const m of movements) {
    if (m.amount <= 0n) continue;

    // a) the asset must be identifiable and allowed
    if (!m.mint) {
      return { decision: "ESCALATE", reason: "token movement does not name a mint, so allowTokens cannot be applied" };
    }
    if (!policy.allowTokens.includes(m.mint)) {
      return { decision: "ESCALATE", reason: `token ${m.mint} is not in allowTokens` };
    }

    // b) the destination token account must be allowed. The wallet derives the
    //    associated token accounts of allowRecipients x allowTokens into this
    //    list, so ordinary payments to allowlisted people need no extra config.
    const allowedAccounts = policy.allowTokenAccounts ?? [];
    if (!m.destination || !allowedAccounts.includes(m.destination)) {
      return {
        decision: "ESCALATE",
        reason: `token destination ${m.destination ?? "unknown"} is not an allowed token account for ${m.mint}`,
      };
    }

    const limits = policy.tokenLimits?.[m.mint];
    const pending = (pendingByMint.get(m.mint) ?? 0n) + m.amount;
    pendingByMint.set(m.mint, pending);

    // c) per-transaction limit
    if (limits?.perTx !== undefined) {
      const perTx = parseBaseUnits(limits.perTx);
      if (perTx === undefined) {
        return { decision: "ESCALATE", reason: `tokenLimits.${m.mint}.perTx is not a whole number of base units` };
      }
      if (pending > perTx) {
        return { decision: "ESCALATE", reason: `token ${m.mint}: ${pending} exceeds the per-transaction limit ${perTx} (base units)` };
      }
    }

    // d) daily cap for this mint
    if (limits?.daily !== undefined) {
      const daily = parseBaseUnits(limits.daily);
      if (daily === undefined) {
        return { decision: "ESCALATE", reason: `tokenLimits.${m.mint}.daily is not a whole number of base units` };
      }
      const already = parseBaseUnits(spentByMint[m.mint] ?? "0") ?? 0n;
      if (already + pending > daily) {
        return {
          decision: "ESCALATE",
          reason: `token ${m.mint}: daily cap ${daily} would be exceeded (${already} + ${pending}, base units)`,
        };
      }
    }
  }
  return undefined;
}

/** Base units are whole numbers. Anything else is a policy authoring error, not a value. */
function parseBaseUnits(v: string): bigint | undefined {
  if (!/^\d+$/.test(v.trim())) return undefined;
  try {
    return BigInt(v.trim());
  } catch {
    return undefined;
  }
}
