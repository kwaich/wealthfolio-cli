// `wf agent-token`: a personal access token for the server's /mcp endpoint,
// which `wf activity update` needs. Created through the login session, with
// the activity scopes only, and stored in agent-token.json (mode 0600).
import { hostname } from "node:os";
import type { Command } from "commander";
import { Client } from "../client";
import { open, output, VERSION } from "../context";
import { AuthError, ServerError } from "../errors";
import { McpClient } from "../mcp";
import { clearAgentToken, loadAgentToken, saveAgentToken, type AgentToken } from "../store";
import { intArg } from "./args";

/** What `wf activity update` needs: read, preview (draft) and apply (write). */
export const AGENT_SCOPES = ["activities:read", "activities:draft", "activities:write"];

interface CreatedToken {
  token: string;
  id: string;
  name: string;
  scopes: string[];
  expiresAt?: string | null;
}

/** The stored token without its secret. */
function describe(token: AgentToken): Omit<AgentToken, "token"> {
  return Object.fromEntries(Object.entries(token).filter(([key]) => key !== "token")) as Omit<
    AgentToken,
    "token"
  >;
}

/** The token for this server: WF_AGENT_TOKEN (never stored), else the stored one. */
export function agentToken(client: Client): { token: string; profileId?: string } {
  const env = process.env.WF_AGENT_TOKEN;
  if (env) return { token: env, profileId: client.profileId };
  const stored = loadAgentToken();
  if (stored?.url === client.url) return { token: stored.token, profileId: stored.profileId };
  throw new AuthError(
    `No agent access token for ${client.url}.`,
    "Run `wf agent-token create` (the server needs WF_MCP_ENABLED=true), or set WF_AGENT_TOKEN.",
  );
}

/** Runs `fn` in one MCP session with this server. */
export async function withMcp<T>(client: Client, fn: (mcp: McpClient) => Promise<T>): Promise<T> {
  const { token, profileId } = agentToken(client);
  const mcp = await McpClient.connect({ baseUrl: client.url, token, profileId, version: VERSION });
  try {
    return await fn(mcp);
  } finally {
    await mcp.close();
  }
}

/** Revokes token `id` in the session's profile; false when it is not there. */
async function revoke(client: Client, id: string): Promise<boolean> {
  const tokens = await client.invoke<{ id: string; revokedAt?: string | null }[]>(
    "list_agent_access_tokens",
  );
  if (!tokens.some((t) => t.id === id)) return false;
  await client.invoke("delete_agent_access_token", { id });
  return true;
}

export function registerAgentToken(program: Command): void {
  const cmd = program
    .command("agent-token")
    .description(
      "Manage the access token for the server's MCP endpoint, which `wf activity update` uses",
    );

  cmd
    .command("create")
    .description(
      `Create a token with the scopes ${AGENT_SCOPES.join(", ")} for the current profile ` +
        "and store it; replaces the stored one",
    )
    .option("--expires-days <days>", "days until the token expires; 0 for never", intArg, 90)
    .action(async (opts: { expiresDays: number }, sub: Command) => {
      const client = open(sub);
      await client.ensureProfile();
      const old = loadAgentToken();
      const created = await client.invoke<CreatedToken>("create_agent_access_token", {
        name: `wf CLI (${hostname()})`,
        scopes: AGENT_SCOPES,
        ...(opts.expiresDays > 0
          ? { expiresAt: new Date(Date.now() + opts.expiresDays * 86_400_000).toISOString() }
          : {}),
      });
      const token: AgentToken = {
        url: client.url,
        profileId: client.profileId,
        id: created.id,
        name: created.name,
        token: created.token,
        scopes: created.scopes,
        expiresAt: created.expiresAt ?? null,
      };
      saveAgentToken(token);
      // Check that /mcp is on and takes the token; keep the token either way.
      let mcp: { ok: boolean; error?: string; hint?: string } = { ok: true };
      try {
        await withMcp(client, async () => {});
      } catch (error) {
        if (!(error instanceof ServerError || error instanceof AuthError)) throw error;
        mcp = { ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}) };
        process.exitCode = 1;
      }
      let replaced: string | undefined;
      if (old && old.url === client.url && old.profileId === client.profileId) {
        if (await revoke(client, old.id)) replaced = old.id;
      }
      output(sub, { ...describe(token), ...(replaced ? { replaced } : {}), mcp });
    });

  cmd
    .command("show")
    .description("Show the stored token (without its secret)")
    .action((_opts, sub: Command) => {
      const stored = loadAgentToken();
      output(sub, stored ? describe(stored) : null);
    });

  cmd
    .command("delete")
    .description("Revoke the stored token on the server and delete it here")
    .action(async (_opts, sub: Command) => {
      const stored = loadAgentToken();
      if (!stored) {
        output(sub, { deleted: false });
        return;
      }
      // The token belongs to the server it was made on, whatever --url says now.
      const client = Client.open({ url: stored.url });
      await client.ensureProfile();
      const revoked = await revoke(client, stored.id);
      clearAgentToken();
      output(sub, { deleted: true, revoked, id: stored.id });
    });
}
