import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { Keypair } from "@solana/web3.js";
import {
  WIRE_ENVELOPE_VERSION,
  WIRE_TYPE_POLICY_ENVELOPE,
  WIRE_TYPE_SIGNED_TX,
  isWireEnvelope,
  unwrapFromAirGap,
  unwrapPolicyEnvelope,
  wrapForAirGap,
  wrapPolicyEnvelope,
} from "./wireEnvelope.js";

describe("Coldstar's air-gap wire format", () => {
  it("produces exactly the bytes Coldstar's build_envelope produces", () => {
    // Coldstar writes compact JSON with separators (",", ":") and key order
    // type, version, data. Matching the literal output is the point: a decoder
    // written against either implementation has to read both.
    const out = wrapForAirGap(Buffer.from([1, 2, 3]), WIRE_TYPE_SIGNED_TX);
    expect(out).toBe('{"type":"signed_transaction","version":"1.0","data":"AQID"}');
    expect(out).not.toContain(", "); // no spaces after separators
  });

  it("pins the version as the string Coldstar uses, not a number", () => {
    expect(WIRE_ENVELOPE_VERSION).toBe("1.0");
    expect(JSON.parse(wrapForAirGap("x", "t")).version).toBe("1.0");
  });

  it("round-trips a policy envelope through the wrapper", () => {
    const envelope = {
      version: 1,
      policy: { version: 1, limits: { perTxSol: 0.1 } },
      sessionPubkey: Keypair.generate().publicKey.toBase58(),
      signature: "sig",
    };
    const wire = wrapPolicyEnvelope(envelope);
    expect(JSON.parse(wire).type).toBe(WIRE_TYPE_POLICY_ENVELOPE);
    expect(unwrapPolicyEnvelope(wire)).toEqual(envelope);
  });

  it("refuses a wrapper carrying something other than a grant", () => {
    const tx = wrapForAirGap(Buffer.from([9]), WIRE_TYPE_SIGNED_TX);
    // Reading a transaction as a grant, or the reverse, must not happen silently.
    expect(() => unwrapPolicyEnvelope(tx)).toThrow(/expected a policy_envelope, got signed_transaction/);
  });

  it("refuses a future version rather than misparsing it", () => {
    const future = JSON.stringify({ type: WIRE_TYPE_POLICY_ENVELOPE, version: "2.0", data: "e30=" });
    expect(() => unwrapFromAirGap(future)).toThrow(/unsupported air-gap envelope version 2\.0/);
  });

  it("rejects non-envelopes with a useful message", () => {
    expect(() => unwrapFromAirGap("not json")).toThrow(/not JSON/);
    expect(() => unwrapFromAirGap('{"type":"x"}')).toThrow(/need type, version and data/);
    expect(isWireEnvelope({ type: "a", version: "1.0", data: "b" })).toBe(true);
    expect(isWireEnvelope({ type: "a", version: 1, data: "b" })).toBe(false);
    expect(isWireEnvelope(null)).toBe(false);
  });
});

describe("cross-checked against Coldstar's own qr.py", () => {
  it("matches build_envelope byte for byte", () => {
    // Runs the real Coldstar function if that checkout is present. Skipped
    // rather than failed when it is not, so this suite stays portable.
    const qrPath = "/Volumes/Virtual Server/projects/coldstar-devsyrem/src/qr.py";
    let theirs: string;
    try {
      theirs = execFileSync(
        "python3",
        [
          "-c",
          [
            "import importlib.util,sys,base64,json",
            `spec=importlib.util.spec_from_file_location('q','${qrPath}')`,
            "m=importlib.util.module_from_spec(spec)",
            "sys.modules['q']=m",
            "spec.loader.exec_module(m)",
            "print(m.build_envelope(bytes([1,2,3]), 'signed_transaction'))",
          ].join("\n"),
        ],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
    } catch {
      return; // no Coldstar checkout, or segno not installed
    }
    expect(wrapForAirGap(Buffer.from([1, 2, 3]), WIRE_TYPE_SIGNED_TX)).toBe(theirs);
  });
});
