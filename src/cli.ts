#!/usr/bin/env node
/**
 * Subprocess-friendly CLI for the editor MCP gateway. What
 * `npx -y @hiq-ai/hiq-editor <subcommand>` runs.
 *
 * Per-tool subcommands are generated at runtime from the gateway's tool
 * catalog (dynamicCommands.ts) — `hiq-editor add-exchange --process-id … --value …`
 * with flags derived from each tool's input JSON Schema, no schema duplication.
 * Static commands:
 *   - `list [--json]`     — list the tools the gateway exposes (remote + local).
 *   - `describe <tool>`   — print a tool's description + input JSON Schema.
 *   - `call <tool> --args '<json>'` — raw escape hatch: invoke by native name with a JSON args object.
 *   - `import <plan.json>` — orchestrated whole-UPR import with checkpoint/resume
 *                            (see importPlan.ts for the plan format).
 *   - `version`           — print version.
 *
 * Auth comes from HIQ_EDITOR_TOKEN in the env, exactly like the MCP server.
 */
import yargs from "yargs";
import type { ArgumentsCamelCase } from "yargs";
import { hideBin } from "yargs/helpers";

import { readFileSync } from "node:fs";

import { localToolDefs } from "./tools/index.js";
import { listRemoteTools, callRemoteTool } from "./serverClient.js";
import { runImport } from "./importPlan.js";
import { registerToolCommands, toolAlias, type CatalogTool } from "./dynamicCommands.js";
import { EditorClientError } from "./types.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;

const localByName = new Map(localToolDefs.map((t) => [t.name, t]));

function exitCodeFor(err: unknown): number {
  if (err instanceof EditorClientError) {
    switch (err.kind) {
      case "config": return 2;
      case "validation": return 3;
      case "upstream": return 4;
      case "transport": return 5;
      default: return 1;
    }
  }
  return 1;
}

function emitError(err: unknown): void {
  const code = exitCodeFor(err);
  const text =
    err instanceof EditorClientError
      ? `[${err.kind}${err.code ? `:${err.code}` : ""}] ${err.message}`
      : `[unknown] ${err instanceof Error ? err.message : String(err)}`;
  process.stderr.write(text + "\n");
  process.exit(code);
}

/** Flatten a tool result's content blocks to plain text. */
function contentToText(result: unknown): string {
  const raw =
    result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  const content = Array.isArray(raw) ? raw : [];
  return content
    .map((c) =>
      c && typeof c === "object" && "text" in c
        ? String((c as { text: unknown }).text)
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** The gateway catalog: remote tools (when reachable/authed) + local tools. */
async function loadCatalog(warn: boolean): Promise<CatalogTool[]> {
  let remote: CatalogTool[] = [];
  try {
    remote = (await listRemoteTools()).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
      local: false,
    }));
  } catch (err) {
    if (warn) {
      process.stderr.write(
        `(remote tools unavailable: ${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  }
  return [
    ...remote,
    ...localToolDefs.map((t) => ({
      name: t.name,
      // Their descriptions carry a "LOCAL." prefix for the MCP tool list; the
      // catalog marks locality via the `local` flag instead.
      description: t.description.replace(/^LOCAL\.\s*/, ""),
      inputSchema: t.inputSchema as unknown,
      local: true,
    })),
  ];
}

async function runList(json: boolean): Promise<void> {
  const catalog = await loadCatalog(true);
  if (json) {
    process.stdout.write(JSON.stringify(catalog, null, 2) + "\n");
    return;
  }
  const lines = catalog.map((t) => {
    const alias = toolAlias(t.name);
    const native = alias === t.name ? "" : `  (${t.name})`;
    return `${alias}${native}\t${t.local ? "(local) " : ""}${t.description ?? ""}`;
  });
  process.stdout.write(lines.join("\n") + "\n");
}

async function runDescribe(tool: string): Promise<void> {
  const catalog = await loadCatalog(true);
  const t = catalog.find((r) => r.name === tool || toolAlias(r.name) === tool);
  if (!t) {
    throw new EditorClientError("validation", `Unknown tool '${tool}'. Run \`hiq-editor list\` to see available tools.`);
  }
  process.stdout.write(
    `${toolAlias(t.name)}${toolAlias(t.name) === t.name ? "" : ` (native: ${t.name})`}${t.local ? " (local)" : ""}\n` +
      `${t.description ?? ""}\n\nInput schema:\n${JSON.stringify(t.inputSchema, null, 2)}\n`,
  );
}

