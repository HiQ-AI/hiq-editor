import assert from "node:assert/strict";
import test from "node:test";
import { closeClientSession } from "../src/serverClient.js";

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
