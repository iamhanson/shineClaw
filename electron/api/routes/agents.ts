import type { IncomingMessage, ServerResponse } from 'http';
import {
  assignChannelToAgent,
  clearChannelBinding,
  createAgent,
  deleteAgentConfig,
  listAgentsSnapshot,
  removeAgentWorkspaceDirectory,
  resolveAccountIdForAgent,
  updateAgentConfig,
} from '../../utils/agent-config';
import { deleteChannelAccountConfig } from '../../utils/channel-config';
import { syncAllProviderAuthToRuntime } from '../../services/providers/provider-runtime-sync';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { readFile } from 'fs/promises';

function scheduleGatewayReload(ctx: HostApiContext, reason: string): void {
  if (ctx.gatewayManager.getStatus().state !== 'stopped') {
    ctx.gatewayManager.debouncedReload();
    return;
  }
  void reason;
}

import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

interface ImportedAgentPayload {
  name?: unknown;
  model?: unknown;
  preferredSkills?: unknown;
  skills?: unknown;
  instructions?: unknown;
  prompt?: unknown;
  systemPrompt?: unknown;
  soul?: unknown;
  inheritWorkspace?: unknown;
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function parseImportedAgentText(raw: string): {
  name: string;
  options: {
    inheritWorkspace?: boolean;
    model?: string;
    preferredSkills?: string[];
    instructions?: string;
  };
} {
  const text = raw.trim();
  if (!text) {
    throw new Error('Import source is empty');
  }

  let payload: ImportedAgentPayload | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      payload = parsed as ImportedAgentPayload;
    }
  } catch {
    payload = null;
  }

  if (payload) {
    const nestedAgent =
      payload && typeof (payload as Record<string, unknown>).agent === 'object'
        ? ((payload as Record<string, unknown>).agent as ImportedAgentPayload)
        : null;
    const candidate = nestedAgent ?? payload;

    const name = toTrimmedString(candidate.name) || 'Imported Agent';
    const model = toTrimmedString(candidate.model);
    const preferredSkills = [
      ...toStringList(candidate.preferredSkills),
      ...toStringList(candidate.skills),
    ];
    const instructionCandidates = [
      toTrimmedString(candidate.instructions),
      toTrimmedString(candidate.prompt),
      toTrimmedString(candidate.systemPrompt),
      toTrimmedString(candidate.soul),
    ].filter(Boolean);
    const instructions = instructionCandidates[0] || undefined;

    return {
      name,
      options: {
        inheritWorkspace: candidate.inheritWorkspace === true,
        model: model || undefined,
        preferredSkills: preferredSkills.length > 0 ? Array.from(new Set(preferredSkills)) : undefined,
        instructions,
      },
    };
  }

  return {
    name: 'Imported Agent',
    options: {
      inheritWorkspace: false,
      instructions: text,
    },
  };
}

/**
 * Force a full Gateway process restart after agent deletion.
 *
 * A SIGUSR1 in-process reload is NOT sufficient here: channel plugins
 * (e.g. Feishu) maintain long-lived WebSocket connections to external
 * services and do not disconnect accounts that were removed from the
 * config during an in-process reload.  The only reliable way to drop
 * stale bot connections is to kill the Gateway process entirely and
 * spawn a fresh one that reads the updated openclaw.json from scratch.
 */
