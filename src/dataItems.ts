/** Tenant data-item preflight for deterministic UPR imports. */

import { apiPost } from "./apiClient.js";
import { EditorClientError } from "./types.js";

const LOOKUP_CONCURRENCY = 8;

type JsonObject = Record<string, unknown>;

export interface ResolvedDataItem {
  id: string;
  name: string;
  created: boolean;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object).filter((item): item is JsonObject => Boolean(item)) : [];
}

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

async function mapBounded<T, R>(values: readonly T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, values.length) }, () => worker()));
  return results;
}

async function exactDataItem(name: string): Promise<JsonObject | undefined> {
  const response = await apiPost<unknown>("/mElement/getPageElementBykeyword", {
    enableLike: 2,
    keyword: name,
    page: 1,
    size: 2,
  });
  const exact = array(response.data).filter((row) => text(row.name) === name && text(row.id));
  if (exact.length > 1 || Number(response.total ?? exact.length) > 1) {
    throw new EditorClientError(
      "upstream",
      `Tenant data-item name '${name}' is not unique; UPR import is blocked.`,
      "data_item_not_unique",
    );
  }
  return exact[0];
}

function normalizeNames(names: readonly string[]): string[] {
  const normalized = names.map((name) => name.trim());
  const invalid = normalized.find((name) => !name || name.length > 255 || /[\r\n\0]/u.test(name));
  if (invalid !== undefined) {
    throw new EditorClientError(
      "validation",
      "UPR data-item names must be non-empty single-line values of at most 255 characters.",
      "data_item_name_invalid",
    );
  }
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

export async function ensureDataItems(rawNames: readonly string[]): Promise<ResolvedDataItem[]> {
  const names = normalizeNames(rawNames);
  if (names.length === 0) {
    throw new EditorClientError("validation", "UPR import requires at least one data item.");
  }

  const existing = await mapBounded(names, async (name) => ({ name, row: await exactDataItem(name) }));
  return mapBounded(existing, async ({ name, row }) => {
    if (row) return { id: text(row.id), name, created: false };
    let createError: unknown;
    try {
      await apiPost<unknown>("/dataHouseCommon/addRemoteDataItem", { name });
    } catch (error) {
      createError = error;
    }
    const confirmed = await exactDataItem(name);
    if (!confirmed) {
      if (createError) throw createError;
      throw new EditorClientError(
        "upstream",
        `Tenant data item '${name}' was not confirmed after creation.`,
        "data_item_create_unconfirmed",
      );
    }
    return { id: text(confirmed.id), name, created: createError == null };
  });
}
