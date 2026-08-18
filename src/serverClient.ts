/**
 * MCP client for the closed editor server. This package is a gateway: it
 * connects to the server's Streamable-HTTP MCP endpoint (config.serverUrl,
 * e.g. https://x.hiqlcd.com/mcp/editor) as an MCP client and re-exposes the
 * server's tools over stdio. No schema duplication — tools/list and the
 * tool inputSchemas come straight from the server.
 *
 * The connection is a lazily-built singleton (connect once, reuse). Calc/SQL
 * on the server side can be slow, so the per-request timeout is generous (120s).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { EditorClientError } from "./types.js";
import { VERSION } from "./version.js";

const REQUEST_TIMEOUT_MS = 120_000;

let clientPromise: Promise<Client> | undefined;

/** 认出「鉴权被拒」:优先看 SDK 带出来的 HTTP 状态,没有就从响应体文本里认
 *  401/403。只认这两个码 —— 其余一律算连接问题,宁可少判也不误判。 */
function isAuthRejection(err: unknown, msg: string): boolean {
  const e = err as { status?: number; code?: number } | undefined;
  if (e?.status === 401 || e?.status === 403) return true;
  if (e?.code === 401 || e?.code === 403) return true;
  return /\b(401|403)\b/.test(msg);
}

/** Connect to the remote MCP endpoint once and reuse the client. */
export function getRemoteClient(): Promise<Client> {
  if (!config.token) {
    return Promise.reject(
      new EditorClientError(
        "config",
        "No SSO token. Set HIQ_EDITOR_TOKEN in the environment the host spawns this MCP with.",
      ),
    );
  }
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      // Reset so a later call can retry instead of caching a rejected promise.
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

/** Pull the wrapped SSO accessToken out of a Cortex JWT (the `sso_token` claim)
 *  for the edge's `accessToken` cookie. Returns the token unchanged if it isn't
 *  a JWT. Signature is not verified — the edge does that. */
function ssoAccessToken(token: string): string {
  if (!token.startsWith("eyJ")) return token;
  try {
    const payload = token.split(".")[1];
    if (!payload) return token;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return typeof claims.sso_token === "string" ? claims.sso_token : token;
  } catch {
    return token;
  }
}

async function connect(): Promise<Client> {
  const client = new Client(
    { name: "hiq-editor-gateway", version: VERSION },
    { capabilities: {} },
  );
  // Internal edge auth, matching what Cortex Desktop's connector sends for the
  // signed-in session: X-Site selects the JWT-auth path for the forwarded SSO
  // token, plus the accessToken cookie (the sso_token unwrapped from a Cortex JWT).
  const transport = new StreamableHTTPClientTransport(new URL(config.serverUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${config.token}`,
        "X-Site": config.site,
        Cookie: `accessToken=${ssoAccessToken(config.token)}`,
      },
    },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 「连不上」和「没通过鉴权」是两回事,报错要指对方向:前者让人查网络,后者
    // 让人重新登录。SDK 把服务端响应体原样塞进 message,401/403 从那里认;认不
    // 出来就仍按 transport 报,不猜。
    if (isAuthRejection(err, msg)) {
      throw new EditorClientError(
        "config",
        `editor rejected the current credential (401/403) at ${config.serverUrl}. ` +
          `The session token is missing, expired, or not valid for this account — sign in again ` +
          `(\`hiq-editor login\`), or have the host re-inject HIQ_EDITOR_TOKEN. Server said: ${msg}`,
      );
    }
    throw new EditorClientError(
      "transport",
      `could not connect to editor MCP endpoint ${config.serverUrl}: ${msg}`,
    );
  }
  return client;
}

/** Close the remote connection so a one-shot process (the CLI) can exit —
 *  the Streamable HTTP transport otherwise keeps the event loop alive. */
export async function closeRemoteClient(): Promise<void> {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.close();
  } catch {
    // closing best-effort — the process is exiting anyway
  } finally {
    clientPromise = undefined;
  }
}

/** The remote server's tool catalog (name, description, inputSchema). */
export async function listRemoteTools(): Promise<Tool[]> {
  const client = await getRemoteClient();
  const { tools } = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
  return tools;
}

/** Invoke a tool on the remote server, passing through its result content. */
export async function callRemoteTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const client = await getRemoteClient();
  return client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: REQUEST_TIMEOUT_MS },
  );
}
