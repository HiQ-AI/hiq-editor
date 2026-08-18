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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { localToolDefs } from "./tools/index.js";
import { config } from "./config.js";
import { runImport } from "./importPlan.js";
import { registerToolCommands, toolAlias, type CatalogTool } from "./dynamicCommands.js";
import { EditorClientError } from "./types.js";
import { VERSION } from "./version.js";

const localByName = new Map(localToolDefs.map((t) => [t.name, t]));

/** Global --json mode: machine-readable output on stdout, structured errors on
 *  stderr. Set once by yargs middleware before any handler runs. */
let jsonMode = false;

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
  if (jsonMode) {
    const obj =
      err instanceof EditorClientError
        ? { ok: false, kind: err.kind, code: err.code ?? null, message: err.message }
        : { ok: false, kind: "unknown", code: null, message: err instanceof Error ? err.message : String(err) };
    process.stderr.write(JSON.stringify(obj) + "\n");
  } else {
    const text =
      err instanceof EditorClientError
        ? `[${err.kind}${err.code ? `:${err.code}` : ""}] ${err.message}`
        : `[unknown] ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(text + "\n");
  }
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

/** Disk cache for the remote tool catalog — dynamic subcommand registration
 *  reads it to skip a tools/list round trip per invocation (the tool call
 *  itself still goes live; the server re-validates args regardless). `list`,
 *  `describe`, and `doctor` always fetch live and refresh the cache. */
const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;

function catalogCachePath(): string {
  const key = createHash("sha1").update(config.serverUrl).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "hiq-editor", `catalog-${key}.json`);
}

function readCatalogCache(): CatalogTool[] | null {
  try {
    const raw = JSON.parse(readFileSync(catalogCachePath(), "utf-8")) as {
      fetchedAt: number;
      tools: CatalogTool[];
    };
    if (Date.now() - raw.fetchedAt > CATALOG_CACHE_TTL_MS) return null;
    return Array.isArray(raw.tools) ? raw.tools : null;
  } catch {
    return null;
  }
}

function writeCatalogCache(tools: CatalogTool[]): void {
  try {
    const p = catalogCachePath();
    mkdirSync(join(homedir(), ".cache", "hiq-editor"), { recursive: true });
    writeFileSync(p, JSON.stringify({ fetchedAt: Date.now(), tools }));
  } catch {
    // best-effort — a failed cache write never fails the command
  }
}

/** The gateway catalog: remote tools (when reachable/authed) + local tools. */
async function loadCatalog(warn: boolean, useCache = false): Promise<CatalogTool[]> {
  let remote: CatalogTool[] = [];
  const cached = useCache ? readCatalogCache() : null;
  if (cached) {
    remote = cached;
  } else {
    try {
      const { listRemoteTools } = await import("./serverClient.js");
      remote = (await listRemoteTools()).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
        local: false,
      }));
      writeCatalogCache(remote);
    } catch (err) {
      if (warn) {
        process.stderr.write(
          `(remote tools unavailable: ${err instanceof Error ? err.message : String(err)})\n`,
        );
      }
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
  let text: string;
  let data: unknown;
  if (local) {
    text = contentToText({ content: await local.handler(args) });
  } else {
    const { callRemoteTool } = await import("./serverClient.js");
    const result = await callRemoteTool(tool, args);
    if ((result as { isError?: boolean }).isError) {
      throw new EditorClientError("upstream", contentToText(result));
    }
    text = contentToText(result);
    // Servers that emit MCP structuredContent give --json real data, not prose.
    data = (result as { structuredContent?: unknown }).structuredContent;
  }
  process.stdout.write(
    jsonMode
      ? JSON.stringify({ ok: true, tool, text, ...(data !== undefined ? { data } : {}) }) + "\n"
      : text + "\n",
  );
}

async function runCall(tool: string, argsJson: string, fromStdin: boolean): Promise<void> {
  const raw = fromStdin ? readFileSync(0, "utf-8") : argsJson;
  let args: Record<string, unknown>;
  try {
    args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (e) {
    throw new EditorClientError("validation", `${fromStdin ? "stdin" : "--args"} must be valid JSON: ${String(e)}`);
  }
  await invokeByName(tool, args);
}

/** `doctor` — diagnose config, connectivity, and the tool catalog in one shot. */
async function runDoctor(): Promise<void> {
  const tokenSet = Boolean(config.token);
  let reachable = false;
  let toolCount = 0;
  let latencyMs = 0;
  let error: string | null = null;
  if (tokenSet) {
    const t0 = Date.now();
    try {
      const { listRemoteTools } = await import("./serverClient.js");
      toolCount = (await listRemoteTools()).length;
      latencyMs = Date.now() - t0;
      reachable = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const report = {
    ok: tokenSet && reachable,
    version: VERSION,
    serverUrl: config.serverUrl,
    tokenSet,
    reachable,
    remoteTools: toolCount,
    localTools: localToolDefs.length,
    latencyMs,
    error,
  };
  if (jsonMode) {
    process.stdout.write(JSON.stringify(report) + "\n");
  } else {
    process.stdout.write(
      `hiq-editor ${VERSION}\n` +
        `server:       ${report.serverUrl}\n` +
        `token:        ${tokenSet ? (process.env.HIQ_EDITOR_TOKEN?.trim() ? "set (env)" : "set (login)") : "MISSING — export HIQ_EDITOR_TOKEN or run `hiq-editor login`"}\n` +
        `connectivity: ${reachable ? `ok (${toolCount} remote tools, ${latencyMs}ms)` : `FAILED${error ? ` — ${error}` : ""}`}\n` +
        `local tools:  ${report.localTools}\n`,
    );
  }
  if (!tokenSet) {
    process.exit(2);
  }
  if (!reachable) {
    process.exit(5);
  }
}

/** Commands handled without the remote catalog. Anything else (or bare
 *  `--help`) loads the catalog and registers the per-tool subcommands. */
const STATIC_COMMANDS = new Set(["list", "describe", "call", "import", "doctor", "login", "logout", "version"]);

async function main(): Promise<void> {
  // NOT hideBin(): under ELECTRON_RUN_AS_NODE the host still reports
  // `process.versions.electron` while `process.defaultApp` is undefined, so
  // yargs decides it is a *packaged Electron app* and strips only argv[0] —
  // leaving the script path in as the first positional. Every command then
  // dies with "unrecognized option: …/cli.js". This CLI is always launched as
  // `<runtime> cli.js …` (node, or Electron-as-node inside Cortex Desktop),
  // so argv[2:] is the correct slice in both.
  const rawArgs = process.argv.slice(2);
  const first = rawArgs.find((a) => !a.startsWith("-"));
  const needDynamic = !first || !STATIC_COMMANDS.has(first);

  let y = yargs(rawArgs)
    .scriptName("hiq-editor")
    .strict()
    .help()
    .alias("h", "help")
    .version(VERSION)
    .recommendCommands()
    .option("json", {
      type: "boolean",
      global: true,
      default: false,
      describe: "Machine-readable output: JSON on stdout, structured errors on stderr.",
    })
    .middleware((argv) => {
      jsonMode = Boolean(argv.json);
    }, true)
    .fail((msg, err, yi) => {
      // Route yargs usage errors through the same structured error channel.
      // demandCommand with an empty message (bare `hiq-editor`) lands here with
      // neither msg nor err — show help instead of an empty error.
      if (err || msg) {
        emitError(err ?? new EditorClientError("validation", msg));
      }
      yi.showHelp();
      process.exit(1);
    })
    .epilogue(
      "Environment:\n" +
        "  HIQ_EDITOR_TOKEN       SSO token (required; env only — never a flag)\n" +
        "  HIQ_EDITOR_SERVER_URL  MCP endpoint (default: https://x.hiqlcd.com/mcp/editor)\n\n" +
        "Exit codes: 0 ok · 2 config · 3 validation · 4 upstream · 5 transport · 1 unknown\n" +
        "Docs: https://github.com/HiQ-AI/hiq-editor#readme",
    )
    .demandCommand(1, "")
    .command(
      "list",
      "List the tools the gateway exposes (remote + local). --json adds input schemas.",
      (y) => y,
      async (argv: ArgumentsCamelCase<{ json?: boolean }>) => {
        try {
          await runList(Boolean(argv.json));
        } catch (err) {
          emitError(err);
        }
      },
    )
    .command(
      "doctor",
      "Diagnose config, server connectivity, and the tool catalog.",
      (y) => y,
      async () => {
        try {
          await runDoctor();
        } catch (err) {
          emitError(err);
        }
      },
    )
    .command(
      "login",
      "Sign in via QR / device flow (stores credentials for later commands).",
      (y) => y,
      async () => {
        try {
          const { runLogin } = await import("./login.js");
          await runLogin(jsonMode);
        } catch (err) {
          emitError(err);
        }
      },
    )
    .command(
      "logout",
      "Remove stored login credentials.",
      (y) => y,
      async () => {
        try {
          const { runLogout } = await import("./login.js");
          runLogout(jsonMode);
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
      "import [plan]",
      "Import a whole UPR from a plan JSON (create process → reference product → exchanges → optional trial calc), with checkpoint/resume.",
      (y) =>
        y
          .positional("plan", { type: "string", describe: "Path to the plan JSON file (or pass --stdin)." })
          .option("stdin", {
            type: "boolean",
            default: false,
            describe: "Read the plan JSON from stdin (--state is then required to resume).",
          })
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
          stdin?: boolean;
          state?: string;
          processId?: string;
          calc?: boolean;
          dryRun?: boolean;
        }>,
      ) => {
        try {
          await runImport(String(argv.plan ?? ""), {
            stdin: Boolean(argv.stdin),
            statePath: argv.state,
            processId: argv.processId,
            calc: Boolean(argv.calc),
            dryRun: Boolean(argv.dryRun),
            json: jsonMode,
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
          })
          .option("stdin", {
            type: "boolean",
            default: false,
            describe: "Read the JSON args object from stdin instead of --args.",
          }),
      async (argv: ArgumentsCamelCase<{ tool?: string; args?: string; stdin?: boolean }>) => {
        try {
          await runCall(String(argv.tool ?? ""), String(argv.args ?? "{}"), Boolean(argv.stdin));
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
    y = registerToolCommands(y, await loadCatalog(true, true), invokeByName, emitError) as typeof y;
  }
  await y.parseAsync();

  // One-shot process hygiene: the MCP transport keeps the event loop alive
  // after a successful remote call — close it so the CLI exits.
  const { closeRemoteClient } = await import("./serverClient.js");
  await closeRemoteClient();
}

main().catch((err) => emitError(err));
