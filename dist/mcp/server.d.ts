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
export declare function createColdstarMcpServer(opts: McpServerOptions): McpServer;
//# sourceMappingURL=server.d.ts.map