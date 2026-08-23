import assert from "node:assert/strict";
import test from "node:test";
import { importUprFromFile } from "../src/tools/local.js";

test("whole-UPR local import exposes the CPC reference-product preflight", () => {
  const category = importUprFromFile.inputSchema.properties?.product_category_code as
    | { type?: string; description?: string; pattern?: string }
    | undefined;

  assert.deepEqual(category, {
    type: "string",
    description:
      "CPC code returned by search-product-categories. For a new dataset, the " +
      "server uses it to create or reuse the workbook's reference PRODUCT_FLOW.",
    pattern: "^\\d{1,5}$",
  });
  assert.equal(importUprFromFile.inputSchema.additionalProperties, false);
});
