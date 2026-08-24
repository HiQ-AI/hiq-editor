import assert from "node:assert/strict";
import test from "node:test";
import { closeClientSession, requestHeadersForCredential } from "../src/serverClient.js";

test("API key uses only X-API-Key transport", () => {
  assert.deepEqual(
    requestHeadersForCredential({ kind: "api-key", value: "test-api-key", source: "env" }, "101"),
    { "X-API-Key": "test-api-key" },
  );
});

test("SSO token uses Bearer and edge cookie transport", () => {
  assert.deepEqual(
    requestHeadersForCredential({ kind: "access-token", value: "test-token", source: "env" }, "101"),
    { Authorization: "Bearer test-token", "X-Site": "101", Cookie: "accessToken=test-token" },
  );
});

test("CLI terminates the remote session before closing local client state", async () => {
  const calls: string[] = [];
  await closeClientSession(
    { close: async () => { calls.push("close"); } },
    { terminateSession: async () => { calls.push("terminate"); } },
  );
  assert.deepEqual(calls, ["terminate", "close"]);
});

test("session termination failure does not turn a completed command into failure", async () => {
  let closed = false;
  await closeClientSession(
    { close: async () => { closed = true; } },
    { terminateSession: async () => { throw new Error("already gone"); } },
  );
  assert.equal(closed, true);
});
