/** Typed HTTP client for Editor's native Spring Boot API behind APISIX. */

import { config } from "./config.js";
import { EditorClientError } from "./types.js";

const REQUEST_TIMEOUT_MS = 60_000;
export const IMPORT_TIMEOUT_MS = 210_000;

export interface EditorIdentity {
  userId: string;
  userName: string;
  tenantId: string;
  tenantName: string;
  accessToken: string;
}

export interface NativeEnvelope<T> {
  success?: boolean;
  code?: string | number;
  message?: string;
  msg?: string;
  data?: T;
  page?: number;
  size?: number;
  total?: number;
  totalPageNum?: number;
  needConfirm?: boolean;
  headers?: unknown;
}

let identityPromise: Promise<EditorIdentity> | undefined;

function credential(): NonNullable<typeof config.credential> {
  if (!config.credential) {
    throw new EditorClientError(
      "config",
      "No credential. Set HIQ_EDITOR_TOKEN or HIQ_EDITOR_API_KEY, or run `hiq-editor login`.",
    );
  }
  return config.credential;
}

/** Cortex task delegation JWTs wrap the real SSO credential in `sso_token`. */
export function unwrapSsoToken(token: string): string {
  if (!token.startsWith("eyJ")) return token;
  try {
    const payload = token.split(".")[1];
    if (!payload) return token;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as {
      sso_token?: unknown;
    };
    return typeof claims.sso_token === "string" && claims.sso_token.trim()
      ? claims.sso_token
      : token;
  } catch {
    return token;
  }
}

function authHeaders(token: string): Record<string, string> {
  const value = unwrapSsoToken(token);
  return {
    Authorization: value,
    Cookie: `accessToken=${value}; satoken=${value}`,
    ...(credential().kind === "api-key" ? { "X-API-Key": value } : {}),
  };
}

function nonEmpty(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** Resolve the userId required by Dataset's LoginInterceptor with the existing SSO. */
export function resolveEditorIdentity(): Promise<EditorIdentity> {
  if (!identityPromise) {
    identityPromise = resolveIdentity().catch((error) => {
      identityPromise = undefined;
      throw error;
    });
  }
  return identityPromise;
}

async function resolveIdentity(): Promise<EditorIdentity> {
  const current = credential();
  const token = unwrapSsoToken(current.value);
  const url = new URL(config.ssoUserInfoUrl);
  url.searchParams.set("productCode", "hiq_square");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EditorClientError(
      "transport",
      `Could not reach HiQ SSO: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = await parseJson<Record<string, unknown>>(response, "HiQ SSO");
  const code = body.code;
  const root = body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : undefined;
  const user = root?.user && typeof root.user === "object"
    ? root.user as Record<string, unknown>
    : root;
  const tenant = user?.currentTenant && typeof user.currentTenant === "object"
    ? user.currentTenant as Record<string, unknown>
    : root?.currentTenant && typeof root.currentTenant === "object"
      ? root.currentTenant as Record<string, unknown>
      : undefined;
  const userId = nonEmpty(user?.id);
  const successfulCode = code === undefined || code === 200 || code === "200" || code === 0 || code === "0";
  if (!response.ok || !successfulCode || !userId) {
    throw new EditorClientError(
      "config",
      `HiQ SSO rejected the current credential (${response.status}; code=${String(code ?? "-")}).`,
    );
  }
  return {
    userId,
    userName: nonEmpty(user?.userName ?? user?.username ?? user?.name),
    tenantId: nonEmpty(tenant?.id ?? user?.tenantId),
    tenantName: nonEmpty(tenant?.name ?? user?.tenantName),
    accessToken: token,
  };
}

async function parseJson<T extends object>(response: Response, service: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new EditorClientError(
      response.ok ? "transport" : "upstream",
      `${service} returned HTTP ${response.status} with a non-JSON body.`,
    );
  }
}

function endpoint(path: string): URL {
  return new URL(`${config.apiUrl}${path}`);
}

function checkEnvelope<T>(response: Response, envelope: NativeEnvelope<T>): NativeEnvelope<T> {
  const code = envelope.code;
  const successfulCode = code === undefined || code === 200 || code === "200" || code === 0 || code === "0";
  if (!response.ok || envelope.success === false || !successfulCode) {
    const message = envelope.message ?? envelope.msg ?? `Editor API failed with HTTP ${response.status}.`;
    const kind = response.status === 401 || response.status === 403 || code === 401 || code === "401"
      ? "config"
      : response.status >= 500
        ? "upstream"
        : "validation";
    throw new EditorClientError(kind, message, code == null ? undefined : String(code));
  }
  return envelope;
}

async function request<T>(path: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<NativeEnvelope<T>> {
  const identity = await resolveEditorIdentity();
  let response: Response;
  try {
    response = await fetch(endpoint(path), {
      ...init,
      headers: {
        ...authHeaders(identity.accessToken),
        Cookie: `satoken=${identity.accessToken}; userId=${identity.userId}; accessToken=${identity.accessToken}`,
        userId: identity.userId,
        Accept: "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new EditorClientError(
      "transport",
      `Could not reach Editor API ${config.apiUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return checkEnvelope(response, await parseJson<NativeEnvelope<T>>(response, "Editor API"));
}

function pathWithQuery(path: string, params?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(path, "https://editor.invalid");
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

export function apiGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<NativeEnvelope<T>> {
  return request<T>(pathWithQuery(path, params), { method: "GET" });
}

export function apiPost<T>(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<NativeEnvelope<T>> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
}

export function apiPostMultipart<T>(
  path: string,
  form: FormData,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<NativeEnvelope<T>> {
  return request<T>(pathWithQuery(path, params), { method: "POST", body: form }, IMPORT_TIMEOUT_MS);
}

/** Test seam: identity is process-local and must not leak across credential scenarios. */
export function resetIdentityCache(): void {
  identityPromise = undefined;
}
