interface OutputOptions {
  table?: boolean;
}

type Write = (text: string) => void;

const stdout: Write = (text) => process.stdout.write(text);

/** Compact JSON by default (for agents and jq; indentation costs about a quarter more tokens); `--table` for people. */
export function print(value: unknown, { table = false }: OutputOptions = {}, write = stdout): void {
  if (!table) {
    write(JSON.stringify(value ?? null) + "\n");
    return;
  }
  if (value === undefined || value === null) return;
  write(renderTable(value) + "\n");
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const MAX_CELL = 60;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > MAX_CELL ? flat.slice(0, MAX_CELL - 1) + "…" : flat;
}

export function renderTable(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "(no rows)";
    if (value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) {
      const columns = [...new Set(value.flatMap((row) => Object.keys(row as object)))];
      const rows = value.map((row) =>
        columns.map((c) => clip(cell((row as Record<string, unknown>)[c]))),
      );
      return grid(columns, rows);
    }
    return value.map((v) => clip(cell(v))).join("\n");
  }
  if (value !== null && typeof value === "object") {
    const rows = Object.entries(value).map(([k, v]) => [k, clip(cell(v))]);
    return grid(["key", "value"], rows);
  }
  return cell(value);
}

function grid(columns: string[], rows: string[][]): string {
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [line(columns), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/** A copy of `row` without `keys`. */
export function omit<T extends object>(row: T, ...keys: string[]): T {
  const copy = { ...row } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

function pickPaths(row: unknown, paths: string[][]): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, unknown> = {};
  for (const path of paths) {
    let source: unknown = row;
    for (const key of path) {
      source =
        source !== null && typeof source === "object" && Object.hasOwn(source, key)
          ? (source as Record<string, unknown>)[key]
          : undefined;
    }
    if (source === undefined) continue;
    let target = out;
    for (const key of path.slice(0, -1)) {
      target = (target[key] ??= {}) as Record<string, unknown>;
    }
    target[path.at(-1)!] = source;
  }
  return out;
}

/**
 * Keeps only the dotted `fields` of each row: of each item of an array, of
 * each item of `data` in a `{data, meta}` page (meta stays), or of an object.
 */
export function pick(value: unknown, fields: string[]): unknown {
  const paths = fields.map((f) => f.split("."));
  if (Array.isArray(value)) return value.map((row) => pickPaths(row, paths));
  if (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    const page = value as { data: unknown[] };
    return { ...page, data: page.data.map((row) => pickPaths(row, paths)) };
  }
  return pickPaths(value, paths);
}
