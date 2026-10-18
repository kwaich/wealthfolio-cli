import { COMMANDS, PAYLOADS, SCHEMAS } from "./contract";

interface Schema {
  payload: string;
  result: string;
  source: string;
}

/** Payload type that the vendored invoke reads for a command, as TypeScript text. */
export function payloadHint(command: string): string {
  return (PAYLOADS as Record<string, string>)[command] ?? "none";
}

export interface CommandInfo {
  name: string;
  method: string;
  path: string;
  /** Keys the vendored invoke switch reads (vendor/.../payloads.json). */
  payload: string;
  /** The payload type the web app's typed caller passes, expanded. */
  payloadType?: string;
  /** The response type the web app's typed caller expects, expanded. */
  resultType?: string;
  /** Upstream file and line of that caller. */
  source?: string;
  note?: string;
}

const NOTE =
  "payloadType is what the web app's code passes, not the server's own contract: " +
  "the server can require a field the web app always sends (create_account needs " +
  "isDefault). A rejected payload's error names the field.";

export function commandInfo(name: string): CommandInfo | undefined {
  if (!Object.hasOwn(COMMANDS, name)) return undefined;
  const { method, path } = COMMANDS[name]!;
  const schema = (SCHEMAS as Record<string, Schema>)[name];
  return {
    name,
    method,
    path,
    payload: payloadHint(name),
    ...(schema
      ? {
          payloadType: schema.payload,
          resultType: schema.result,
          source: schema.source,
          note: NOTE,
        }
      : {}),
  };
}
