// Coldstar Agent-Safe Signing — associated token account derivation.
//
// A token transfer's destination is a TOKEN ACCOUNT, not the recipient's wallet
// address, so `allowRecipients` cannot be compared against it directly. Rather
// than make operators paste token accounts into their policy, the wallet
// derives the associated token account of every allowRecipients x allowTokens
// pair and adds them to `allowTokenAccounts` before evaluating.
//
// Derivation is deterministic and offline: seeds [owner, tokenProgram, mint]
// under the Associated Token Account program. Both the classic Token program
// and Token-2022 are derived, because a mint may live under either.
//
// This expansion is applied to a COPY. The envelope's signed policy is never
// mutated, so what the root signed stays exactly what the root signed.

import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../adapter/parseTx.js";
import type { Policy } from "../policy/schema.js";

const ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
const TOKEN_PROGRAMS = [new PublicKey(TOKEN_PROGRAM_ID), new PublicKey(TOKEN_2022_PROGRAM_ID)];

/** The associated token account for `owner` and `mint`, under one token program. */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
}

function isPubkey(v: string): boolean {
  try {
    new PublicKey(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return a copy of `policy` whose `allowTokenAccounts` also contains the
 * associated token accounts of every allowRecipients x mint pair, under both
 * token programs. Entries already present are kept. The input is not modified.
 */
export function expandTokenAccounts(policy: Policy): Policy {
  const mints = policy.allowTokens.filter((t) => t !== "SOL" && isPubkey(t));
  if (mints.length === 0) return policy;

  const derived = new Set(policy.allowTokenAccounts ?? []);
  for (const recipient of policy.allowRecipients) {
    if (!isPubkey(recipient)) continue;
    const owner = new PublicKey(recipient);
    for (const mint of mints) {
      const m = new PublicKey(mint);
      for (const program of TOKEN_PROGRAMS) {
        derived.add(associatedTokenAddress(owner, m, program).toBase58());
      }
    }
  }
  return { ...policy, allowTokenAccounts: [...derived] };
}
