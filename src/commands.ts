/**
 * CLI / MCP-facing default wiring: the operations bound to the transport built
 * from the process environment (config.ts). Hosts that embed hiq-editor as a
 * library must not import this module — use `./api` (`createEditorClient`),
 * which reads no environment and keeps one identity per client instance.
 */

import { createEditorTransport, type EditorTransport } from "./apiClient.js";
import { config } from "./config.js";
import { createEditorOperations, type CommandResult, type EditorOperations } from "./operations.js";
import { EditorClientError } from "./types.js";

export { commandCatalog, COMMAND_NAMES, type CommandContract, type CommandResult } from "./operations.js";

let cached: { key: string; transport: EditorTransport; operations: EditorOperations } | undefined;

function defaultOperations(): EditorOperations {
  if (!config.credential) throw new EditorClientError("config", "No credential. Set HIQ_EDITOR_TOKEN or HIQ_EDITOR_API_KEY, or run `hiq-editor login`.");
  const key = `${config.credential.kind}:${config.credential.value}:${config.apiUrl}:${config.ssoUserInfoUrl}`;
  if (!cached || cached.key !== key) {
    const transport = createEditorTransport({
      apiUrl: config.apiUrl,
      ssoUserInfoUrl: config.ssoUserInfoUrl,
      credential: { kind: config.credential.kind, value: config.credential.value },
    });
    cached = { key, transport, operations: createEditorOperations(transport) };
  }
  return cached.operations;
}

/** Run one domain command with the environment credential (CLI / MCP adapter). */
export async function executeCommand(name: string, rawInput: unknown): Promise<CommandResult> {
  return defaultOperations().execute(name, rawInput);
}

/** Test seam: the default transport caches identity per credential; drop it between credential scenarios. */
export function resetIdentityCache(): void {
  cached = undefined;
}
