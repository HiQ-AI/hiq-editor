/**
 * Programmatic API — embed hiq-editor in a host process instead of spawning the CLI.
 *
 *   import { createEditorClient } from "@hiq-ai/hiq-editor/api";
 *   const editor = createEditorClient({ token: delegatedSsoToken, signal: caseSignal });
 *   const preflight = await editor.uprPreflight({ file_path, datasource, product_category_code });
 *
 * Guarantees the CLI cannot give a long-lived multi-tenant host:
 *   - reads NO environment variables and touches NO login store: the credential is the argument;
 *   - one client = one identity; SSO identity is resolved lazily once per client, never shared across clients;
 *   - every call accepts an AbortSignal and a timeout; the client-level `signal` cancels everything at once;
 *   - inputs are validated by the same zod contracts the CLI uses; results are the same `{ text, data }`;
 *   - errors are the same `EditorClientError` kinds / codes the CLI maps to exit codes
 *     (config=2, validation=3, upstream=4, transport=5) and that Cortex's editorWorkflow classifies.
 */

import {
  createEditorTransport,
  type EditorCredential,
  type EditorIdentity,
  type EditorTransport,
  type RequestOptions,
} from "./apiClient.js";
import { commandCatalog, createEditorOperations, type CommandContract, type CommandResult } from "./operations.js";
import { EditorClientError } from "./types.js";

export { EditorClientError } from "./types.js";
export { unwrapSsoToken } from "./apiClient.js";
export type { CommandContract, CommandResult, EditorCredential, EditorIdentity, RequestOptions };

export interface EditorClientOptions {
  /** SSO access token or a Cortex task-delegation JWT wrapping one (`sso_token` claim). Mutually exclusive with `apiKey`. */
  token?: string;
  /** HiQ-issued API key. Mutually exclusive with `token`. */
  apiKey?: string;
  /** Editor native API base URL (default https://x.hiqlcd.com/api/dataset). */
  apiUrl?: string;
  /** SSO user-info endpoint (default https://x.hiqlcd.com/api/sso/user/info/current). */
  ssoUserInfoUrl?: string;
  /** Per-request timeout for ordinary calls (default 60s). */
  requestTimeoutMs?: number;
  /** Timeout for the UPR multipart import (default 210s). */
  importTimeoutMs?: number;
  /** Cancels every in-flight and future request of this client. */
  signal?: AbortSignal;
  /** Custom fetch (tests / instrumentation). */
  fetch?: typeof fetch;
}

export interface UprPreflightInput { file_path: string; datasource: string; product_category_code: string }
export interface UprImportInput extends UprPreflightInput { need_desensitize?: boolean }
export interface ProcessesListInput {
  datasource: string;
  keyword?: string;
  process_id?: string;
  page?: number;
  page_size?: number;
  scope?: "mine" | "tenant";
}
export interface FlowsSearchInput {
  keyword?: string;
  flow_type: "ELEMENTARY_FLOW" | "PRODUCT_FLOW" | "WASTE_FLOW";
  category_id?: string;
  unit_group_id?: string;
  limit?: number;
}

export interface EditorClient {
  /** SSO identity behind the credential (resolved once per client). */
  identity(): Promise<EditorIdentity>;
  /** Static command contracts (same as `hiq-editor list --json`). */
  catalog(): CommandContract[];
  /** Generic entry: same names / schemas as `hiq-editor call <command>`. */
  execute(name: string, input: unknown, options?: RequestOptions): Promise<CommandResult>;

  datasourcesList(options?: RequestOptions): Promise<CommandResult>;
  processesList(input: ProcessesListInput, options?: RequestOptions): Promise<CommandResult>;
  processShow(processId: string, options?: RequestOptions): Promise<CommandResult>;
  flowsSearch(input: FlowsSearchInput, options?: RequestOptions): Promise<CommandResult>;
  productCategoriesSearch(keyword: string, limit?: number, options?: RequestOptions): Promise<CommandResult>;
  uprPreflight(input: UprPreflightInput, options?: RequestOptions): Promise<CommandResult>;
  uprImport(input: UprImportInput, options?: RequestOptions): Promise<CommandResult>;
  processTrialCalculate(processId: string, options?: RequestOptions): Promise<CommandResult>;
  processSubmitReview(processId: string, options?: RequestOptions): Promise<CommandResult>;
}

function credentialFrom(options: EditorClientOptions): EditorCredential {
  const token = options.token?.trim() ?? "";
  const apiKey = options.apiKey?.trim() ?? "";
  if (token && apiKey) throw new EditorClientError("config", "token and apiKey are mutually exclusive");
  if (apiKey) return { kind: "api-key", value: apiKey };
  if (token) return { kind: "access-token", value: token };
  throw new EditorClientError("config", "No credential. Pass `token` (SSO / delegation JWT) or `apiKey`.");
}

export function createEditorClient(options: EditorClientOptions): EditorClient {
  const transport: EditorTransport = createEditorTransport({
    credential: credentialFrom(options),
    ...(options.apiUrl !== undefined ? { apiUrl: options.apiUrl } : {}),
    ...(options.ssoUserInfoUrl !== undefined ? { ssoUserInfoUrl: options.ssoUserInfoUrl } : {}),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.importTimeoutMs !== undefined ? { importTimeoutMs: options.importTimeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const operations = createEditorOperations(transport);
  const run = (name: string, input: unknown, requestOptions?: RequestOptions): Promise<CommandResult> =>
    operations.execute(name, input, requestOptions);
  return {
    identity: () => transport.identity(),
    catalog: commandCatalog,
    execute: run,
    datasourcesList: (o) => run("datasources_list", {}, o),
    processesList: (input, o) => run("processes_list", input, o),
    processShow: (processId, o) => run("process_show", { process_id: processId }, o),
    flowsSearch: (input, o) => run("flows_search", input, o),
    productCategoriesSearch: (keyword, limit, o) => run("product_categories_search", { keyword, ...(limit !== undefined ? { limit } : {}) }, o),
    uprPreflight: (input, o) => run("upr_preflight", input, o),
    uprImport: (input, o) => run("upr_import", input, o),
    processTrialCalculate: (processId, o) => run("process_trial_calculate", { process_id: processId }, o),
    processSubmitReview: (processId, o) => run("process_submit_review", { process_id: processId }, o),
  };
}
