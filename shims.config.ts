import { fileURLToPath } from "node:url";

// Module aliases for the vendored upstream contract. Keep in sync with
// tsconfig.json "paths" (tsc reads that file; vitest reads this one).
export const shimAliases: Record<string, string> = {
  "@/features/profiles/session": fileURLToPath(new URL("./src/shims/session.ts", import.meta.url)),
  "@/lib/auth-token": fileURLToPath(new URL("./src/shims/auth-token.ts", import.meta.url)),
};
