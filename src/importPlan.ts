/**
 * `hiq-editor import <plan.json>` — one-command batch import of a full UPR
 * into the editor, with checkpoint/resume.
 *
 * The plan is a JSON file whose fields map 1:1 onto the remote tools' args
 * (no field renaming — whatever create_process_tool / add_exchange_tool accept
 * goes through verbatim), plus orchestration:
 *
 *   {
 *     "process":           { ...create_process_tool args... },
 *     "reference_product": { "value": 1, "declared_unit_id"?, "flow_id"? },  // flow_id defaults to process.middle_flow_id
 *     "exchanges":         [ { ...add_exchange_tool args minus process_id... } ],
 *     "calculate":         false
 *   }
 *
 * Background linkage: resolving a 背景数据唯一ID into the 5-tuple (and picking a
 * version) is a caller decision — run `call search_backgrounds_tool` first and
 * put the resolved tuple in the exchange's `background`. The importer refuses
 * empty/partial tuples rather than forwarding them.
 *
 * Steps run sequentially (the backend's addOrUp is whole-row, order matters):
 * create process → reference product → exchanges → optional trial calc. After
 * every successful write the state file (`<plan>.state.json`) is updated, so a
 * failed run resumes where it stopped; it is deleted on full success.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { callRemoteTool } from "./serverClient.js";
import { EditorClientError } from "./types.js";

export interface ImportPlan {
  process: Record<string, unknown>;
  reference_product?: Record<string, unknown>;
  exchanges?: Record<string, unknown>[];
  calculate?: boolean;
}

interface ImportState {
  planHash: string;
  processId?: string;
  referenceProductDone?: boolean;
  exchangesDone: number[];
}

export interface ImportOptions {
  statePath?: string;
  /** Attach to an existing process instead of creating one (e.g. after a
   *  name-already-exists create failure). */
  processId?: string;
  calc?: boolean;
  dryRun?: boolean;
}

const BACKGROUND_TUPLE_FIELDS = [
  "up_element_id",
  "up_element_uuid",
  "up_element_name",
  "data_source",
  "data_version",
] as const;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function validatePlan(plan: ImportPlan): string[] {
  const errors: string[] = [];
  if (!plan.process || typeof plan.process !== "object") {
    errors.push("`process` (create_process_tool args object) is required.");
    return errors;
  }
  if (!isNonEmptyString(plan.process.name)) {
    errors.push("`process.name` is required.");
  }
  if (!isNonEmptyString(plan.process.middle_flow_id)) {
    errors.push("`process.middle_flow_id` (reference product flow) is required.");
  }
  if (plan.reference_product !== undefined) {
    if (typeof plan.reference_product !== "object" || plan.reference_product === null) {
      errors.push("`reference_product` must be an object.");
    } else if (typeof plan.reference_product.value !== "number") {
      errors.push("`reference_product.value` (number) is required.");
    }
  }
  const exchanges = plan.exchanges ?? [];
  if (!Array.isArray(exchanges)) {
    errors.push("`exchanges` must be an array.");
    return errors;
  }
  exchanges.forEach((ex, i) => {
    const at = `exchanges[${i}]`;
    if (!ex || typeof ex !== "object") {
      errors.push(`${at} must be an object.`);
      return;
    }
    if (!isNonEmptyString(ex.category)) {
      errors.push(`${at}.category is required.`);
    }
    if (typeof ex.value !== "number") {
      errors.push(`${at}.value (number) is required.`);
    }
    if (ex.is_reference_product === true) {
      errors.push(`${at}: put the reference product in the top-level \`reference_product\` field, not in \`exchanges\`.`);
    }
    const bg = ex.background;
    if (bg !== undefined) {
      if (!bg || typeof bg !== "object") {
        errors.push(`${at}.background must be the search_backgrounds tuple object.`);
      } else {
        const missing = BACKGROUND_TUPLE_FIELDS.filter(
          (f) => !isNonEmptyString((bg as Record<string, unknown>)[f]),
        );
        if (missing.length > 0) {
          errors.push(
            `${at}.background is missing ${missing.join(", ")} — resolve the full tuple with ` +
              "`hiq-editor call search_backgrounds_tool` first (empty/partial tuples are not forwarded).",
          );
        }
      }
    } else if (!isNonEmptyString(ex.flow_id)) {
      errors.push(`${at} needs flow_id or a background tuple.`);
    }
  });
  return errors;
}

/** Call a remote tool; a tool-level error becomes a thrown upstream error. */
async function invoke(tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await callRemoteTool(tool, args);
  const raw = (result as { content?: unknown }).content;
  const text = (Array.isArray(raw) ? raw : [])
    .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
    .filter(Boolean)
    .join("\n");
  if ((result as { isError?: boolean }).isError) {
    throw new EditorClientError("upstream", text || `${tool} failed with no message`);
  }
  return text;
}

function loadState(statePath: string, planHash: string): ImportState {
  if (!existsSync(statePath)) {
    return { planHash, exchangesDone: [] };
  }
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as ImportState;
  if (state.planHash !== planHash) {
    throw new EditorClientError(
      "config",
      `state file ${statePath} was written for a different version of this plan — ` +
        "delete it to start over, or restore the original plan to resume.",
    );
  }
  if (!Array.isArray(state.exchangesDone)) {
    state.exchangesDone = [];
  }
  return state;
}

