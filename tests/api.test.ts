import assert from "node:assert/strict";
import test from "node:test";
import { createEditorClient, EditorClientError } from "../src/api.js";
import { executeCommand } from "../src/commands.js";
import { config } from "../src/config.js";

type FetchHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function ok(data: unknown = null, extra: Record<string, unknown> = {}): Response {
  return json({ success: true, code: "200", message: "成功", data, ...extra });
}
function sso(userId: string, tenantId: string): Response {
  return json({ code: 200, data: { user: { id: userId, name: `User ${userId}`, currentTenant: { id: tenantId, name: `Tenant ${tenantId}` } } } });
}

test("api: two clients with different tokens resolve different identities and never share them", async () => {
  const seenAuth: string[] = [];
  const fetchFn: FetchHandler = (url, init) => {
    const headers = new Headers(init.headers);
    if (url.pathname === "/api/sso/user/info/current") {
      const token = headers.get("authorization") ?? "";
      seenAuth.push(token);
      return sso(`user-of-${token}`, `tenant-of-${token}`);
    }
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") {
      return ok([{ id: `ds-${headers.get("userId")}`, name: "HiQ" }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const a = createEditorClient({ token: "tok-a", fetch: (input, init) => fetchFn(new URL(String(input)), init ?? {}) });
  const b = createEditorClient({ token: "tok-b", fetch: (input, init) => fetchFn(new URL(String(input)), init ?? {}) });
  const [ra, rb] = await Promise.all([a.datasourcesList(), b.datasourcesList()]);
  assert.equal((ra.data.account as { user_id: string }).user_id, "user-of-tok-a");
  assert.equal((rb.data.account as { user_id: string }).user_id, "user-of-tok-b");
  assert.deepEqual((ra.data.datasources as { id: string }[])[0]?.id, "ds-user-of-tok-a");
  assert.deepEqual((rb.data.datasources as { id: string }[])[0]?.id, "ds-user-of-tok-b");
  // identity resolved once per client even across two more calls
  await Promise.all([a.datasourcesList(), b.datasourcesList()]);
  assert.deepEqual(seenAuth.sort(), ["tok-a", "tok-b"]);
});

test("api: reads no environment — a client built with an explicit token ignores HIQ_EDITOR_* and the CLI default cache", async () => {
  const previous = { ...process.env };
  process.env.HIQ_EDITOR_TOKEN = "env-token-must-not-be-used";
  process.env.HIQ_EDITOR_API_URL = "https://env.invalid/api/dataset";
  try {
    const calls: string[] = [];
    const client = createEditorClient({
      token: "explicit-token",
      apiUrl: "https://explicit.example/api/dataset",
      ssoUserInfoUrl: "https://explicit.example/api/sso/user/info/current",
      fetch: (input, init) => {
        const url = new URL(String(input));
        calls.push(`${url.host}${url.pathname}:${new Headers(init?.headers).get("authorization") ?? ""}`);
        if (url.pathname.endsWith("/sso/user/info/current")) return sso("u", "t");
        return ok([]);
      },
    });
    await client.datasourcesList();
    assert.ok(calls.every((call) => call.startsWith("explicit.example") && call.endsWith(":explicit-token")), calls.join("\n"));
  } finally {
    process.env = previous;
  }
});

test("api: client-level signal aborts in-flight requests as a transport error; per-call signal too", async () => {
  const controller = new AbortController();
  const client = createEditorClient({
    token: "tok",
    signal: controller.signal,
    fetch: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  });
  const pending = client.datasourcesList();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof EditorClientError && error.kind === "transport");

  const perCall = new AbortController();
  const client2 = createEditorClient({
    token: "tok",
    fetch: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  });
  const pending2 = client2.processShow("p-1", { signal: perCall.signal });
  perCall.abort();
  await assert.rejects(pending2, (error: unknown) => error instanceof EditorClientError && error.kind === "transport");
});

test("api: per-call timeout wins over the client default", async () => {
  const client = createEditorClient({
    token: "tok",
    requestTimeoutMs: 60_000,
    fetch: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
    }),
  });
  const started = Date.now();
  await assert.rejects(client.datasourcesList({ timeoutMs: 50 }), (error: unknown) => error instanceof EditorClientError && error.kind === "transport");
  assert.ok(Date.now() - started < 5_000);
});

test("api: input validation, unknown command and error kinds/codes match the CLI contract", async () => {
  const client = createEditorClient({
    token: "tok",
    fetch: (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/sso/user/info/current")) return sso("u", "t");
      if (url.pathname.endsWith("/data/getNewDataDetails")) return ok({ baseInfo: null, managerInfo: null, processData: [] });
      return json({ success: false, code: "E_UP", message: "boom" }, 500);
    },
  });
  await assert.rejects(client.execute("nope", {}), (e: unknown) => e instanceof EditorClientError && e.kind === "validation");
  await assert.rejects(client.uprPreflight({ file_path: "relative.xlsx", datasource: "GBA", product_category_code: "12" } as never), (e: unknown) => e instanceof EditorClientError && e.kind === "validation");
  await assert.rejects(client.processShow("missing"), (e: unknown) => e instanceof EditorClientError && e.kind === "validation" && /not found or is not visible/u.test(e.message));
  await assert.rejects(client.productCategoriesSearch("steel"), (e: unknown) => e instanceof EditorClientError && e.kind === "upstream" && e.code === "E_UP");
});

test("api: credential rules — token/apiKey exclusive, missing credential is a config error, catalog equals CLI catalog", () => {
  assert.throws(() => createEditorClient({ token: "a", apiKey: "b" }), (e: unknown) => e instanceof EditorClientError && e.kind === "config");
  assert.throws(() => createEditorClient({}), (e: unknown) => e instanceof EditorClientError && e.kind === "config");
  const client = createEditorClient({ apiKey: "k" });
  assert.deepEqual(client.catalog().map((c) => c.name), [
    "datasources_list", "processes_list", "process_show", "flows_search", "product_categories_search",
    "upr_preflight", "upr_import", "process_trial_calculate", "process_submit_review",
  ]);
});

test("cli default path still reads config and caches identity per credential (regression guard for executeCommand)", async () => {
  config.credential = { kind: "access-token", value: "cli-token", source: "env" };
  const { resetIdentityCache } = await import("../src/commands.js");
  resetIdentityCache();
  const original = globalThis.fetch;
  let ssoCalls = 0;
  globalThis.fetch = (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/sso/user/info/current")) { ssoCalls += 1; return Promise.resolve(sso("cli", "t")); }
    return Promise.resolve(ok([]));
  };
  try {
    await executeCommand("datasources_list", {});
    await executeCommand("datasources_list", {});
    assert.equal(ssoCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
