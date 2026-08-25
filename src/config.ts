/**
 * Runtime config. Read once at process start from the environment the host
 * (Cortex Desktop / an automation runner) supplies to the CLI.
 *
 *   HIQ_EDITOR_API_URL     — Editor native API through APISIX
 *                            (default https://x.hiqlcd.com/api/dataset).
 *   HIQ_EDITOR_TOKEN       — the caller's SSO token (raw SSO accessToken or a
 *                            Cortex desktop JWT wrapping one). Forwarded verbatim
 *                            to SSO and then as the native API's raw
 *                            `Authorization` value; the server resolves the
 *                            user/tenant from it. Like jimu-lca's
 *                            memberKey, it is provided by the host env.
 *   HIQ_EDITOR_API_KEY     — a HiQ-issued API key. Sent only as X-API-Key;
 *                            mutually exclusive with HIQ_EDITOR_TOKEN.
 */

const DEFAULT_API_URL = "https://x.hiqlcd.com/api/dataset";
const DEFAULT_SSO_USER_INFO_URL = "https://x.hiqlcd.com/api/sso/user/info/current";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface Config {
  /** Editor native API base URL through APISIX, no trailing slash. */
  apiUrl: string;
  /** Existing SSO user-info endpoint used to resolve the required userId header. */
  ssoUserInfoUrl: string;
  /** Explicit authentication transport; undefined when no credential is configured. */
  credential?: { kind: "access-token" | "api-key"; value: string; source: "env" | "login" };
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
  apiUrl: stripTrailingSlash(
    process.env.HIQ_EDITOR_API_URL?.trim() || DEFAULT_API_URL,
  ),
  ssoUserInfoUrl: process.env.HIQ_EDITOR_SSO_USER_INFO_URL?.trim() || DEFAULT_SSO_USER_INFO_URL,
  // Host-injected env wins; otherwise fall back to `hiq-editor login` credentials.
  credential: credentialFromEnvironment(),
};