/** Invoke a tool (local first, then remote) and print its text result. Shared
 *  by the raw `call` command and the generated per-tool subcommands. */
async function invokeByName(tool: string, args: Record<string, unknown>): Promise<void> {
  const local = localByName.get(tool);
  if (local) {
    const content = await local.handler(args);
    process.stdout.write(contentToText({ content }) + "\n");
    return;
  }

  const result = await callRemoteTool(tool, args);
  if ((result as { isError?: boolean }).isError) {
    throw new EditorClientError("upstream", contentToText(result));
  }
  process.stdout.write(contentToText(result) + "\n");
}

async function runCall(tool: string, argsJson: string): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (e) {
    throw new EditorClientError("validation", `--args must be valid JSON: ${String(e)}`);
  }
  await invokeByName(tool, args);
}

/** Commands handled without the remote catalog. Anything else (or bare
 *  `--help`) loads the catalog and registers the per-tool subcommands. */
const STATIC_COMMANDS = new Set(["list", "describe", "call", "import", "version", "completion"]);

async function main(): Promise<void> {
  const rawArgs = hideBin(process.argv);
  const first = rawArgs.find((a) => !a.startsWith("-"));
  const needDynamic = !first || !STATIC_COMMANDS.has(first);

  let y = yargs(rawArgs)
    .scriptName("hiq-editor")
    .strict()
    .help()
    .alias("h", "help")
    .demandCommand(1, "")
    .command(
      "list",
      "List the tools the gateway exposes (remote + local).",
      (y) =>
        y.option("json", {
          type: "boolean",
          describe: "Emit a JSON array with each tool's input schema.",
          default: false,
        }),
      async (argv: ArgumentsCamelCase<{ json?: boolean }>) => {
        try {
          await runList(Boolean(argv.json));
        } catch (err) {
          emitError(err);
        }
      },
    )
    .command(
      "describe <tool>",
      "Print a tool's description and input JSON Schema.",
      (y) => y.positional("tool", { type: "string", describe: "Tool name." }),
      async (argv: ArgumentsCamelCase<{ tool?: string }>) => {
        try {
          await runDescribe(String(argv.tool ?? ""));
        } catch (err) {
          emitError(err);
        }
      },
    )
    .command(
      "import <plan>",
      "Import a whole UPR from a plan JSON (create process → reference product → exchanges → optional trial calc), with checkpoint/resume.",
      (y) =>
        y
          .positional("plan", { type: "string", describe: "Path to the plan JSON file." })
          .option("state", {
            type: "string",
            describe: "Checkpoint file path (default: <plan>.state.json).",
          })
          .option("process-id", {
            type: "string",
            describe: "Attach to an existing process instead of creating one.",
          })
          .option("calc", {
            type: "boolean",
            describe: "Run trial calculation after all exchanges.",
            default: false,
          })
          .option("dry-run", {
            type: "boolean",
            describe: "Validate the plan and print the step list without writing.",
            default: false,
          }),
      async (
        argv: ArgumentsCamelCase<{
          plan?: string;
          state?: string;
          processId?: string;
          calc?: boolean;
          dryRun?: boolean;
        }>,
      ) => {
        try {
          await runImport(String(argv.plan ?? ""), {
            statePath: argv.state,
            processId: argv.processId,
            calc: Boolean(argv.calc),
            dryRun: Boolean(argv.dryRun),
          });
        } catch (err) {
          emitError(err);
        }
      },
    )
    .command(
      "call <tool>",
      "Invoke a tool by name with a JSON args object.",
      (y) =>
        y
          .positional("tool", { type: "string", describe: "Tool name." })
          .option("args", {
            type: "string",
            describe: "JSON-encoded args object, e.g. '{\"datasource\":\"GBA\"}'.",
            default: "{}",
          }),
      async (argv: ArgumentsCamelCase<{ tool?: string; args?: string }>) => {
        try {
          await runCall(String(argv.tool ?? ""), String(argv.args ?? "{}"));
        } catch (err) {
          emitError(err);
        }
      },
    )
    .command(
      "version",
      "Print version.",
      (y) => y,
      () => {
        process.stdout.write(VERSION + "\n");
      },
    );

  if (needDynamic) {
    y = registerToolCommands(y, await loadCatalog(true), invokeByName, emitError) as typeof y;
  }
  await y.parseAsync();
}

main().catch((err) => emitError(err));
