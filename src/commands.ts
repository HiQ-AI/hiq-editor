/** Agent-oriented Editor domain commands built from native API calls. */

import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { apiGet, apiPost, apiPostMultipart, resolveEditorIdentity } from "./apiClient.js";
import { readBytes } from "./files.js";
import { EditorClientError } from "./types.js";
import { inspectUprWorkbook, type UprWorkbookIdentity } from "./workbook.js";

const MIDDLE_FLOW_CATEGORY_UUID = "f4d1d8ab-e974-46a3-aa49-387029c473b";

type JsonObject = Record<string, unknown>;

export interface CommandResult {
  text: string;
  data: JsonObject;
}

export interface CommandDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  parser: z.AnyZodObject;
  readOnly: boolean;
  run: (input: Record<string, unknown>) => Promise<CommandResult>;
}

function defineCommand<T extends z.ZodRawShape>(definition: {
  name: string;
  description: string;
  schema: T;
  readOnly: boolean;
  run: (input: z.infer<z.ZodObject<T>>) => Promise<CommandResult>;
}): CommandDef {
  const parser = z.object(definition.schema).strict();
  return {
    ...definition,
    parser,
    run: (input) => definition.run(input as z.infer<z.ZodObject<T>>),
  };
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((item): item is JsonObject => Boolean(item)) : [];
}

