// Stand-in for upstream apps/frontend/src/adapters/types.ts and
// apps/frontend/src/lib/types.ts. The vendored files need only Logger and
// ExportOptions from them.
export interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
}

export interface ExportOptions {
  includeArchived: boolean;
  /** ISO date (YYYY-MM-DD) of the first dated row to include. */
  startDate?: string;
  /** ISO date of the last dated row to include. */
  endDate?: string;
}
