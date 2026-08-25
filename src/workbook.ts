/** Deterministic inspection of the official UPR workbook before any remote write. */

import ExcelJS from "exceljs";
import { EditorClientError } from "./types.js";

const MAX_WORKBOOK_BYTES = 200 * 1024 * 1024;
const BASIC_INFO_SHEETS = new Set(["基本信息", "Basic information", "Basic Information"]);

const NAME_FIELDS: readonly (readonly string[])[] = [
  ["数据集名称", "Process name", "产品", "Product"],
  ["技术路线/工艺路径", "Technology route"],
  ["材质/成分", "Material/Composition"],
  ["形状/状态", "Shape/State"],
  ["规格型号（定量）", "Specifications and models (Quantitative)"],
  ["用途", "Application"],
  ["燃料类型", "Fuel type"],
  ["产品品质（定性）", "Product quality (Qualitative)"],
  ["标准", "Standard"],
  ["来源", "Source"],
  ["补充说明", "Additional notes"],
];

const REFERENCE_PRODUCT_FIELDS = new Set(["参考产品", "Reference product"]);
const ITEM_NAME_FIELDS = new Set(["数据项名称", "Data item name"]);
const ITEM_CATEGORY_FIELDS = new Set(["数据项分类", "Data item classification"]);
const UNIT_FIELDS = new Set(["单位名称", "Unit name"]);
const PRODUCT_VALUES = new Set(["产品", "Product"]);

export interface UprWorkbookIdentity {
  processName: string;
  referenceProduct: string;
  referenceUnit: string;
}

function cellText(cell: ExcelJS.Cell): string {
  return cell.text.trim();
}

function clean(value: string, label: string, max = 240): string {
  const text = value.trim();
  if (!text || text.length > max || /[\r\n\0]/u.test(text)) {
    throw new EditorClientError("validation", `${label} must be a non-empty single-line value.`);
  }
  return text;
}

function firstValue(values: ReadonlyMap<string, string>, labels: readonly string[]): string {
  for (const label of labels) {
    const value = values.get(label)?.trim();
    if (value) return value;
  }
  return "";
}

export async function inspectUprWorkbook(bytes: Uint8Array): Promise<UprWorkbookIdentity> {
  if (bytes.byteLength < 100 || bytes.byteLength > MAX_WORKBOOK_BYTES) {
    throw new EditorClientError(
      "validation",
      `UPR workbook must be between 100 bytes and ${MAX_WORKBOOK_BYTES} bytes.`,
    );
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  } catch (error) {
    throw new EditorClientError(
      "validation",
      `Could not parse UPR workbook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const basic = workbook.worksheets.find((sheet) => BASIC_INFO_SHEETS.has(sheet.name));
  if (!basic) throw new EditorClientError("validation", "UPR workbook is missing the basic-information sheet.");

  const values = new Map<string, string>();
  basic.eachRow((row) => {
    const label = cellText(row.getCell(1));
    if (label) values.set(label, cellText(row.getCell(2)));
  });
  const processParts = NAME_FIELDS.map((labels) => firstValue(values, labels)).filter(Boolean);
  const processName = clean(processParts.join(","), "UPR process name");
  const referenceLabel = [...REFERENCE_PRODUCT_FIELDS].find((label) => values.get(label)?.trim());
  const referenceProduct = clean(referenceLabel ? values.get(referenceLabel) ?? "" : "", "UPR reference product", 80);

  const units = new Set<string>();
  for (const sheet of workbook.worksheets.filter((item) => item.name.toUpperCase().startsWith("P-"))) {
    let headerRow = 0;
    let nameColumn = 0;
    let categoryColumn = 0;
    let unitColumn = 0;
    sheet.eachRow((row, rowNumber) => {
      if (headerRow) return;
      row.eachCell((cell, columnNumber) => {
        const value = cellText(cell);
        if (ITEM_NAME_FIELDS.has(value)) nameColumn = columnNumber;
        if (ITEM_CATEGORY_FIELDS.has(value)) categoryColumn = columnNumber;
        if (UNIT_FIELDS.has(value)) unitColumn = columnNumber;
      });
      if (nameColumn && categoryColumn && unitColumn) headerRow = rowNumber;
    });
    if (!headerRow) continue;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      if (!PRODUCT_VALUES.has(cellText(row.getCell(categoryColumn)))) return;
      if (cellText(row.getCell(nameColumn)) !== referenceProduct) return;
      units.add(clean(cellText(row.getCell(unitColumn)), "UPR reference-product unit", 100));
    });
  }
  if (units.size !== 1) {
    throw new EditorClientError(
      "validation",
      units.size === 0
        ? `No product row matches reference product '${referenceProduct}'.`
        : `Reference product '${referenceProduct}' has multiple units: ${[...units].join(", ")}.`,
    );
  }
  return { processName, referenceProduct, referenceUnit: [...units][0]! };
}
