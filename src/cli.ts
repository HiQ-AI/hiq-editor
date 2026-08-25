#!/usr/bin/env node
/** Subprocess-friendly agent CLI over Editor's native APISIX API. */

import { readFileSync } from "node:fs";
import yargs from "yargs";
import type { ArgumentsCamelCase } from "yargs";
import { commandCatalog, executeCommand } from "./commands.js";
import { config } from "./config.js";
import { registerDomainCommands, commandAlias, type CatalogCommand } from "./commandOptions.js";
import { EditorClientError } from "./types.js";
import { VERSION } from "./version.js";

let jsonMode = false;

function exitCodeFor(error: unknown): number {
  if (!(error instanceof EditorClientError)) return 1;
  switch (error.kind) {
    case "config": return 2;
    case "validation": return 3;
    case "upstream": return 4;
    case "transport": return 5;
  }
}

function emitError(error: unknown): never {
  const code = exitCodeFor(error);
  const normalized = error instanceof EditorClientError
    ? { kind: error.kind, code: error.code ?? null, message: error.message }
    : { kind: "unknown", code: null, message: error instanceof Error ? error.message : String(error) };
  process.stderr.write(jsonMode
    ? `${JSON.stringify({ ok: false, ...normalized })}\n`
    : `[${normalized.kind}${normalized.code ? `:${normalized.code}` : ""}] ${normalized.message}\n`);
  process.exit(code);
}

function catalog(): CatalogCommand[] {
  return commandCatalog().map((command) => ({
    name: command.name,
    description: command.description,
    inputSchema: command.inputSchema,
    readOnly: command.readOnly,
  }));
}

async function invoke(name: string, args: Record<string, unknown>): Promise<void> {
  const result = await executeCommand(name, args);
  process.stdout.write(jsonMode
    ? `${JSON.stringify({ ok: true, command: name, text: result.text, data: result.data })}\n`
    : `${result.text}\n`);
}

function runList(asJson: boolean): void {
  const commands = catalog();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${commands.map((command) => `${commandAlias(command.name)}\t${command.description}`).join("\n")}\n`);
}

function runDescribe(name: string): void {
  const command = catalog().find((item) => item.name === name || commandAlias(item.name) === name);
  if (!command) throw new EditorClientError("validation", `Unknown command '${name}'.`);
  process.stdout.write(
    `${commandAlias(command.name)} (native: ${command.name})\n${command.description ?? ""}\n\n` +
    `Input schema:\n${JSON.stringify(command.inputSchema, null, 2)}\n`,
  );
}

async function runCall(name: string, argsJson: string, fromStdin: boolean): Promise<void> {
  const raw = fromStdin ? readFileSync(0, "utf-8") : argsJson;
  let args: unknown;
  try {
    args = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new EditorClientError("validation", `${fromStdin ? "stdin" : "--args"} must be valid JSON: ${String(error)}`);
  }
  await invoke(name, args as Record<string, unknown>);
}

async function runDoctor(): Promise<void> {
  const started = Date.now();
  let identity: Record<string, unknown> | null = null;
  let datasources = 0;
  let error: string | null = null;
  try {
    const result = await executeCommand("datasources_list", {});
    identity = result.data.account as Record<string, unknown>;
    datasources = Array.isArray(result.data.datasources) ? result.data.datasources.length : 0;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const report = {
    ok: error === null,
    version: VERSION,
    api_url: config.apiUrl,
    sso_url: config.ssoUserInfoUrl,
    credential_kind: config.credential?.kind ?? null,
    identity,
    datasources,
    latency_ms: Date.now() - started,
    error,
  };
  process.stdout.write(jsonMode
    ? `${JSON.stringify(report)}\n`
    : [
      `hiq-editor ${VERSION}`,
      `api:          ${report.api_url}`,
      `credential:   ${report.credential_kind ?? "MISSING"}`,
      `connectivity: ${report.ok ? `ok (${datasources} datasources, ${report.latency_ms}ms)` : `FAILED — ${error}`}`,
    ].join("\n") + "\n");
  if (!report.ok) process.exit(config.credential ? 5 : 2);
}

const STATIC_COMMANDS = new Set(["list", "describe", "call", "doctor", "login", "logout", "version"]);

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const first = rawArgs.find((arg) => !arg.startsWith("-"));
  const needsDomainCommands = !first || !STATIC_COMMANDS.has(first);
  let parser = yargs(rawArgs)
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
      describe: "Emit one machine-readable JSON envelope.",
    })
    .middleware((argv) => { jsonMode = Boolean(argv.json); }, true)
    .fail((message, error, instance) => {
      if (error || message) emitError(error ?? new EditorClientError("validation", message));
      instance.showHelp();
      process.exit(1);
    })
    .epilogue(
      "Environment:\n" +
      "  HIQ_EDITOR_TOKEN       SSO token or Cortex task delegation JWT\n" +
      "  HIQ_EDITOR_API_KEY     HiQ API key (mutually exclusive with token)\n" +
      "  HIQ_EDITOR_API_URL     Native API (default: https://x.hiqlcd.com/api/dataset)\n\n" +
      "Exit codes: 0 ok · 2 config · 3 validation · 4 upstream · 5 transport · 1 unknown",
    )
    .demandCommand(1, "")
    .command("list", "List stable Editor domain commands.", (value) => value, (argv) => runList(Boolean(argv.json)))
    .command("doctor", "Verify SSO identity and native Editor API access.", (value) => value, async () => {
      try { await runDoctor(); } catch (error) { emitError(error); }
    })
    .command("login", "Sign in through the existing HiQ device flow.", (value) => value, async () => {
      try { const { runLogin } = await import("./login.js"); await runLogin(jsonMode); } catch (error) { emitError(error); }
    })
    .command("logout", "Remove stored login credentials.", (value) => value, async () => {
      try { const { runLogout } = await import("./login.js"); runLogout(jsonMode); } catch (error) { emitError(error); }
    })
    .command("describe <command>", "Print one command contract.", (value) => value.positional("command", { type: "string" }), (argv: ArgumentsCamelCase<{ command?: string }>) => {
      try { runDescribe(String(argv.command ?? "")); } catch (error) { emitError(error); }
    })
    .command("call <command>", "Invoke a domain command with a JSON object.", (value) => value
      .positional("command", { type: "string" })
      .option("args", { type: "string", default: "{}" })
      .option("stdin", { type: "boolean", default: false }), async (argv: ArgumentsCamelCase<{ command?: string; args?: string; stdin?: boolean }>) => {
      try { await runCall(String(argv.command ?? ""), String(argv.args ?? "{}"), Boolean(argv.stdin)); } catch (error) { emitError(error); }
    })
    .command("version", "Print version.", {}, () => { process.stdout.write(`${VERSION}\n`); });

  if (needsDomainCommands) {
    parser = registerDomainCommands(parser, catalog(), invoke, emitError) as typeof parser;
  }
  await parser.parseAsync();
}

main().catch(emitError);