export async function runImport(planPath: string, opts: ImportOptions): Promise<void> {
  const log = (msg: string) => process.stderr.write(msg + "\n");

  const rawPlan = readFileSync(planPath, "utf-8");
  let plan: ImportPlan;
  try {
    plan = JSON.parse(rawPlan) as ImportPlan;
  } catch (e) {
    throw new EditorClientError("validation", `${planPath} is not valid JSON: ${String(e)}`);
  }
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    throw new EditorClientError(
      "validation",
      `Plan validation failed:\n` + errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  const exchanges = plan.exchanges ?? [];
  const doCalc = opts.calc || plan.calculate === true;
  const steps =
    1 + (plan.reference_product ? 1 : 0) + exchanges.length + (doCalc ? 1 : 0);

  if (opts.dryRun) {
    log(`Plan OK — ${steps} step(s):`);
    log(`  create_process: ${String(plan.process.name)}`);
    if (plan.reference_product) {
      log(`  reference product: value=${String(plan.reference_product.value)}`);
    }
    exchanges.forEach((ex, i) =>
      log(`  exchange ${i + 1}/${exchanges.length}: ${String(ex.category)} ${String(ex.material_name ?? ex.flow_id ?? (ex.background as Record<string, unknown> | undefined)?.up_element_name ?? "")}`),
    );
    if (doCalc) log("  trial calculation");
    return;
  }

  const planHash = createHash("sha256").update(rawPlan).digest("hex");
  const statePath = opts.statePath ?? planPath.replace(/(\.json)?$/, ".state.json");
  const state = loadState(statePath, planHash);
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  // ── 1. Create process (or attach) ──
  if (opts.processId) {
    state.processId = opts.processId;
  }
  if (!state.processId) {
    log(`create_process: ${String(plan.process.name)} ...`);
    try {
      const out = await invoke("create_process_tool", plan.process);
      const m = /^ID:\s*(\S+)/m.exec(out);
      if (!m) {
        throw new EditorClientError("upstream", `create_process succeeded but no ID in output:\n${out}`);
      }
      state.processId = m[1];
    } catch (err) {
      // The server's post-create check throws when the backend silently dropped
      // reference_flow_id, embedding the created process id and the repair
      // instruction. The reference-product step below IS that repair — recover
      // the id and continue instead of failing the import.
      const msg = err instanceof Error ? err.message : String(err);
      const m = /add_exchange_tool with process_id=(\S+?),/.exec(msg);
      if (!m) throw err;
      if (!plan.reference_product) {
        throw new EditorClientError(
          "upstream",
          `${msg}\n\nThe process was created but the backend dropped its reference product, and this ` +
            "plan has no `reference_product` step to repair it — add one and re-run to resume.",
        );
      }
      state.processId = m[1];
      log("backend dropped the reference product on create — repairing via the reference_product step");
    }
    saveState();
    log(`process: ${state.processId}`);
  } else {
    log(`process: ${state.processId} (resumed)`);
  }
  const processId = state.processId;
  if (!processId) {
    throw new EditorClientError("upstream", "no process id after create step — cannot continue.");
  }

  // ── 2. Reference product ──
  if (plan.reference_product && !state.referenceProductDone) {
    log("reference product ...");
    const { flow_id, ...rest } = plan.reference_product;
    const out = await invoke("add_exchange_tool", {
      process_id: processId,
      category: "PRODUCT",
      is_reference_product: true,
      flow_id: flow_id ?? plan.process.middle_flow_id,
      ...rest,
    });
    if (out.includes("STILL null")) {
      throw new EditorClientError(
        "upstream",
        `Reference product row was written but the process-level reference_flow_id is still null — ` +
          `the backend did not link it. Re-create the process in the editor UI.\n${out}`,
      );
    }
    state.referenceProductDone = true;
    saveState();
  }

  // ── 3. Exchanges, sequentially (backend writes are whole-row; order matters) ──
  for (let i = 0; i < exchanges.length; i++) {
    if (state.exchangesDone.includes(i)) continue;
    const ex = exchanges[i];
    const label = String(ex.material_name ?? ex.flow_id ?? (ex.background as Record<string, unknown> | undefined)?.up_element_name ?? "");
    log(`exchange ${i + 1}/${exchanges.length}: ${String(ex.category)} ${label} ...`);
    try {
      await invoke("add_exchange_tool", { process_id: processId, ...ex });
    } catch (err) {
      saveState();
      const done = state.exchangesDone.length;
      throw new EditorClientError(
        err instanceof EditorClientError ? err.kind : "upstream",
        `exchange ${i + 1}/${exchanges.length} (${String(ex.category)} ${label}) failed after ` +
          `${done} exchange(s) imported. Fix the plan entry if needed and re-run the same command to resume.\n` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    state.exchangesDone.push(i);
    saveState();
  }

  // ── 4. Optional trial calc ──
  let calcNote = "";
  if (doCalc) {
    log("trial calculation ...");
    calcNote = "\n" + (await invoke("calculate_process_tool", { process_id: processId }));
  }

  if (existsSync(statePath)) {
    unlinkSync(statePath);
  }
  process.stdout.write(
    `Import complete.\nProcess: ${processId}\n` +
      `Reference product: ${plan.reference_product ? "written" : "from create_process"}\n` +
      `Exchanges: ${exchanges.length}` +
      calcNote +
      "\n",
  );
}
