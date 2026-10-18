// Stand-in for upstream apps/frontend/src/adapters/types.ts. The vendored
// core.ts needs only Logger from it.
export interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
}
