import { describe, it, expect } from "vitest";
import { evaluate } from "./evaluate.js";
import { Policy, TxIntent, EvalState } from "./schema.js";

const SYSTEM = "11111111111111111111111111111111";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ALLOW_RCPT = "AllowRecipient1111111111111111111111111111";
const NEW_RCPT = "NewRecipient111111111111111111111111111111";
const BAD_RCPT = "BadRecipient1111111111111111111111111111111";

const policy: Policy = {
  version: 1,
  limits: { perTxSol: 0.1, dailySol: 0.5 },
  allowPrograms: [SYSTEM, JUP],
  allowRecipients: [ALLOW_RCPT],
  allowTokens: ["SOL"],
  blockRecipients: [BAD_RCPT],
  escalateAboveSol: 0.1,
};
const fresh: EvalState = { dailySpentSol: 0 };

function intent(o: Partial<TxIntent>): TxIntent {
  return { instructions: [{ programId: SYSTEM }], outSol: 0, recipients: [], ...o };
}

describe("evaluate()", () => {
  // Scenario 1 — the autonomy case
  it("AUTO_SIGN: small in-policy transfer to an allowlisted recipient", () => {
    const r = evaluate(
      intent({
        instructions: [{ programId: SYSTEM, recipient: ALLOW_RCPT, lamports: 5e7 }],
        outSol: 0.05,
        recipients: [ALLOW_RCPT],
      }),
      policy,
      fresh,
    );
    expect(r.decision).toBe("AUTO_SIGN");
  });

  // Scenario 2 — the human-in-the-loop case
  it("ESCALATE: transfer over the escalate threshold", () => {
    const r = evaluate(
      intent({
        instructions: [{ programId: SYSTEM, recipient: NEW_RCPT, lamports: 2e9 }],
        outSol: 2,
        recipients: [NEW_RCPT],
      }),
      policy,
      fresh,
    );
    expect(r.decision).toBe("ESCALATE");
  });

  // Scenario 3 — THE MONEY SHOT: compromised/injected agent is stopped cold
  it("REJECT: blocklisted recipient (prompt-injected / hijacked agent)", () => {
    const r = evaluate(
      intent({
        instructions: [{ programId: SYSTEM, recipient: BAD_RCPT, lamports: 5e7 }],
        outSol: 0.05,
        recipients: [BAD_RCPT],
      }),
      policy,
      fresh,
    );
    expect(r.decision).toBe("REJECT");
  });

  it("ESCALATE: touches a non-allowlisted program", () => {
    const r = evaluate(
      intent({ instructions: [{ programId: "UnknownProgram1111111111111111111111111111" }] }),
      policy,
      fresh,
    );
    expect(r.decision).toBe("ESCALATE");
  });

  it("ESCALATE: within per-tx limit but exceeds the daily cap", () => {
    const r = evaluate(
      intent({
        instructions: [{ programId: SYSTEM, recipient: ALLOW_RCPT, lamports: 5e7 }],
        outSol: 0.05,
        recipients: [ALLOW_RCPT],
      }),
      policy,
      { dailySpentSol: 0.48 }, // 0.48 + 0.05 > 0.5
    );
    expect(r.decision).toBe("ESCALATE");
  });

  it("ESCALATE: allowlisted program but non-allowlisted recipient", () => {
    const r = evaluate(
      intent({
        instructions: [{ programId: SYSTEM, recipient: NEW_RCPT, lamports: 5e7 }],
        outSol: 0.05,
        recipients: [NEW_RCPT],
      }),
      policy,
      fresh,
    );
    expect(r.decision).toBe("ESCALATE");
  });

  it("blocklist beats everything: rejects even an otherwise-in-policy tx", () => {
    const r = evaluate(
      intent({
        instructions: [{ programId: SYSTEM, recipient: BAD_RCPT, lamports: 1 }],
        outSol: 0.000000001,
        recipients: [BAD_RCPT],
      }),
      policy,
      fresh,
    );
    expect(r.decision).toBe("REJECT");
  });
});
