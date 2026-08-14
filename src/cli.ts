#!/usr/bin/env node
/**
 * Subprocess-friendly CLI for the editor MCP gateway. What
 * `npx -y @hiq-ai/hiq-editor <subcommand>` runs.
 *
 * Generic, gateway-style — it does not declare per-tool subcommands. Instead:
 *   - `list [--json]`     — list the tools the gateway exposes (remote + local).
 *   - `describe <tool>`   — print a tool's description + input JSON Schema.
 *   - `call <tool> --args '<json>'` — invoke any tool by name with a JSON args object.
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

async function runList(json: boolean): Promise<void> {
  let remote: Awaited<ReturnType<typeof listRemoteTools>> = [];
  try {
    remote = await listRemoteTools();
  } catch (err) {
    process.stderr.write(`(remote tools unavailable: ${err instanceof Error ? err.message : String(err)})\n`);
  }
  if (json) {
    const all = [
      ...remote.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema, local: false })),
      ...localToolDefs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, local: true })),
    ];
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    return;
  }
  const lines: string[] = [];
  for (const t of remote) {
    lines.push(`${t.name}\t${t.description ?? ""}`);
  }
  for (const t of localToolDefs) {
    lines.push(`${t.name}\t(local) ${t.description}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

async function runDescribe(tool: string): Promise<void> {
  const local = localByName.get(tool);
  if (local) {
    process.stdout.write(
      `${local.name} (local)\n${local.description}\n\nInput schema:\n${JSON.stringify(local.inputSchema, null, 2)}\n`,
    );
    return;
  }
  const remote = await listRemoteTools();
  const t = remote.find((r) => r.name === tool);
  if (!t) {
    throw new EditorClientError("validation", `Unknown tool '${tool}'. Run \`hiq-editor list\` to see available tools.`);
  }
  process.stdout.write(
    `${t.name}\n${t.description ?? ""}\n\nInput schema:\n${JSON.stringify(t.inputSchema, null, 2)}\n`,
  );
}

async function runCall(tool: string, argsJson: string): Promise<void> {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (e) {
    throw new EditorClientError("validation", `--args must be valid JSON: ${String(e)}`);
  }

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

async function main(): Promise<void> {
  await yargs(hideBin(process.argv))
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
    )
    .parseAsync();
}

main().catch((err) => emitError(err));
