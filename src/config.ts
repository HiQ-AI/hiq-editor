/**
 * Runtime config. Read once at process start from the environment the host
 * (Cortex Desktop / Claude Code) supplies when it spawns this stdio MCP.
 *
 *   HIQ_EDITOR_SERVER_URL  — the editor server's Streamable-HTTP MCP endpoint
 *                            (e.g. https://x.hiqlcd.com/mcp/editor), no trailing slash.
 *   HIQ_EDITOR_TOKEN       — the caller's SSO token (raw SSO accessToken or a
 *                            Cortex desktop JWT wrapping one). Forwarded verbatim
 *                            as `Authorization: Bearer <token>`; the server
 *                            resolves user/tenant from it. Like jimu-lca's
 *                            memberKey, it is provided by the host env — there is
 *                            no `login` tool in this client.
 */

// The editor server's MCP endpoint is reached through the existing APISIX edge
// at x.hiqlcd.com. Override via HIQ_EDITOR_SERVER_URL.
const DEFAULT_SERVER_URL = "https://x.hiqlcd.com/mcp/editor";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface Config {
  /** Editor server MCP endpoint URL, no trailing slash. */
  serverUrl: string;
  /** Caller's SSO token, forwarded as a Bearer token. Empty string if unset. */
  token: string;
  /** Internal edge-routing value (X-Site header) that selects the JWT-auth path
   *  for the forwarded SSO token. Defaults to 101; override via HIQ_EDITOR_SITE. */
  site: string;
}

import { readStoredToken } from "./login.js";

export const config: Config = {
  serverUrl: stripTrailingSlash(
    process.env.HIQ_EDITOR_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
  ),
  // Host-injected env wins; otherwise fall back to `hiq-editor login` credentials.
  token: process.env.HIQ_EDITOR_TOKEN?.trim() || readStoredToken(),
  site: process.env.HIQ_EDITOR_SITE?.trim() || "101",
};
