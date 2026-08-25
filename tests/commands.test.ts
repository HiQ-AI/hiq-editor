import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { resetIdentityCache, unwrapSsoToken } from "../src/apiClient.js";
import { commandCatalog, executeCommand } from "../src/commands.js";
import { config } from "../src/config.js";
import { ensureDataItems } from "../src/dataItems.js";
import { inspectUprWorkbook } from "../src/workbook.js";

type FetchHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function ok(data: unknown = null, extra: Record<string, unknown> = {}): Response {
  return json({ success: true, code: "200", message: "成功", data, ...extra });
}

function installFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => handler(new URL(String(input)), init);
  return () => { globalThis.fetch = original; };
}

function sso(): Response {
  return json({
    code: 200,
    data: {
      user: {
        id: "user-1",
        name: "Test User",
        currentTenant: { id: "tenant-1", name: "Test Tenant" },
      },
    },
  });
}

function testCredential(kind: "access-token" | "api-key" = "access-token"): void {
  config.credential = { kind, value: "opaque-credential", source: "env" };
  resetIdentityCache();
}

function compatibleReferenceProperty(): Response {
  return ok([{
    id: "property-1",
    name: "Flow property for kg",
    unitId: "unit-1",
    unitName: "kg",
    val: 1,
    isReferenceFlowProperty: true,
  }]);
}

function existingDataItem(url: URL, init: RequestInit): Response | undefined {
  if (url.pathname !== "/api/dataset/mElement/getPageElementBykeyword") return undefined;
  const body = JSON.parse(String(init.body)) as { keyword: string };
  return ok([{ id: `element-${body.keyword}`, name: body.keyword }], { total: 1 });
}

async function workbookBytes(extraRows: string[][] = []): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const basic = workbook.addWorksheet("基本信息");
  basic.addRow(["产品", "聚丙烯"]);
  basic.addRow(["技术路线/工艺路径", "悬浮法"]);
  basic.addRow(["参考产品", "聚丙烯"]);
  const process = workbook.addWorksheet("P-生产");
  process.addRow(["数据项名称", "数据项分类", "单位名称"]);
  process.addRow(["聚丙烯", "产品", "kg"]);
  for (const row of extraRows) process.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("command catalog is explicit and agent-oriented", () => {
  const commands = commandCatalog();
  assert.deepEqual(commands.map((command) => command.name), [
    "datasources_list",
    "processes_list",
    "process_show",
    "flows_search",
    "product_categories_search",
    "upr_preflight",
    "upr_import",
    "process_trial_calculate",
    "process_submit_review",
  ]);
  assert.equal(commands.find((command) => command.name === "upr_preflight")?.readOnly, true);
  assert.equal(commands.find((command) => command.name === "upr_import")?.readOnly, false);
});

test("Cortex delegation JWT unwraps only its sso_token claim", () => {
  const payload = Buffer.from(JSON.stringify({ sso_token: "real-token", sub: "user-1" })).toString("base64url");
  assert.equal(unwrapSsoToken(`eyJ.${payload}.sig`), "real-token");
  assert.equal(unwrapSsoToken("opaque"), "opaque");
});

test("workbook inspection derives backend-compatible process identity", async () => {
  assert.deepEqual(await inspectUprWorkbook(await workbookBytes()), {
    processName: "聚丙烯,悬浮法",
    referenceProduct: "聚丙烯",
    referenceUnit: "kg",
    dataItemNames: ["聚丙烯"],
  });
});

