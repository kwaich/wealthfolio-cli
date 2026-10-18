import { PAYLOADS } from "./contract";

/** Payload type that the vendored invoke reads for a command, as TypeScript text. */
export function payloadHint(command: string): string {
  return (PAYLOADS as Record<string, string>)[command] ?? "none";
}