function string(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function integer(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

async function datasourceRows(): Promise<JsonObject[]> {
  const response = await apiGet<unknown>("/datasourceInfo/getTenantDatasource");
  return array(response.data);
}

async function resolveDatasource(value: string): Promise<{ id: string; name: string; raw: JsonObject }> {
  const rows = await datasourceRows();
  const idMatches = rows.filter((row) => string(row.id) === value);
  if (idMatches.length === 1) {
    const row = idMatches[0]!;
    return { id: string(row.id), name: string(row.name), raw: row };
  }
  if (idMatches.length > 1) {
    throw new EditorClientError("upstream", `Datasource id '${value}' is duplicated by the Editor API.`);
  }
  const matches = rows.filter((row) => string(row.name) === value);
  if (matches.length !== 1) {
    throw new EditorClientError(
      matches.length === 0 ? "validation" : "upstream",
      matches.length === 0
        ? `Datasource '${value}' is not available to the current account.`
        : `Datasource '${value}' is ambiguous. Pass its id.`,
    );
  }
  const row = matches[0]!;
  return { id: string(row.id), name: string(row.name), raw: row };
}

async function listDatasources(): Promise<CommandResult> {
  const identity = await resolveEditorIdentity();
  const rows = await datasourceRows();
  const datasources = rows.map((row) => ({
    id: string(row.id),
    name: string(row.name),
    description: string(row.description) || null,
    code: string(row.code) || null,
  })).filter((row) => row.id && row.name);
  return {
    text: datasources.length
      ? datasources.map((row) => `[${row.id}] ${row.name}${row.description ? ` — ${row.description}` : ""}`).join("\n")
      : "No datasources are available to the current account.",
    data: {
      account: { user_id: identity.userId, user_name: identity.userName, tenant_id: identity.tenantId },
      datasources,
    },
  };
}

interface ProcessListInput {
  datasource: string;
  keyword?: string;
  process_id?: string;
  page: number;
  page_size: number;
  scope: "mine" | "tenant";
}

async function processRows(input: ProcessListInput): Promise<{
  datasource: { id: string; name: string };
  rows: JsonObject[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  const datasource = await resolveDatasource(input.datasource);
  const endpoint = input.scope === "tenant"
    ? "/dataWorkspace/getAdminWorkspacePage"
    : "/dataWorkspace/getWorkspacePage";
  const response = await apiPost<unknown>(endpoint, {
    dataAttribution: datasource.id,
    pageNo: input.page,
    pageSize: input.page_size,
    ...(input.keyword ? { queryKeyWord: input.keyword, processName: input.keyword } : {}),
    ...(input.process_id ? { processId: input.process_id, uuid: input.process_id } : {}),
    scene: 0,
  });
  return {
    datasource: { id: datasource.id, name: datasource.name },
    rows: array(response.data),
    total: integer(response.total) ?? 0,
    page: integer(response.page) ?? input.page,
    pageSize: integer(response.size) ?? input.page_size,
    totalPages: integer(response.totalPageNum) ?? 0,
  };
}

function normalizeProcess(row: JsonObject): JsonObject {
  return {
    id: string(row.id),
    uuid: string(row.uuid ?? row.processUuid) || null,
    name: string(row.name),
    reference_product: string(row.referenceProduct ?? row.middleFlowName) || null,
    location: string(row.locationName) || null,
    status: string(row.status) || null,
    status_code: string(row.statusCode) || null,
    calculated: Number(row.isCalculated) === 1,
    approval_status: row.approvalStatus ?? null,
    editor_id: string(row.editorId) || null,
    editor: string(row.editor) || null,
    changed_at: row.lastChangeTime ?? null,
  };
}

async function listProcesses(input: ProcessListInput): Promise<CommandResult> {
  const result = await processRows(input);
  const processes = result.rows.map(normalizeProcess).filter((row) => row.id && row.name);
  return {
    text: processes.length
      ? processes.map((row) => `[${String(row.id)}] ${String(row.name)} | ${String(row.status ?? "-")} | calculated=${String(row.calculated)}`).join("\n")
      : "No processes matched the query.",
    data: {
      datasource: result.datasource,
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
      total_pages: result.totalPages,
      processes,
    },
  };
}

async function processSection(processId: string, isShow: string): Promise<unknown> {
  const response = await apiPost<unknown>("/data/getNewDataDetails", {
    processId,
    scene: 0,
    isShow,
  });
  const data = object(response.data);
  return data?.[isShow];
}

async function showProcess(processId: string): Promise<CommandResult> {
  const [baseInfo, managerInfo, processData] = await Promise.all([
    processSection(processId, "baseInfo"),
    processSection(processId, "managerInfo"),
    processSection(processId, "processData"),
  ]);
  const base = object(baseInfo);
  if (!base || !string(base.id)) {
    throw new EditorClientError("validation", `Process '${processId}' was not found or is not visible.`);
  }
  const cores = array(processData);
  const cardResponses = await Promise.all(cores.map((core) => apiPost<unknown>(
    "/process/getProcessDataCardsByCore",
    { core: string(core.id), scene: 0, page: 1, size: 500 },
  )));
  const items = cardResponses.flatMap((response) => {
    const groups = object(response.data);
    if (!groups) return [];
    return Object.entries(groups).flatMap(([group, page]) => {
      const pageObject = object(page);
      const records = array(pageObject?.records ?? pageObject?.list ?? pageObject?.data);
      return records.map((row) => ({ ...row, group }));
    });
  });
  const status = string(base.status);
  const statusCode = string(base.statusCode);
  const calculated = Number(base.isCalculated) === 1;
  const submitted = /submit|review|approv|reject|审核|退回/i.test(`${status} ${statusCode}`)
    || !["", "process01"].includes(statusCode);
  const data = {
    process: normalizeProcess(base),
    base_info: base,
    management_info: object(managerInfo) ?? managerInfo ?? null,
    cores,
    items,
    counts: { cores: cores.length, items: items.length },
    calculated,
    submitted,
  };
  return {
    text: [
      `ID: ${string(base.id)}`,
      `Name: ${string(base.name)}`,
      `Status: ${status || statusCode || "-"}`,
      `Calculated: ${calculated ? "Calculated" : "Not calculated"}`,
      `Review: ${submitted ? "Submitted" : "Draft"}`,
      `Cores: ${cores.length}`,
      `Items: ${items.length}`,
    ].join("\n"),
    data,
  };
}

async function searchFlows(input: {
  keyword?: string;
  flow_type?: "ELEMENTARY_FLOW" | "PRODUCT_FLOW" | "WASTE_FLOW";
  category_id?: string;
  unit_group_id?: string;
  limit: number;
}): Promise<CommandResult> {
  const nativeType = input.flow_type === "ELEMENTARY_FLOW" ? "1" : input.flow_type ? "2" : undefined;
  const response = await apiPost<unknown>("/basicInfo/flow/choose/list", {
    name: input.keyword ?? "",
    flowType: nativeType ?? "2",
    categoryId: input.category_id,
    unitGroupId: input.unit_group_id,
    page: 1,
    size: input.limit,
  });
  const flows = array(response.data)
    .filter((row) => !input.flow_type || string(row.flowType) === input.flow_type)
    .map((row) => ({
      id: string(row.id),
      name: string(row.name),
      type: string(row.flowType),
      category_id: string(row.categoryId) || null,
      category: string(row.categoryName) || null,
      unit_id: string(row.unitId) || null,
      unit: string(row.unitName) || null,
      reference_flow_property_id: string(row.referenceFlowPropertyId) || null,
      synonyms: string(row.synonyms) || null,
      cas: string(row.cas) || null,
    }));
  return {
    text: flows.length ? flows.map((row) => `[${row.id}] ${row.name} | ${row.type} | ${row.unit ?? "-"}`).join("\n") : "No flows matched the query.",
    data: { total: integer(response.total) ?? flows.length, flows },
  };
}

async function productCategories(keyword: string, limit: number): Promise<CommandResult> {
  const numeric = /^\d{1,5}$/u.test(keyword);
  const response = await apiPost<unknown>("/categories/getCategoryByCode", {
    uuid: MIDDLE_FLOW_CATEGORY_UUID,
    ...(numeric ? { cpcCode: keyword } : { keyword }),
    pageNo: 1,
    pageSize: limit,
  });
  const summaries = array(response.data).slice(0, limit);
  const details = await Promise.all(summaries.map((row) => apiGet<unknown>(`/categories/detail/${encodeURIComponent(string(row.id))}`)));
  const categories = details.map((item) => object(item.data)).filter((row): row is JsonObject => Boolean(row)).map((row) => ({
    id: string(row.id),
    code: string(row.categoryCode ?? row.cpcCode),
    name: string(row.name),
    parent_id: string(row.parentCategoryId ?? row.pid) || null,
  })).filter((row) => /^\d{1,5}$/u.test(row.code) && row.name);
  return {
    text: categories.length ? categories.map((row) => `[${row.code}] ${row.name}`).join("\n") : "No product categories matched the query.",
    data: { categories },
  };
}

async function assertCompatibleReferenceFlow(
  flow: JsonObject,
  workbook: UprWorkbookIdentity,
): Promise<void> {
  if (string(flow.type) !== "PRODUCT_FLOW") {
    throw new EditorClientError(
      "validation",
      `Existing flow '${workbook.referenceProduct}' has type '${string(flow.type)}', not PRODUCT_FLOW.`,
    );
  }
  if (string(flow.unit) !== workbook.referenceUnit) {
    throw new EditorClientError(
      "validation",
      `Existing reference flow '${workbook.referenceProduct}' uses unit '${string(flow.unit)}', workbook uses '${workbook.referenceUnit}'.`,
    );
  }
  const response = await apiGet<unknown>("/basicInfo/flow/manage/attribute/list", {
    flowId: string(flow.id),
  });
  const references = array(response.data).filter((row) => row.isReferenceFlowProperty === true);
  if (references.length !== 1) {
    throw new EditorClientError(
      "validation",
      `Existing reference flow '${workbook.referenceProduct}' does not have exactly one reference flow property.`,
    );
  }
  const reference = references[0]!;
  if (string(reference.unitName) !== workbook.referenceUnit || Number(reference.val) !== 1) {
    throw new EditorClientError(
      "validation",
      `Existing reference flow '${workbook.referenceProduct}' has an incompatible reference property.`,
    );
  }
}

async function findReferenceProduct(workbook: UprWorkbookIdentity): Promise<JsonObject | undefined> {
  const found = await searchFlows({
    keyword: workbook.referenceProduct,
    flow_type: "PRODUCT_FLOW",
    limit: 100,
  });
  const exact = array(found.data.flows).filter((row) => string(row.name) === workbook.referenceProduct);
  if (exact.length > 1) {
    throw new EditorClientError("upstream", `Multiple PRODUCT_FLOW rows have the exact name '${workbook.referenceProduct}'.`);
  }
  return exact[0];
}

async function ensureReferenceProduct(
  workbook: UprWorkbookIdentity,
  categoryCode: string,
): Promise<{ flowId: string; created: boolean }> {
  const existing = await findReferenceProduct(workbook);
  if (existing) {
    await assertCompatibleReferenceFlow(existing, workbook);
    return { flowId: string(existing.id), created: false };
  }

  const categoryResult = await productCategories(categoryCode, 50);
  const categories = array(categoryResult.data.categories).filter((row) => string(row.code) === categoryCode);
  if (categories.length !== 1) {
    throw new EditorClientError("validation", `CPC category code '${categoryCode}' did not resolve uniquely.`);
  }
  const propertiesResponse = await apiGet<unknown>("/basicInfo/flow/manage/properties/list", {
    name: `Flow property for ${workbook.referenceUnit}`,
    page: 1,
    size: 100,
  });
  const properties = array(propertiesResponse.data).filter((row) =>
    string(row.unitName) === workbook.referenceUnit
      && string(row.name ?? row.flowName) === `Flow property for ${workbook.referenceUnit}`,
  );
  if (properties.length !== 1) {
    throw new EditorClientError(
      "validation",
      `Reference flow property for unit '${workbook.referenceUnit}' did not resolve uniquely.`,
    );
  }
  const category = categories[0]!;
  const property = properties[0]!;
  const body = {
    name: workbook.referenceProduct,
    variableName: "",
    category: string(category.id),
    middleCategoryId: "",
    middleRuleId: "",
    cas: "",
    unitId: string(property.unitId),
    synonyms: "",
    description: "Created by hiq-editor UPR import preflight.",
    flowType: "2",
    attributeInfos: [{
      flowName: string(property.name ?? property.flowName),
      flowId: "",
      id: string(property.id),
      val: 1,
      variable: "",
      flowUnit: string(property.unitId),
      unitName: workbook.referenceUnit,
      description: "",
      isReferenceFlowProperty: true,
    }],
  };
  try {
    await apiPost<unknown>("/basicInfo/flow/manage/add", body);
  } catch (error) {
    const winner = await findReferenceProduct(workbook);
    if (!winner) throw error;
    await assertCompatibleReferenceFlow(winner, workbook);
    return { flowId: string(winner.id), created: false };
  }
  const created = await findReferenceProduct(workbook);
  if (!created) {
    throw new EditorClientError("upstream", `Reference flow '${workbook.referenceProduct}' was not confirmed after creation.`);
  }
  await assertCompatibleReferenceFlow(created, workbook);
  if (string(created.category_id) !== string(category.id)) {
    throw new EditorClientError("upstream", `Reference flow '${workbook.referenceProduct}' was created with the wrong CPC category.`);
  }
  return { flowId: string(created.id), created: true };
}

async function importUpr(input: {
  file_path: string;
  datasource: string;
  product_category_code: string;
  need_desensitize: boolean;
}): Promise<CommandResult> {
  const bytes = await readBytes(input.file_path);
  const workbook = await inspectUprWorkbook(bytes);
  const datasource = await resolveDatasource(input.datasource);
  const referenceFlow = await ensureReferenceProduct(workbook, input.product_category_code);
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], basename(input.file_path), {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));
  const response = await apiPostMultipart<Record<string, unknown>>(
    `/process/excelImportUpr/${encodeURIComponent(datasource.id)}/0`,
    form,
    { needDesensitize: input.need_desensitize },
  );
  const importResult = object(response.data);
  const processId = string(importResult?.processId);
  if (!processId) {
    throw new EditorClientError(
      "upstream",
      "UPR import succeeded without returning data.processId; the native Editor API contract is incomplete.",
      "import_result_missing",
    );
  }
  const detail = await showProcess(processId);
  return {
    text: [
      "UPR import completed and read back.",
      `ID: ${processId}`,
      `Name: ${workbook.processName}`,
      `Datasource: ${datasource.name} (${datasource.id})`,
      `Reference flow: ${referenceFlow.flowId}${referenceFlow.created ? " (created)" : " (reused)"}`,
      `Cores: ${String(object(detail.data.counts)?.cores ?? 0)}`,
      `Items: ${String(object(detail.data.counts)?.items ?? 0)}`,
    ].join("\n"),
    data: {
      process_id: processId,
      process_name: string(importResult?.processName) || workbook.processName,
      created: importResult?.created === true,
      has_sensitive: importResult?.hasSensitive === true,
      sensitive_items: array(importResult?.items),
      datasource: { id: datasource.id, name: datasource.name },
      reference_product: workbook.referenceProduct,
      reference_flow_id: referenceFlow.flowId,
      reference_flow_created: referenceFlow.created,
      readback: detail.data,
    },
  };
}

async function trialCalculate(processId: string): Promise<CommandResult> {
  const before = await showProcess(processId);
  const process = object(before.data.process)!;
  const processName = string(process.name);
  if (before.data.calculated === true) {
    return { text: `Process '${processName}' (${processId}) is already calculated.\nStatus: isCalculated=1`, data: { process_id: processId, calculated: true, reused: true } };
  }
  if (integer(object(before.data.counts)?.items) === 0) {
    throw new EditorClientError("validation", `Process '${processName}' has no process items.`);
  }
  const body = { processId, processName };
  await apiPost<unknown>("/calculation/check", body, 180_000);
  await apiPost<unknown>("/calculation/add", body, 180_000);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const readback = await showProcess(processId);
    if (readback.data.calculated === true) {
      return {
        text: `Calculation completed successfully.\nProcess: ${processName} (${processId})\nStatus: isCalculated=1`,
        data: { process_id: processId, process_name: processName, calculated: true, readback: readback.data },
      };
    }
    await delay(1_000);
  }
  throw new EditorClientError(
    "upstream",
    `Calculation was accepted but process '${processId}' was not confirmed as calculated within the readback window.`,
    "calculation_readback_pending",
  );
}

