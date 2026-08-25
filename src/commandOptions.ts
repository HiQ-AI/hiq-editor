/** Generate yargs subcommands from the same command schemas used by call/MCP. */
import type { Argv, Options } from "yargs";

import { EditorClientError } from "./types.js";

export interface CatalogCommand {
  name: string;
  description?: string;
  inputSchema?: unknown;
  readOnly?: boolean;
}

/** `process_trial_calculate` becomes `process-trial-calculate`. */
export function commandAlias(name: string): string {
  return name.replace(/_/g, "-");
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

/** Keep subcommand help compact; describe prints the full schema. */
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

/** Register one subcommand per stable domain command. */
export function registerDomainCommands(
  y: Argv,
  commands: CatalogCommand[],
  invoke: (commandName: string, args: Record<string, unknown>) => Promise<void>,
  onError: (err: unknown) => void,
): Argv {
  const taken = new Set<string>();
  for (const t of commands) {
    const alias = taken.has(commandAlias(t.name)) ? t.name : commandAlias(t.name);
    taken.add(alias);
    const specs = schemaToOptions(t.inputSchema);
    y = y.command(
      alias,
      firstSentence(t.description),
      (yy) => {
        // A command arg named `version` collides with yargs' built-in flag.
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
