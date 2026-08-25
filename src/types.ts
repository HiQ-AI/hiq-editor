/**
 * Shared error types for the Editor CLI and its optional MCP adapter.
 */

/** Error raised by local validation/transport or relayed from Editor/SSO. */
export class EditorClientError extends Error {
  constructor(
    public readonly kind: "config" | "validation" | "transport" | "upstream",
    message: string,
    /** Server-supplied error code, when kind === "upstream". */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "EditorClientError";
  }
}