async function submitReview(processId: string): Promise<CommandResult> {
  const before = await showProcess(processId);
  const process = object(before.data.process)!;
  const processName = string(process.name);
  if (before.data.submitted === true) {
    return { text: `Process '${processName}' (${processId}) is already submitted for review.`, data: { process_id: processId, submitted: true, reused: true } };
  }
  if (before.data.calculated !== true) {
    throw new EditorClientError("validation", `Process '${processName}' must be calculated before review submission.`);
  }
  await apiPost<unknown>("/approval/submit", { processId });
  const readback = await showProcess(processId);
  if (readback.data.submitted !== true) {
    throw new EditorClientError(
      "upstream",
      `Review submission returned success but process '${processId}' still reads as draft.`,
      "review_readback_pending",
    );
  }
  return {
    text: `Process '${processName}' (${processId}) submitted for review.`,
    data: { process_id: processId, process_name: processName, submitted: true, readback: readback.data },
  };
}

const optionalText = z.string().trim().min(1).max(240).optional();

export const commandDefs: CommandDef[] = [
  defineCommand({
    name: "datasources_list",
    description: "List Editor datasources available to the authenticated account.",
    schema: {},
    readOnly: true,
    run: () => listDatasources(),
  }),
  defineCommand({
    name: "processes_list",
    description: "List processes through the native Editor workspace API.",
    schema: {
      datasource: z.string().trim().min(1).max(200),
      keyword: optionalText,
      process_id: optionalText,
      page: z.number().int().min(1).default(1),
      page_size: z.number().int().min(1).max(100).default(20),
      scope: z.enum(["mine", "tenant"]).default("mine"),
    },
    readOnly: true,
    run: (input) => listProcesses(input),
  }),
  defineCommand({
    name: "process_show",
    description: "Aggregate process basics, management metadata, cores and items into one readback.",
    schema: { process_id: z.string().trim().min(1).max(200) },
    readOnly: true,
    run: (input) => showProcess(input.process_id),
  }),
  defineCommand({
    name: "flows_search",
    description: "Search Editor flows with stable ids, type, category and unit fields.",
    schema: {
      keyword: optionalText,
      flow_type: z.enum(["ELEMENTARY_FLOW", "PRODUCT_FLOW", "WASTE_FLOW"]),
      category_id: optionalText,
      unit_group_id: optionalText,
      limit: z.number().int().min(1).max(200).default(50),
    },
    readOnly: true,
    run: (input) => searchFlows(input),
  }),
  defineCommand({
    name: "product_categories_search",
    description: "Search tenant CPC product categories and return verified category codes.",
    schema: {
      keyword: z.string().trim().min(1).max(120),
      limit: z.number().int().min(1).max(50).default(20),
    },
    readOnly: true,
    run: (input) => productCategories(input.keyword, input.limit),
  }),
  defineCommand({
    name: "upr_import",
    description: "Inspect, preflight, import and read back one official UPR workbook.",
    schema: {
      file_path: z.string().trim().min(1).max(4_096),
      datasource: z.string().trim().min(1).max(200),
      product_category_code: z.string().regex(/^\d{1,5}$/u),
      need_desensitize: z.boolean().default(false),
    },
    readOnly: false,
    run: (input) => importUpr(input),
  }),
  defineCommand({
    name: "process_trial_calculate",
    description: "Preflight, trial-calculate and confirm one Editor process.",
    schema: { process_id: z.string().trim().min(1).max(200) },
    readOnly: false,
    run: (input) => trialCalculate(input.process_id),
  }),
  defineCommand({
    name: "process_submit_review",
    description: "Verify calculation, submit one process for review and confirm its workflow state.",
    schema: { process_id: z.string().trim().min(1).max(200) },
    readOnly: false,
    run: (input) => submitReview(input.process_id),
  }),
];

export const commandsByName = new Map(commandDefs.map((command) => [command.name, command]));

export function commandCatalog(): Array<{
  name: string;
  description: string;
  inputSchema: JsonObject;
  readOnly: boolean;
}> {
  return commandDefs.map((command) => ({
    name: command.name,
    description: command.description,
    inputSchema: zodToJsonSchema(command.parser, {
      $refStrategy: "none",
      target: "jsonSchema7",
    }) as JsonObject,
    readOnly: command.readOnly,
  }));
}

export async function executeCommand(name: string, rawInput: unknown): Promise<CommandResult> {
  const command = commandsByName.get(name);
  if (!command) throw new EditorClientError("validation", `Unknown Editor command '${name}'.`);
  const parsed = command.parser.safeParse(rawInput);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    throw new EditorClientError("validation", `Invalid arguments for '${name}': ${details}`);
  }
  return command.run(parsed.data);
}
