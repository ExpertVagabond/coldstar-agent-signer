import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ColdstarWallet } from "../wallet/coldstarWallet.js";
import type { Policy } from "../policy/schema.js";
export interface McpServerOptions {
    wallet: ColdstarWallet;
    policy: Policy;
    rpcUrl: string;
    /** Shown to clients; defaults to the package name. */
    name?: string;
    version?: string;
}
/**
 * The version an MCP client sees. Read from our own package.json rather than
 * written here: this drifted once already — the server advertised 0.1.0 while
 * the package was 0.4.1, which a client and the registry both surface. There is
 * a test asserting these agree, so it cannot drift again silently.
 */
export declare function packageVersion(): string;
export declare function createColdstarMcpServer(opts: McpServerOptions): McpServer;
//# sourceMappingURL=server.d.ts.map