import { describe, it, expect } from "vitest";
import { parseTx, fromKitTransaction, SYSTEM_PROGRAM_ID, DecompiledMessage } from "./parseTx.js";
import { evaluate } from "../policy/evaluate.js";
import { Policy, EvalState } from "../policy/schema.js";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const AGENT = "AgentWallet11111111111111111111111111111111";
const ALLOW_RCPT = "AllowRecipient1111111111111111111111111111";
const BAD_RCPT = "BadRecipient1111111111111111111111111111111";
const OTHER = "OtherWallet11111111111111111111111111111111";

/** Encode a System Program instruction: u32 LE discriminant + u64 LE lamports. */
function sysData(disc: number, lamports?: bigint): Uint8Array {
  const len = lamports === undefined ? 4 : 12;
  const buf = new Uint8Array(len);
  const view = new DataView(buf.buffer);
  view.setUint32(0, disc, true);
  if (lamports !== undefined) view.setBigUint64(4, lamports, true);
  return buf;
}

function transferIx(from: string, to: string, lamports: bigint) {
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [{ address: from }, { address: to }],
    data: sysData(2, lamports),
  };
}

function msg(instructions: DecompiledMessage["instructions"]): DecompiledMessage {
  return { feePayer: AGENT, instructions };
}

describe("parseTx() — System Program decoding", () => {
  it("decodes a transfer debiting the fee payer", () => {
    const r = parseTx(msg([transferIx(AGENT, ALLOW_RCPT, 50_000_000n)]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.outSol).toBe(0.05);
    expect(r.intent.recipients).toEqual([ALLOW_RCPT]);
    expect(r.intent.instructions[0]).toEqual({
      programId: SYSTEM_PROGRAM_ID,
      recipient: ALLOW_RCPT,
      lamports: 50_000_000,
    });
  });

  it("sums multiple outgoing transfers and de-duplicates recipients", () => {
    const r = parseTx(
      msg([
        transferIx(AGENT, ALLOW_RCPT, 10_000_000n),
        transferIx(AGENT, ALLOW_RCPT, 20_000_000n),
        transferIx(AGENT, OTHER, 5_000_000n),
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.outSol).toBeCloseTo(0.035, 9);
    expect(r.intent.recipients).toEqual([ALLOW_RCPT, OTHER]);
  });

  it("does not count value leaving a wallet we do not control", () => {
    const r = parseTx(msg([transferIx(OTHER, ALLOW_RCPT, 900_000_000n)]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.outSol).toBe(0);
    expect(r.intent.recipients).toEqual([]);
  });

  it("decodes CreateAccount as outgoing value", () => {
    const r = parseTx(
      msg([
        {
          programAddress: SYSTEM_PROGRAM_ID,
          accounts: [{ address: AGENT }, { address: OTHER }],
          data: sysData(0, 2_000_000n),
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.outSol).toBe(0.002);
    expect(r.intent.recipients).toEqual([OTHER]);
  });

  it("reads TransferWithSeed's destination from account index 2", () => {
    const r = parseTx(
      msg([
        {
          programAddress: SYSTEM_PROGRAM_ID,
          accounts: [{ address: AGENT }, { address: OTHER }, { address: ALLOW_RCPT }],
          data: sysData(11, 1_000_000n),
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.recipients).toEqual([ALLOW_RCPT]);
  });

  it("treats known non-value System instructions as zero-value", () => {
    const r = parseTx(
      msg([{ programAddress: SYSTEM_PROGRAM_ID, accounts: [{ address: AGENT }], data: sysData(8) }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.outSol).toBe(0);
  });
});

describe("parseTx() — fail-closed behaviour", () => {
  // These are the cases where reporting outSol 0 would be a key-loss bug:
  // evaluate() only enforces the recipient allowlist when outSol > 0.
  it("refuses an unknown System discriminant rather than assuming zero value", () => {
    const r = parseTx(msg([{ programAddress: SYSTEM_PROGRAM_ID, accounts: [], data: sysData(99) }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/unknown system instruction discriminant 99/);
  });

  it("refuses a value instruction with a truncated lamports field", () => {
    const short = new Uint8Array(6);
    new DataView(short.buffer).setUint32(0, 2, true);
    const r = parseTx(msg([{ programAddress: SYSTEM_PROGRAM_ID, accounts: [], data: short }]));
    expect(r.ok).toBe(false);
  });

  it("refuses a transfer whose from/to accounts are missing", () => {
    const r = parseTx(
      msg([
        { programAddress: SYSTEM_PROGRAM_ID, accounts: [{ address: AGENT }], data: sysData(2, 1n) },
      ]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/missing from\/to/);
  });

  it("refuses a System instruction carrying no data", () => {
    const r = parseTx(msg([{ programAddress: SYSTEM_PROGRAM_ID, accounts: [] }]));
    expect(r.ok).toBe(false);
  });

  it("refuses an empty transaction", () => {
    const r = parseTx(msg([]));
    expect(r.ok).toBe(false);
  });
});

describe("parseTx() — opaque (non-System) programs", () => {
  // Current posture (a): trust the allowlist, report programId only. The
  // program allowlist in evaluate() is what bounds this.
  it("passes a non-System program through as programId only", () => {
    const r = parseTx(msg([{ programAddress: JUP, accounts: [{ address: AGENT }], data: sysData(1) }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.instructions).toEqual([{ programId: JUP }]);
    expect(r.intent.outSol).toBe(0);
  });
});

describe("parseTx() -> evaluate() end to end", () => {
  const policy: Policy = {
    version: 1,
    limits: { perTxSol: 0.1, dailySol: 0.5 },
    allowPrograms: [SYSTEM_PROGRAM_ID, JUP],
    allowRecipients: [ALLOW_RCPT],
    allowTokens: ["SOL"],
    blockRecipients: [BAD_RCPT],
    escalateAboveSol: 0.1,
  };
  const fresh: EvalState = { dailySpentSol: 0 };

  function decide(m: DecompiledMessage) {
    const r = parseTx(m);
    if (!r.ok) return { decision: "ESCALATE" as const, reason: r.reason };
    return evaluate(r.intent, policy, fresh);
  }

  it("AUTO_SIGN: small in-policy transfer to an allowlisted recipient", () => {
    expect(decide(msg([transferIx(AGENT, ALLOW_RCPT, 50_000_000n)])).decision).toBe("AUTO_SIGN");
  });

  it("ESCALATE: over-limit transfer", () => {
    expect(decide(msg([transferIx(AGENT, ALLOW_RCPT, 500_000_000n)])).decision).toBe("ESCALATE");
  });

  // The money shot: a hijacked agent proposes a transfer to a blocklisted
  // address and no signature is ever produced.
  it("REJECT: prompt-injected agent transfers to a blocklisted address", () => {
    expect(decide(msg([transferIx(AGENT, BAD_RCPT, 1_000_000n)])).decision).toBe("REJECT");
  });

  it("ESCALATE: a transfer hidden in an instruction the adapter cannot decode", () => {
    expect(
      decide(msg([{ programAddress: SYSTEM_PROGRAM_ID, accounts: [], data: sysData(99) }])).decision,
    ).toBe("ESCALATE");
  });
});

describe("fromKitTransaction()", () => {
  it("accepts a kit-style address object fee payer", () => {
    const r = fromKitTransaction({
      feePayer: { address: AGENT },
      instructions: [transferIx(AGENT, ALLOW_RCPT, 1_000_000n)],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.intent.outSol).toBe(0.001);
  });
});