test("datasources_list resolves SSO once and calls the native API with userId", async () => {
  testCredential("api-key");
  const calls: Array<{ url: string; headers: Headers }> = [];
  const restore = installFetch((url, init) => {
    calls.push({ url: url.href, headers: new Headers(init.headers) });
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") {
      return ok([{ id: "ds-1", name: "HiQ", description: "Primary" }]);
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await executeCommand("datasources_list", {});
    assert.deepEqual(result.data.datasources, [{ id: "ds-1", name: "HiQ", description: "Primary", code: null }]);
    assert.equal(calls[1]!.headers.get("userId"), "user-1");
    assert.equal(calls[1]!.headers.get("Authorization"), "opaque-credential");
    assert.equal(calls[1]!.headers.get("X-API-Key"), "opaque-credential");
  } finally {
    restore();
  }
});

test("datasource id remains unambiguous when the account has duplicate display names", async () => {
  testCredential();
  const restore = installFetch(async (url) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") {
      return ok([{ id: "ds-1", name: "HiQ" }, { id: "ds-2", name: "HiQ" }]);
    }
    if (url.pathname === "/api/dataset/dataWorkspace/getWorkspacePage") {
      return ok([], { total: 0, page: 1, size: 20, totalPageNum: 0 });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await executeCommand("processes_list", {
      datasource: "ds-2", page: 1, page_size: 20, scope: "mine",
    });
    assert.deepEqual(result.data.datasource, { id: "ds-2", name: "HiQ" });
    await assert.rejects(() => executeCommand("processes_list", {
      datasource: "HiQ", page: 1, page_size: 20, scope: "mine",
    }), /ambiguous/);
  } finally {
    restore();
  }
});

test("process_show aggregates three detail sections and all core cards", async () => {
  testCredential();
  const restore = installFetch(async (url, init) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/data/getNewDataDetails") {
      const body = JSON.parse(String(init.body)) as { isShow: string };
      if (body.isShow === "baseInfo") return ok({ baseInfo: { id: "p-1", name: "PP", statusCode: "process01", isCalculated: 0 } });
      if (body.isShow === "managerInfo") return ok({ managerInfo: { licenseType: "FREE_ALL" } });
      return ok({ processData: [{ id: "core-1", name: "Production" }] });
    }
    if (url.pathname === "/api/dataset/process/getProcessDataCardsByCore") {
      return ok({ products: { records: [{ id: "item-1", elementName: "PP" }], total: 1 } });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await executeCommand("process_show", { process_id: "p-1" });
    assert.deepEqual(result.data.counts, { cores: 1, items: 1 });
    assert.equal(result.data.calculated, false);
    assert.equal(result.data.submitted, false);
  } finally {
    restore();
  }
});

test("upr_import uses the committed process identity returned by the native API", async () => {
  testCredential();
  const work = await mkdtemp(join(tmpdir(), "hiq-editor-test-"));
  const path = join(work, "upr.xlsx");
  await writeFile(path, await workbookBytes());
  let includeDataItemIdentity = true;
  const restore = installFetch(async (url, init) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    const item = existingDataItem(url, init);
    if (item) return item;
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") return ok([{ id: "ds-1", name: "HiQ" }]);
    if (url.pathname === "/api/dataset/basicInfo/flow/choose/list") {
      return ok([{ id: "flow-1", name: "聚丙烯", flowType: "PRODUCT_FLOW", categoryId: "category-1", unitId: "unit-1", unitName: "kg" }], { total: 1 });
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/manage/attribute/list") return compatibleReferenceProperty();
    if (url.pathname === "/api/dataset/process/excelImportUpr/ds-1/0") {
      assert.ok(init.body instanceof FormData);
      return ok({ processId: "p-1", processName: "聚丙烯,悬浮法", created: true, hasSensitive: false, items: [] });
    }
    if (url.pathname === "/api/dataset/data/getNewDataDetails") {
      const body = JSON.parse(String(init.body)) as { isShow: string };
      if (body.isShow === "baseInfo") return ok({ baseInfo: { id: "p-1", name: "聚丙烯,悬浮法", statusCode: "process01", isCalculated: 0 } });
      if (body.isShow === "managerInfo") return ok({ managerInfo: {} });
      return ok({ processData: [{ id: "core-1" }] });
    }
    if (url.pathname === "/api/dataset/process/getProcessDataCardsByCore") {
      return ok({ products: { records: [{
        id: "item-1",
        elementName: "聚丙烯",
        ...(includeDataItemIdentity ? { elementId: "element-聚丙烯" } : {}),
      }], total: 1 } });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await executeCommand("upr_import", {
      file_path: path,
      datasource: "HiQ",
      product_category_code: "123",
    });
    assert.equal(result.data.process_id, "p-1");
    assert.equal(result.data.created, true);
    assert.equal(result.data.has_sensitive, false);
    assert.equal(result.data.reference_flow_created, false);
    assert.equal(result.data.data_items_created, 0);
    assert.match(result.text, /^UPR import completed and read back\./);
    includeDataItemIdentity = false;
    await assert.rejects(
      () => executeCommand("upr_import", {
        file_path: path,
        datasource: "HiQ",
        product_category_code: "123",
      }),
      /readback is missing data-item identity/,
    );
  } finally {
    restore();
    await rm(work, { recursive: true, force: true });
  }
});

test("upr_preflight resolves every import prerequisite without creating a dataset process", async () => {
  testCredential();
  const work = await mkdtemp(join(tmpdir(), "hiq-editor-test-"));
  const path = join(work, "upr.xlsx");
  await writeFile(path, await workbookBytes([["电力", "能源", "kWh"]]));
  const calls: string[] = [];
  const restore = installFetch(async (url, init) => {
    calls.push(url.pathname);
    if (url.pathname === "/api/sso/user/info/current") return sso();
    const item = existingDataItem(url, init);
    if (item) return item;
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") return ok([{ id: "ds-1", name: "HiQ" }]);
    if (url.pathname === "/api/dataset/basicInfo/flow/choose/list") {
      return ok([{ id: "flow-1", name: "聚丙烯", flowType: "PRODUCT_FLOW", categoryId: "category-1", unitId: "unit-1", unitName: "kg" }], { total: 1 });
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/manage/attribute/list") return compatibleReferenceProperty();
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await executeCommand("upr_preflight", {
      file_path: path,
      datasource: "ds-1",
      product_category_code: "123",
    });
    assert.equal(result.data.process_created, false);
    assert.equal(result.data.external_writes, false);
    assert.deepEqual(result.data.datasource, { id: "ds-1", name: "HiQ" });
    assert.equal(result.data.reference_flow_id, "flow-1");
    assert.deepEqual((result.data.workbook as Record<string, unknown>).data_item_names, ["电力", "聚丙烯"]);
    assert.equal(calls.some((pathname) => pathname.includes("excelImportUpr")), false);
  } finally {
    restore();
    await rm(work, { recursive: true, force: true });
  }
});

test("upr_preflight reports missing identities without creating them", async () => {
  testCredential();
  const work = await mkdtemp(join(tmpdir(), "hiq-editor-test-"));
  const path = join(work, "upr.xlsx");
  await writeFile(path, await workbookBytes());
  const calls: string[] = [];
  const restore = installFetch(async (url) => {
    calls.push(url.pathname);
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/mElement/getPageElementBykeyword") return ok([], { total: 0 });
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") return ok([{ id: "ds-1", name: "HiQ" }]);
    if (url.pathname === "/api/dataset/basicInfo/flow/choose/list") return ok([], { total: 0 });
    if (url.pathname === "/api/dataset/categories/getCategoryByCode") return ok([{ id: "category-1", name: "Plastic" }]);
    if (url.pathname === "/api/dataset/categories/detail/category-1") {
      return ok({ id: "category-1", categoryCode: "123", name: "Plastic" });
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/manage/properties/list") {
      return ok([{ id: "property-1", name: "Flow property for kg", unitId: "unit-1", unitName: "kg" }]);
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await executeCommand("upr_preflight", {
      file_path: path,
      datasource: "ds-1",
      product_category_code: "123",
    });
    assert.equal(result.data.process_created, false);
    assert.equal(result.data.external_writes, false);
    assert.equal(result.data.reference_flow_id, null);
    assert.equal(result.data.reference_flow_exists, false);
    assert.equal(result.data.data_items_missing, 1);
    assert.equal(calls.includes("/api/dataset/dataHouseCommon/addRemoteDataItem"), false);
    assert.equal(calls.includes("/api/dataset/basicInfo/flow/manage/add"), false);
    assert.equal(calls.some((pathname) => pathname.includes("excelImportUpr")), false);
  } finally {
    restore();
    await rm(work, { recursive: true, force: true });
  }
});

test("data-item preflight reuses existing rows and creates each missing normalized name once", async () => {
  testCredential();
  const persisted = new Map([["已有物料", "element-existing"]]);
  const creates: string[] = [];
  const restore = installFetch(async (url, init) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/mElement/getPageElementBykeyword") {
      const body = JSON.parse(String(init.body)) as { keyword: string };
      const id = persisted.get(body.keyword);
      return ok(id ? [{ id, name: body.keyword }] : [], { total: id ? 1 : 0 });
    }
    if (url.pathname === "/api/dataset/dataHouseCommon/addRemoteDataItem") {
      const body = JSON.parse(String(init.body)) as { name: string };
      creates.push(body.name);
      persisted.set(body.name, `element-${body.name}`);
      return ok();
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await ensureDataItems([" 新物料 ", "已有物料", "新物料"]);
    assert.deepEqual(new Set(result.map((item) => item.name)), new Set(["已有物料", "新物料"]));
    assert.deepEqual(creates, ["新物料"]);
    assert.equal(result.find((item) => item.name === "已有物料")?.created, false);
    assert.equal(result.find((item) => item.name === "新物料")?.created, true);
  } finally {
    restore();
  }
});

test("data-item preflight accepts a concurrent creator only after exact readback", async () => {
  testCredential();
  let persisted = false;
  const restore = installFetch(async (url, init) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/mElement/getPageElementBykeyword") {
      return ok(persisted ? [{ id: "element-winner", name: "并发物料" }] : [], { total: persisted ? 1 : 0 });
    }
    if (url.pathname === "/api/dataset/dataHouseCommon/addRemoteDataItem") {
      persisted = true;
      return json({ success: false, code: "409", message: "already exists" }, 409);
    }
    throw new Error(`unexpected ${url} ${String(init.body)}`);
  });
  try {
    assert.deepEqual(await ensureDataItems(["并发物料"]), [{ id: "element-winner", name: "并发物料", created: false }]);
  } finally {
    restore();
  }
});

test("data-item preflight fails closed on duplicate exact identities", async () => {
  testCredential();
  const restore = installFetch(async (url) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/mElement/getPageElementBykeyword") {
      return ok([{ id: "a", name: "重复物料" }, { id: "b", name: "重复物料" }], { total: 2 });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    await assert.rejects(() => ensureDataItems(["重复物料"]), /is not unique/);
  } finally {
    restore();
  }
});

test("upr_import creates and confirms a missing reference-product flow", async () => {
  testCredential();
  const work = await mkdtemp(join(tmpdir(), "hiq-editor-test-"));
  const path = join(work, "upr.xlsx");
  await writeFile(path, await workbookBytes());
  let flowReads = 0;
  const restore = installFetch(async (url, init) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    const item = existingDataItem(url, init);
    if (item) return item;
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") return ok([{ id: "ds-1", name: "HiQ" }]);
    if (url.pathname === "/api/dataset/basicInfo/flow/choose/list") {
      flowReads += 1;
      return flowReads === 1
        ? ok([], { total: 0 })
        : ok([{ id: "flow-new", name: "聚丙烯", flowType: "PRODUCT_FLOW", categoryId: "category-1", unitId: "unit-1", unitName: "kg" }], { total: 1 });
    }
    if (url.pathname === "/api/dataset/categories/getCategoryByCode") return ok([{ id: "category-1", name: "Plastic" }]);
    if (url.pathname === "/api/dataset/categories/detail/category-1") {
      return ok({ id: "category-1", categoryCode: "123", name: "Plastic" });
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/manage/properties/list") {
      return ok([{ id: "property-1", name: "Flow property for kg", unitId: "unit-1", unitName: "kg" }]);
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/manage/add") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.name, "聚丙烯");
      assert.equal(body.flowType, "2");
      assert.equal(body.category, "category-1");
      assert.equal(body.unitId, "unit-1");
      return ok({ id: "flow-new" });
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/manage/attribute/list") return compatibleReferenceProperty();
    if (url.pathname === "/api/dataset/process/excelImportUpr/ds-1/0") {
      return ok({ processId: "p-new", processName: "聚丙烯,悬浮法", created: true, hasSensitive: false, items: [] });
    }
    if (url.pathname === "/api/dataset/data/getNewDataDetails") {
      const body = JSON.parse(String(init.body)) as { isShow: string };
      if (body.isShow === "baseInfo") return ok({ baseInfo: { id: "p-new", name: "聚丙烯,悬浮法", statusCode: "process01", isCalculated: 0 } });
      if (body.isShow === "managerInfo") return ok({ managerInfo: {} });
      return ok({ processData: [{ id: "core-1" }] });
    }
    if (url.pathname === "/api/dataset/process/getProcessDataCardsByCore") {
      return ok({ products: { records: [{ id: "item-1", elementId: "element-聚丙烯", elementName: "聚丙烯" }] } });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const result = await executeCommand("upr_import", {
      file_path: path,
      datasource: "HiQ",
      product_category_code: "123",
    });
    assert.equal(result.data.reference_flow_id, "flow-new");
    assert.equal(result.data.reference_flow_created, true);
  } finally {
    restore();
    await rm(work, { recursive: true, force: true });
  }
});

test("upr_import fails closed when the native API omits the committed process id", async () => {
  testCredential();
  const work = await mkdtemp(join(tmpdir(), "hiq-editor-test-"));
  const path = join(work, "upr.xlsx");
  await writeFile(path, await workbookBytes());
  const restore = installFetch(async (url, init) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    const item = existingDataItem(url, init);
    if (item) return item;
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") {
      return ok([{ id: "ds-1", name: "HiQ" }]);
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/choose/list") {
      return ok([{ id: "flow-1", name: "聚丙烯", flowType: "PRODUCT_FLOW", unitName: "kg" }], { total: 1 });
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/manage/attribute/list") return compatibleReferenceProperty();
    if (url.pathname === "/api/dataset/process/excelImportUpr/ds-1/0") return ok();
    throw new Error(`unexpected ${url}`);
  });
  try {
    await assert.rejects(
      () => executeCommand("upr_import", {
        file_path: path,
        datasource: "HiQ",
        product_category_code: "123",
      }),
      /without returning data\.processId/,
    );
  } finally {
    restore();
    await rm(work, { recursive: true, force: true });
  }
});

test("upr_import rejects a same-name reference flow with an incompatible reference factor", async () => {
  testCredential();
  const work = await mkdtemp(join(tmpdir(), "hiq-editor-test-"));
  const path = join(work, "upr.xlsx");
  await writeFile(path, await workbookBytes());
  const restore = installFetch(async (url, init) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    const item = existingDataItem(url, init);
    if (item) return item;
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") return ok([{ id: "ds-1", name: "HiQ" }]);
    if (url.pathname === "/api/dataset/basicInfo/flow/choose/list") {
      return ok([{ id: "flow-1", name: "聚丙烯", flowType: "PRODUCT_FLOW", unitName: "kg" }], { total: 1 });
    }
    if (url.pathname === "/api/dataset/basicInfo/flow/manage/attribute/list") {
      return ok([{ unitName: "kg", val: 0.001, isReferenceFlowProperty: true }]);
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    await assert.rejects(
      () => executeCommand("upr_import", { file_path: path, datasource: "HiQ", product_category_code: "123" }),
      /incompatible reference property/,
    );
  } finally {
    restore();
    await rm(work, { recursive: true, force: true });
  }
});

test("trial calculation and review submission are confirmed by native readback", async () => {
  testCredential();
  let calculated = false;
  let submitted = false;
  const restore = installFetch(async (url, init) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/data/getNewDataDetails") {
      const body = JSON.parse(String(init.body)) as { isShow: string };
      if (body.isShow === "baseInfo") return ok({ baseInfo: {
        id: "p-1", name: "PP", statusCode: submitted ? "process02" : "process01", isCalculated: calculated ? 1 : 0,
      } });
      if (body.isShow === "managerInfo") return ok({ managerInfo: {} });
      return ok({ processData: [{ id: "core-1" }] });
    }
    if (url.pathname === "/api/dataset/process/getProcessDataCardsByCore") return ok({ products: { records: [{ id: "item-1" }] } });
    if (url.pathname === "/api/dataset/calculation/check") return ok();
    if (url.pathname === "/api/dataset/calculation/add") { calculated = true; return ok(); }
    if (url.pathname === "/api/dataset/approval/submit") { submitted = true; return ok(); }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const calculation = await executeCommand("process_trial_calculate", { process_id: "p-1" });
    assert.equal(calculation.data.calculated, true);
    const review = await executeCommand("process_submit_review", { process_id: "p-1" });
    assert.equal(review.data.submitted, true);
  } finally {
    restore();
  }
});

test("unknown and extra arguments fail closed", async () => {
  await assert.rejects(() => executeCommand("missing", {}), /Unknown Editor command/);
  await assert.rejects(
    () => executeCommand("process_show", { process_id: "p-1", sql: "select 1" }),
    /Unrecognized key/,
  );
  await assert.rejects(
    () => executeCommand("flows_search", { keyword: "water" }),
    /flow_type: Required/,
  );
});

test("native success=false envelopes fail closed even with code 200", async () => {
  testCredential();
  const restore = installFetch((url) => {
    if (url.pathname === "/api/sso/user/info/current") return sso();
    if (url.pathname === "/api/dataset/datasourceInfo/getTenantDatasource") {
      return json({ success: false, code: "200", message: "permission denied" });
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    await assert.rejects(() => executeCommand("datasources_list", {}), /permission denied/);
  } finally {
    restore();
  }
});
