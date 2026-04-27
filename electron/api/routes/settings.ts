import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { applyProxySettings } from '../../main/proxy';
import { syncLaunchAtStartupSettingFromStore } from '../../main/launch-at-startup';
import { syncProxyConfigToOpenClaw } from '../../utils/openclaw-proxy';
import { getAllSettings, getSetting, resetSettings, setSetting, type AppSettings } from '../../utils/store';
import { expandPath, getOpenClawConfigDir } from '../../utils/paths';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const DEFAULT_WORKSPACE_DIR = join(getOpenClawConfigDir(), 'workspace');
const OPENCLAW_CONFIG_FILE = join(getOpenClawConfigDir(), 'openclaw.json');

type OpenClawConfigDocument = {
  agents?: {
    defaults?: {
      workspace?: unknown;
    };
  };
};

async function resolveWorkspaceDir(): Promise<string> {
  try {
    const raw = await readFile(OPENCLAW_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as OpenClawConfigDocument;
    const configured = parsed?.agents?.defaults?.workspace;
    if (typeof configured === 'string' && configured.trim()) {
      return expandPath(configured.trim());
    }
  } catch {
    // Fall back to the default workspace path.
  }
  return DEFAULT_WORKSPACE_DIR;
}

async function readPersonaPromptFromWorkspace(): Promise<string> {
  const workspaceDir = await resolveWorkspaceDir();
  const candidates = [join(workspaceDir, 'soul.md'), join(workspaceDir, 'SOUL.md')];
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      // Try next candidate.
    }
  }
  return '';
}

async function writePersonaPromptToWorkspace(value: string): Promise<void> {
  const workspaceDir = await resolveWorkspaceDir();
  const lower = join(workspaceDir, 'soul.md');
  const upper = join(workspaceDir, 'SOUL.md');
  let target = upper;
  try {
    await readFile(lower, 'utf-8');
    target = lower;
  } catch {
    try {
      await readFile(upper, 'utf-8');
      target = upper;
    } catch {
      target = upper;
    }
  }
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(target, value, 'utf-8');
}

async function handleProxySettingsChange(ctx: HostApiContext): Promise<void> {
  const settings = await getAllSettings();
  await syncProxyConfigToOpenClaw(settings, { preserveExistingWhenDisabled: false });
  await applyProxySettings(settings);
  if (ctx.gatewayManager.getStatus().state === 'running') {
    await ctx.gatewayManager.restart();
  }
}

function patchTouchesProxy(patch: Partial<AppSettings>): boolean {
  return Object.keys(patch).some((key) => (
    key === 'proxyEnabled' ||
    key === 'proxyServer' ||
    key === 'proxyHttpServer' ||
    key === 'proxyHttpsServer' ||
    key === 'proxyAllServer' ||
    key === 'proxyBypassRules'
  ));
}

function patchTouchesLaunchAtStartup(patch: Partial<AppSettings>): boolean {
  return Object.prototype.hasOwnProperty.call(patch, 'launchAtStartup');
}

function patchTouchesFloatingBall(patch: Partial<AppSettings>): boolean {
  return Object.prototype.hasOwnProperty.call(patch, 'floatingBallEnabled');
}

export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const settings = await getAllSettings();
    try {
      const personaPrompt = await readPersonaPromptFromWorkspace();
      settings.personaPrompt = personaPrompt;
      if (settings.personaPrompt !== await getSetting('personaPrompt')) {
        await setSetting('personaPrompt', personaPrompt);
      }
    } catch {
      // Ignore workspace persona sync errors and fall back to stored value.
    }
    sendJson(res, 200, settings);
    return true;
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    try {
      const patch = await parseJsonBody<Partial<AppSettings>>(req);
      if (Object.prototype.hasOwnProperty.call(patch, 'personaPrompt')) {
        await writePersonaPromptToWorkspace(String(patch.personaPrompt ?? ''));
      }
      const entries = Object.entries(patch) as Array<[keyof AppSettings, AppSettings[keyof AppSettings]]>;
      for (const [key, value] of entries) {
        await setSetting(key, value);
      }
      if (patchTouchesProxy(patch)) {
        await handleProxySettingsChange(ctx);
      }
      if (patchTouchesLaunchAtStartup(patch)) {
        await syncLaunchAtStartupSettingFromStore();
      }
      if (patchTouchesFloatingBall(patch) && typeof patch.floatingBallEnabled === 'boolean') {
        ctx.setFloatingBallEnabled?.(patch.floatingBallEnabled);
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/settings/') && req.method === 'GET') {
    const key = url.pathname.slice('/api/settings/'.length) as keyof AppSettings;
    try {
      if (key === 'personaPrompt') {
        const value = await readPersonaPromptFromWorkspace();
        await setSetting('personaPrompt', value);
        sendJson(res, 200, { value });
        return true;
      }
      sendJson(res, 200, { value: await getSetting(key) });
    } catch (error) {
      sendJson(res, 404, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/settings/') && req.method === 'PUT') {
    const key = url.pathname.slice('/api/settings/'.length) as keyof AppSettings;
    try {
      const body = await parseJsonBody<{ value: AppSettings[keyof AppSettings] }>(req);
      if (key === 'personaPrompt') {
        await writePersonaPromptToWorkspace(String(body.value ?? ''));
      }
      await setSetting(key, body.value);
      if (
        key === 'proxyEnabled' ||
        key === 'proxyServer' ||
        key === 'proxyHttpServer' ||
        key === 'proxyHttpsServer' ||
        key === 'proxyAllServer' ||
        key === 'proxyBypassRules'
      ) {
        await handleProxySettingsChange(ctx);
      }
      if (key === 'launchAtStartup') {
        await syncLaunchAtStartupSettingFromStore();
      }
      if (key === 'floatingBallEnabled' && typeof body.value === 'boolean') {
        ctx.setFloatingBallEnabled?.(body.value);
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/settings/reset' && req.method === 'POST') {
    try {
      await resetSettings();
      await writePersonaPromptToWorkspace('');
      await setSetting('personaPrompt', '');
      await handleProxySettingsChange(ctx);
      await syncLaunchAtStartupSettingFromStore();
      sendJson(res, 200, { success: true, settings: await getAllSettings() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