export async function restartGatewayForAgentDeletion(ctx: HostApiContext): Promise<void> {
  try {
    // Capture the PID of the running Gateway BEFORE stop() clears it.
    const status = ctx.gatewayManager.getStatus();
    const pid = status.pid;
    const port = status.port;
    console.log('[agents] Triggering Gateway restart (kill+respawn) after agent deletion', { pid, port });

    // Force-kill the Gateway process by PID.  The manager's stop() only
    // kills "owned" processes; if the manager connected to an already-
    // running Gateway (ownsProcess=false), stop() simply closes the WS
    // and the old process stays alive with its stale channel connections.
    if (pid) {
      try {
        if (process.platform === 'win32') {
          await execAsync(`taskkill /F /PID ${pid} /T`);
        } else {
          process.kill(pid, 'SIGTERM');
          // Give it a moment to die
          await new Promise((resolve) => setTimeout(resolve, 500));
          try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
        }
      } catch {
        // process already gone – that's fine
      }
    } else if (port) {
      // If we don't know the PID (e.g. connected to an orphaned Gateway from
      // a previous pnpm dev run), forcefully kill whatever is on the port.
      try {
        if (process.platform === 'darwin' || process.platform === 'linux') {
          // MUST use -sTCP:LISTEN. Otherwise lsof returns the client process (ClawX itself) 
          // that has an ESTABLISHED WebSocket connection to the port, causing us to kill ourselves.
          const { stdout } = await execAsync(`lsof -t -i :${port} -sTCP:LISTEN`);
          const pids = stdout.trim().split('\n').filter(Boolean);
          for (const p of pids) {
            try { process.kill(parseInt(p, 10), 'SIGTERM'); } catch { /* ignore */ }
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          for (const p of pids) {
            try { process.kill(parseInt(p, 10), 'SIGKILL'); } catch { /* ignore */ }
          }
        } else if (process.platform === 'win32') {
          // Find PID listening on the port
          const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
          const lines = stdout.trim().split('\n');
          const pids = new Set<string>();
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 5 && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING') {
              pids.add(parts[4]);
            }
          }
          for (const p of pids) {
            try { await execAsync(`taskkill /F /PID ${p} /T`); } catch { /* ignore */ }
          }
        }
      } catch {
        // Port might not be bound or command failed; ignore
      }
    }

    await ctx.gatewayManager.restart();
    console.log('[agents] Gateway restart completed after agent deletion');
  } catch (err) {
    console.warn('[agents] Gateway restart after agent deletion failed:', err);
  }
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/agents' && req.method === 'GET') {
    sendJson(res, 200, { success: true, ...(await listAgentsSnapshot()) });
    return true;
  }

  if (url.pathname === '/api/agents' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        name: string;
        agentId?: string;
        inheritWorkspace?: boolean;
        model?: string;
        preferredSkills?: string[];
        instructions?: string;
      }>(req);
      const snapshot = await createAgent(body.name, {
        agentId: body.agentId,
        inheritWorkspace: body.inheritWorkspace,
        model: body.model,
        preferredSkills: body.preferredSkills,
        instructions: body.instructions,
      });
      // Sync provider API keys to the new agent's auth-profiles.json so the
      // embedded runner can authenticate with LLM providers when messages
      // arrive via channel bots (e.g. Feishu). Without this, the copied
      // auth-profiles.json may contain a stale key → 401 from the LLM.
      syncAllProviderAuthToRuntime().catch((err) => {
        console.warn('[agents] Failed to sync provider auth after agent creation:', err);
      });
      scheduleGatewayReload(ctx, 'create-agent');
      sendJson(res, 200, { success: true, ...snapshot });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/agents/import' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ filePath?: string; url?: string }>(req);
      const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
      const importUrl = typeof body.url === 'string' ? body.url.trim() : '';

      if (!filePath && !importUrl) {
        sendJson(res, 400, { success: false, error: 'filePath or url is required' });
        return true;
      }

      let sourceText = '';
      if (filePath) {
        sourceText = await readFile(filePath, 'utf-8');
      } else {
        const response = await fetch(importUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch import URL: ${response.status}`);
        }
        sourceText = await response.text();
      }

      const imported = parseImportedAgentText(sourceText);
      const snapshot = await createAgent(imported.name, imported.options);
      syncAllProviderAuthToRuntime().catch((err) => {
        console.warn('[agents] Failed to sync provider auth after agent import:', err);
      });
      scheduleGatewayReload(ctx, 'import-agent');
      sendJson(res, 200, { success: true, ...snapshot });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'PUT') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 1) {
      try {
        const body = await parseJsonBody<{ name?: string; model?: string | null }>(req);
        const agentId = decodeURIComponent(parts[0]);
        const snapshot = await updateAgentConfig(agentId, {
          name: body.name,
          ...(Object.prototype.hasOwnProperty.call(body, 'model') ? { model: body.model ?? null } : {}),
        });
        scheduleGatewayReload(ctx, 'update-agent');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 3 && parts[1] === 'channels') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const channelType = decodeURIComponent(parts[2]);
        const snapshot = await assignChannelToAgent(agentId, channelType);
        scheduleGatewayReload(ctx, 'assign-channel');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'DELETE') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 1) {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const { snapshot, removedEntry } = await deleteAgentConfig(agentId);
        // Await reload synchronously BEFORE responding to the client.
        // This ensures the Feishu plugin has disconnected the deleted bot
        // before the UI shows "delete success" and the user tries chatting.
        await restartGatewayForAgentDeletion(ctx);
        // Delete workspace after reload so the new config is already live.
        await removeAgentWorkspaceDirectory(removedEntry).catch((err) => {
          console.warn('[agents] Failed to remove workspace after agent deletion:', err);
        });
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 3 && parts[1] === 'channels') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const channelType = decodeURIComponent(parts[2]);
        const ownerId = agentId.trim().toLowerCase();
        const snapshotBefore = await listAgentsSnapshot();
        const ownedAccountIds = Object.entries(snapshotBefore.channelAccountOwners)
          .filter(([channelAccountKey, owner]) => {
            if (owner !== ownerId) return false;
            return channelAccountKey.startsWith(`${channelType}:`);
          })
          .map(([channelAccountKey]) => channelAccountKey.slice(channelAccountKey.indexOf(':') + 1));
        // Backward compatibility for legacy agentId->accountId mapping.
        if (ownedAccountIds.length === 0) {
          const legacyAccountId = resolveAccountIdForAgent(agentId);
          if (snapshotBefore.channelAccountOwners[`${channelType}:${legacyAccountId}`] === ownerId) {
            ownedAccountIds.push(legacyAccountId);
          }
        }

        for (const accountId of ownedAccountIds) {
          await deleteChannelAccountConfig(channelType, accountId);
          await clearChannelBinding(channelType, accountId);
        }
        const snapshot = await listAgentsSnapshot();
        scheduleGatewayReload(ctx, 'remove-agent-channel');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }
  }

  return false;
}
