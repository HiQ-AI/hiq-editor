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
 *   HIQ_EDITOR_API_KEY     — a HiQ-issued API key. Sent only as X-API-Key;
 *                            mutually exclusive with HIQ_EDITOR_TOKEN.
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
  /** Explicit authentication transport; undefined when no credential is configured. */
  credential?: { kind: "access-token" | "api-key"; value: string; source: "env" | "login" };
  /** Internal edge-routing value (X-Site header) that selects the JWT-auth path
   *  for the forwarded SSO token. Defaults to 101; override via HIQ_EDITOR_SITE. */
  site: string;
}

import { readStoredToken } from "./login.js";

function credentialFromEnvironment(): Config["credential"] {
  const token = process.env.HIQ_EDITOR_TOKEN?.trim() || "";
  const apiKey = process.env.HIQ_EDITOR_API_KEY?.trim() || "";
  if (token && apiKey) {
    throw new Error("HIQ_EDITOR_TOKEN and HIQ_EDITOR_API_KEY are mutually exclusive");
  }
  if (apiKey) return { kind: "api-key", value: apiKey, source: "env" };
  if (token) return { kind: "access-token", value: token, source: "env" };
  const stored = readStoredToken();
  return stored ? { kind: "access-token", value: stored, source: "login" } : undefined;
}

export const config: Config = {
  serverUrl: stripTrailingSlash(
    process.env.HIQ_EDITOR_SERVER_URL?.trim() || DEFAULT_SERVER_URL,
  ),
  // Host-injected env wins; otherwise fall back to `hiq-editor login` credentials.
  credential: credentialFromEnvironment(),
  site: process.env.HIQ_EDITOR_SITE?.trim() || "101",
};
