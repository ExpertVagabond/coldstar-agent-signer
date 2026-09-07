/** Read a passphrase. Prefers the terminal; falls back to a piped line. */
export declare function readPassphrase(prompt: string): Promise<string>;
/**
 * Read a passphrase that is about to encrypt a key for the first time.
 *
 * Confirmed by typing it twice, because a typo here loses the key permanently
 * — but only at a terminal. A piped passphrase has no human to re-type it, and
 * asking twice would just consume a line that is not coming.
 */
export declare function readNewPassphrase(): Promise<string>;
//# sourceMappingURL=passphrase.d.ts.map