export interface OutputOptions {
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
