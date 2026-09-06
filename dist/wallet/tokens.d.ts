import { PublicKey } from "@solana/web3.js";
import type { Policy } from "../policy/schema.js";
/** The associated token account for `owner` and `mint`, under one token program. */
export declare function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey;
/**
 * Return a copy of `policy` whose `allowTokenAccounts` also contains the
 * associated token accounts of every allowRecipients x mint pair, under both
 * token programs. Entries already present are kept. The input is not modified.
 */
export declare function expandTokenAccounts(policy: Policy): Policy;
//# sourceMappingURL=tokens.d.ts.map