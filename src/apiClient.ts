/**
 * Typed HTTP transport for Editor's native Spring Boot API behind APISIX.
 *
 * One transport = one credential + one resolved identity. Nothing here is
 * process-global: a long-lived host (Cortex nomad expert worker) creates one
 * transport per task with that task's delegated token, so identities never
 * leak across tenants. The CLI creates one from its environment (config.ts).
 */

import { EditorClientError } from "./types.js";

export const DEFAULT_API_URL = "https://x.hiqlcd.com/api/dataset";
export const DEFAULT_SSO_USER_INFO_URL = "https://x.hiqlcd.com/api/sso/user/info/current";
export const REQUEST_TIMEOUT_MS = 60_000;
export const IMPORT_TIMEOUT_MS = 210_000;

export interface EditorCredential {
  kind: "access-token" | "api-key";
  value: string;
}

export interface EditorTransportOptions {
  /** Editor native API base URL through APISIX; trailing slashes are stripped. */
  apiUrl?: string;
  /** SSO user-info endpoint used to resolve the userId header the native API requires. */
  ssoUserInfoUrl?: string;
  credential: EditorCredential;
  /** Per-request timeout for ordinary calls (default 60s). */
  requestTimeoutMs?: number;
  /** Timeout for the UPR multipart import (default 210s). */
  importTimeoutMs?: number;
  /** Host-level cancellation: aborts every in-flight and future request of this transport. */
  signal?: AbortSignal;
  /** Test seam / custom fetch; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
}

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

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface EditorTransport {
  readonly apiUrl: string;
  readonly ssoUserInfoUrl: string;
  readonly credentialKind: EditorCredential["kind"];
  /** Resolve (once per transport) the SSO identity behind the credential; a caller's signal / timeout bounds the wait. */
  identity(options?: RequestOptions): Promise<EditorIdentity>;
  get<T>(path: string, params?: QueryParams, options?: RequestOptions): Promise<NativeEnvelope<T>>;
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<NativeEnvelope<T>>;
  postMultipart<T>(path: string, form: FormData, params?: QueryParams, options?: RequestOptions): Promise<NativeEnvelope<T>>;
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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function nonEmpty(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

/** Timeout + caller signal + transport signal, whichever fires first. */
function combinedSignal(timeoutMs: number, ...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...present]);
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

function pathWithQuery(path: string, params?: QueryParams): string {
  const url = new URL(path, "https://editor.invalid");
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function transportError(target: string, error: unknown): EditorClientError {
  const reason = error instanceof Error ? error.message : String(error);
  return new EditorClientError("transport", `Could not reach ${target}: ${reason}`);
}

export function createEditorTransport(options: EditorTransportOptions): EditorTransport {
  if (!options.credential?.value?.trim()) {
    throw new EditorClientError("config", "No credential. Provide an SSO access token or an API key.");
  }
  const apiUrl = stripTrailingSlash(options.apiUrl?.trim() || DEFAULT_API_URL);
  const ssoUserInfoUrl = options.ssoUserInfoUrl?.trim() || DEFAULT_SSO_USER_INFO_URL;
  const credential = options.credential;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const importTimeoutMs = options.importTimeoutMs ?? IMPORT_TIMEOUT_MS;
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = unwrapSsoToken(credential.value);
  let identityPromise: Promise<EditorIdentity> | undefined;

  const authHeaders = (): Record<string, string> => ({
    Authorization: token,
    Cookie: `accessToken=${token}; satoken=${token}`,
    ...(credential.kind === "api-key" ? { "X-API-Key": token } : {}),
  });

  async function resolveIdentity(): Promise<EditorIdentity> {
    const url = new URL(ssoUserInfoUrl);
    url.searchParams.set("productCode", "hiq_square");
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: authHeaders(),
        signal: combinedSignal(requestTimeoutMs, options.signal),
      });
    } catch (error) {
      throw transportError("HiQ SSO", error);
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

  function identity(): Promise<EditorIdentity> {
    if (!identityPromise) {
      identityPromise = resolveIdentity().catch((error) => {
        identityPromise = undefined;
        throw error;
      });
    }
    return identityPromise;
  }

  /** The (shared, once-per-transport) identity lookup must not outlive the caller's own timeout / signal. */
  function abortable<V>(promise: Promise<V>, signal: AbortSignal): Promise<V> {
    if (signal.aborted) return Promise.reject(transportError("HiQ SSO", signal.reason ?? new Error("aborted")));
    return new Promise<V>((resolve, reject) => {
      const onAbort = (): void => reject(transportError("HiQ SSO", signal.reason ?? new Error("aborted")));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  async function request<T>(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<NativeEnvelope<T>> {
    const callSignal = combinedSignal(timeoutMs, options.signal, signal);
    const who = await abortable(identity(), callSignal);
    let response: Response;
    try {
      response = await doFetch(new URL(`${apiUrl}${path}`), {
        ...init,
        headers: {
          ...authHeaders(),
          Cookie: `satoken=${who.accessToken}; userId=${who.userId}; accessToken=${who.accessToken}`,
          userId: who.userId,
          Accept: "application/json",
          ...init.headers,
        },
        signal: callSignal,
      });
    } catch (error) {
      throw transportError(`Editor API ${apiUrl}`, error);
    }
    return checkEnvelope(response, await parseJson<NativeEnvelope<T>>(response, "Editor API"));
  }

  return {
    apiUrl,
    ssoUserInfoUrl,
    credentialKind: credential.kind,
    identity: (opts) => abortable(identity(), combinedSignal(opts?.timeoutMs ?? requestTimeoutMs, options.signal, opts?.signal)),
    get: (path, params, opts) => request(pathWithQuery(path, params), { method: "GET" }, opts?.timeoutMs ?? requestTimeoutMs, opts?.signal),
    post: (path, body, opts) => request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, opts?.timeoutMs ?? requestTimeoutMs, opts?.signal),
    postMultipart: (path, form, params, opts) => request(pathWithQuery(path, params), { method: "POST", body: form }, opts?.timeoutMs ?? importTimeoutMs, opts?.signal),
  };
}
