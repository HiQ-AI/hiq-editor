/**
 * `hiq-editor login` — self-serve QR sign-in for environments where no host
 * injects HIQ_EDITOR_TOKEN (Claude Code, WorkBuddy, any third-party agent
 * runtime). Runs the deck OAuth device flow (RFC 8628, scope `lca_data`):
 * prints a QR + authorize link, the user approves on cortex.hiq.earth, and the
 * flow returns the user's SSO accessToken — the exact credential the editor
 * server authenticates (config.ts falls back to the stored file when the env
 * var is absent). `hiq-editor logout` deletes it.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { EditorClientError } from "./types.js";
import { VERSION } from "./version.js";

const OAUTH_BASE = (
  process.env.HIQ_EDITOR_OAUTH_URL?.trim() || "https://x.hiqlcd.com/api/cortex/oauth"
).replace(/\/+$/, "");

export function credentialsPath(): string {
  return join(homedir(), ".config", "hiq-editor", "credentials.json");
}

/** Token from a previous `hiq-editor login`, or "" — config.ts's fallback. */
export function readStoredToken(): string {
  try {
    const j = JSON.parse(readFileSync(credentialsPath(), "utf-8")) as { token?: unknown };
    return typeof j.token === "string" ? j.token : "";
  } catch {
    return "";
  }
}

interface DeviceAuthz {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in?: number;
  interval?: number;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function runLogin(json: boolean): Promise<void> {
  const resp = await postJson(`${OAUTH_BASE}/device_authorization`, {
    agent_id: "hiq-editor-cli",
    agent_name: "hiq-editor CLI",
    scope: "lca_data",
    client_skill: "hiq-editor-cli",
    client_host: process.env.HIQ_EDITOR_CLIENT_HOST?.trim() || "cli",
    client_version: VERSION,
  });
  if (!resp.ok) {
    throw new EditorClientError(
      "transport",
      `device_authorization failed: HTTP ${resp.status} ${await resp.text()}`,
    );
  }
  const d = (await resp.json()) as DeviceAuthz;
  const url = d.verification_uri_complete;

  // Progress/UI on stderr — stdout stays reserved for the final result.
  const qrcode = (await import("qrcode-terminal")).default;
  await new Promise<void>((resolve) => {
    qrcode.generate(url, { small: true }, (q: string) => {
      process.stderr.write(q + "\n");
      resolve();
    });
  });
  process.stderr.write(
    `Scan the QR code, or open the link to authorize (code ${d.user_code}):\n${url}\nWaiting for approval...\n`,
  );

  const deadline = Date.now() + (d.expires_in ?? 600) * 1000;
  const intervalMs = Math.max(d.interval ?? 5, 2) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tr = await postJson(`${OAUTH_BASE}/token`, { device_code: d.device_code });
    if (tr.status === 428) continue; // authorization_pending — keep polling
    if (!tr.ok) {
      throw new EditorClientError("upstream", `authorization failed: HTTP ${tr.status} ${await tr.text()}`);
    }
    const tok = (await tr.json()) as { access_token: string; owner?: string; scope?: string };
    const p = credentialsPath();
    mkdirSync(join(homedir(), ".config", "hiq-editor"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(
        { token: tok.access_token, owner: tok.owner ?? null, scope: tok.scope ?? null, obtained_at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
    chmodSync(p, 0o600);
    process.stdout.write(
      json
        ? JSON.stringify({ ok: true, owner: tok.owner ?? null, credentials: p }) + "\n"
        : `Signed in${tok.owner ? ` as ${tok.owner}` : ""}. Credentials stored at ${p}\n`,
    );
    return;
  }
  throw new EditorClientError("upstream", "authorization timed out — run `hiq-editor login` again.");
}

export function runLogout(json: boolean): void {
  const p = credentialsPath();
  const had = existsSync(p);
  if (had) unlinkSync(p);
  process.stdout.write(
    json
      ? JSON.stringify({ ok: true, removed: had }) + "\n"
      : had
        ? "Signed out — stored credentials removed.\n"
        : "No stored credentials.\n",
  );
}
