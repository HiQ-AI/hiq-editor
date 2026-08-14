/**
 * Per-tool subcommands, generated at runtime from the gateway's tool catalog
 * (remote tools/list + local tools) — no client-side schema duplication to
 * drift. `add_exchange_tool` becomes `hiq-editor add-exchange` with real flags
 * parsed from its input JSON Schema: required props become required options,
 * enums become choices, object/array props accept JSON values.
 */
import type { Argv, Options } from "yargs";

import { EditorClientError } from "./types.js";

export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  local: boolean;
}

/** `add_exchange_tool` → `add-exchange`, `list_my_processes` → `list-my-processes`. */
export function toolAlias(name: string): string {
  return name.replace(/_tool$/, "").replace(/_/g, "-");
}

export interface PropSpec {
  /** Kebab-case flag name. */
  flag: string;
  /** Original (snake_case) schema property name. */
  prop: string;
  opt: Options;
  /** Parse the flag value as JSON before sending (object/array props). */
  json: boolean;
}

/** Flag help gets the schema description's first sentence, capped — the full
 *  text stays available via `hiq-editor describe <tool>`. */
function firstSentence(desc: string | undefined, max = 120): string {
  if (!desc) return "";
  const m = /^(.{1,120}?[.。](?:\s|$))/.exec(desc);
  const s = (m ? m[1] : desc).trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function schemaToOptions(schema: unknown): PropSpec[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as {
    properties?: Record<string, Record<string, unknown> | undefined>;
    required?: string[];
  };
  const required = new Set(s.required ?? []);
  const specs: PropSpec[] = [];
  for (const [prop, p] of Object.entries(s.properties ?? {})) {
    const flag = prop.replace(/_/g, "-");
    const type = typeof p?.type === "string" ? p.type : undefined;
    let json = false;
    const opt: Options = {
      demandOption: required.has(prop),
      describe: firstSentence(typeof p?.description === "string" ? p.description : undefined),
    };
    if (type === "number" || type === "integer") {
      opt.type = "number";
    } else if (type === "boolean") {
      opt.type = "boolean";
    } else if (type === "object" || type === "array") {
      opt.type = "string";
      json = true;
      opt.describe = [opt.describe, "(JSON)"].filter(Boolean).join(" ");
    } else {
      opt.type = "string";
      if (Array.isArray(p?.enum)) {
        opt.choices = p.enum as (string | number)[];
      }
    }
    specs.push({ flag, prop, opt, json });
  }
  return specs;
}

function parseJsonFlag(flag: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new EditorClientError("validation", `--${flag} must be valid JSON: ${String(e)}`);
  }
}

/** Register one subcommand per catalog tool. On an alias collision the later
 *  tool keeps its native name. */
export function registerToolCommands(
  y: Argv,
  tools: CatalogTool[],
  invoke: (toolName: string, args: Record<string, unknown>) => Promise<void>,
  onError: (err: unknown) => void,
): Argv {
  const taken = new Set<string>();
  for (const t of tools) {
    const alias = taken.has(toolAlias(t.name)) ? t.name : toolAlias(t.name);
    taken.add(alias);
    const specs = schemaToOptions(t.inputSchema);
    y = y.command(
      alias,
      firstSentence(t.description) + (t.local ? " (local)" : ""),
      (yy) => {
        // A tool arg named `version` collides with yargs' built-in --version —
        // disable the built-in on this subcommand so the tool arg wins.
        if (specs.some((sp) => sp.flag === "version")) {
          yy = yy.version(false);
        }
        for (const sp of specs) {
          yy = yy.option(sp.flag, sp.opt);
        }
        return yy;
      },
      async (argv) => {
        try {
          const args: Record<string, unknown> = {};
          for (const sp of specs) {
            const v = (argv as Record<string, unknown>)[sp.flag];
            if (v === undefined) continue;
            args[sp.prop] = sp.json ? parseJsonFlag(sp.flag, String(v)) : v;
          }
          await invoke(t.name, args);
        } catch (err) {
          onError(err);
        }
      },
    );
  }
  return y;
}
