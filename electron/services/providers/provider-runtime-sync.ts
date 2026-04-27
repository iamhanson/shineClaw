import type { GatewayManager } from '../../gateway/manager';
import { getProviderAccount, listProviderAccounts } from './provider-store';
import { getProviderSecret } from '../secrets/secret-store';
import type { ProviderConfig } from '../../utils/secure-storage';
import {
  getAllProviders,
  getApiKey,
  getDefaultProvider,
  getProvider,
} from '../../utils/secure-storage';
import { getProviderConfig, getProviderDefaultModel } from '../../utils/provider-registry';
import {
  removeProviderFromOpenClaw,
  saveOAuthTokenToOpenClaw,
  saveProviderKeyToOpenClaw,
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw,
  updateAgentModelProvider,
  getOpenClawProvidersConfig,
} from '../../utils/openclaw-auth';
import { logger } from '../../utils/logger';

const GOOGLE_OAUTH_RUNTIME_PROVIDER = 'google-gemini-cli';
const GOOGLE_OAUTH_DEFAULT_MODEL_REF = `${GOOGLE_OAUTH_RUNTIME_PROVIDER}/gemini-3-pro-preview`;
const OPENAI_OAUTH_RUNTIME_PROVIDER = 'openai-codex';
const OPENAI_OAUTH_DEFAULT_MODEL_REF = `${OPENAI_OAUTH_RUNTIME_PROVIDER}/gpt-5.3-codex`;

type RuntimeProviderSyncContext = {
  runtimeProviderKey: string;
  meta: ReturnType<typeof getProviderConfig>;
  api: string;
};

function normalizeProviderBaseUrl(
  config: ProviderConfig,
  baseUrl?: string,
  apiProtocol?: string
): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');

  if (config.type === 'minimax-portal' || config.type === 'minimax-portal-cn') {
    return (
      normalized
        .replace(/\/v1$/, '')
        .replace(/\/anthropic$/, '')
        .replace(/\/$/, '') + '/anthropic'
    );
  }

  if (config.type === 'custom' || config.type === 'ollama') {
    const protocol = apiProtocol || config.apiProtocol || 'openai-completions';
    if (protocol === 'openai-responses') {
      return normalized.replace(/\/responses?$/i, '');
    }
    if (protocol === 'openai-completions') {
      return normalized.replace(/\/chat\/completions$/i, '');
    }
    if (protocol === 'anthropic-messages') {
      return normalized.replace(/\/v1\/messages$/i, '').replace(/\/messages$/i, '');
    }
  }

  return normalized;
}

function shouldUseExplicitDefaultOverride(
  config: ProviderConfig,
  runtimeProviderKey: string
): boolean {
  return Boolean(config.baseUrl || config.apiProtocol || runtimeProviderKey !== config.type);
}

/**
 * For custom/ollama providers, `config.model` may already contain a
 * "originalProvider/modelId" path (e.g. "xunfeiMaaSGLM5/xopglm5").
 * We only want the bare model ID (the last segment) so that prefixing
 * the runtime provider key produces "custom-xyz/xopglm5" instead of
 * the broken "custom-xyz/xunfeiMaaSGLM5/xopglm5".
 */
function extractBareModelId(model: string): string {
  const idx = model.lastIndexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

function buildModelOverride(
  providerKey: string,
  model: string | undefined,
  providerType: string
): string | undefined {
  if (!model) return undefined;
  if (model.startsWith(`${providerKey}/`)) return model;
  const modelId =
    providerType === 'custom' || providerType === 'ollama' ? extractBareModelId(model) : model;
  return `${providerKey}/${modelId}`;
}

export function getOpenClawProviderKey(type: string, providerId: string): string {
  if (type === 'custom' || type === 'ollama') {
    // If the providerId itself is already a key in openclaw.json (e.g. user
    // manually configured "subus-imds-ai"), use it directly instead of
    // generating a synthetic "custom-xxxx" key that creates duplicates.
    // We detect this by checking if providerId does NOT look like a
    // ClawX-generated UUID-based id (e.g. "custom-a1b2c3d4-...")
    const isClawXGeneratedId = /^(custom|ollama)-[0-9a-f]{8}-/.test(providerId);
    if (!isClawXGeneratedId) {
      return providerId;
    }
    const suffix = providerId.replace(/-/g, '').slice(0, 8);
    return `${type}-${suffix}`;
  }
  if (type === 'minimax-portal-cn') {
    return 'minimax-portal';
  }
  return type;
}

async function resolveRuntimeProviderKey(config: ProviderConfig): Promise<string> {
  const account = await getProviderAccount(config.id);
  if (account?.authMode === 'oauth_browser') {
    if (config.type === 'google') {
      return GOOGLE_OAUTH_RUNTIME_PROVIDER;
    }
    if (config.type === 'openai') {
      return OPENAI_OAUTH_RUNTIME_PROVIDER;
    }
  }
  return getOpenClawProviderKey(config.type, config.id);
}

async function getBrowserOAuthRuntimeProvider(config: ProviderConfig): Promise<string | null> {
  const account = await getProviderAccount(config.id);
  if (account?.authMode !== 'oauth_browser') {
    return null;
  }

  const secret = await getProviderSecret(config.id);
  if (secret?.type !== 'oauth') {
    return null;
  }

  if (config.type === 'google') {
    return GOOGLE_OAUTH_RUNTIME_PROVIDER;
  }
  if (config.type === 'openai') {
    return OPENAI_OAUTH_RUNTIME_PROVIDER;
  }
  return null;
}

export function getProviderModelRef(config: ProviderConfig): string | undefined {
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  if (config.model) {
    return buildModelOverride(providerKey, config.model, config.type);
  }

  const defaultModel = getProviderDefaultModel(config.type);
  if (!defaultModel) {
    return undefined;
  }

  return defaultModel.startsWith(`${providerKey}/`)
    ? defaultModel
    : `${providerKey}/${defaultModel}`;
}

export async function getProviderFallbackModelRefs(config: ProviderConfig): Promise<string[]> {
  const allProviders = await getAllProviders();
  const providerMap = new Map(allProviders.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const results: string[] = [];
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  for (const fallbackModel of config.fallbackModels ?? []) {
    const normalizedModel = fallbackModel.trim();
    if (!normalizedModel) continue;

    const modelRef = normalizedModel.startsWith(`${providerKey}/`)
      ? normalizedModel
      : `${providerKey}/${normalizedModel}`;

    if (seen.has(modelRef)) continue;
    seen.add(modelRef);
    results.push(modelRef);
  }

  for (const fallbackId of config.fallbackProviderIds ?? []) {
    if (!fallbackId || fallbackId === config.id) continue;

    const fallbackProvider = providerMap.get(fallbackId);
    if (!fallbackProvider) continue;

    const modelRef = getProviderModelRef(fallbackProvider);
    if (!modelRef || seen.has(modelRef)) continue;

    seen.add(modelRef);
    results.push(modelRef);
  }

  return results;
}

type GatewayRefreshMode = 'reload' | 'restart';

function scheduleGatewayRefresh(
  gatewayManager: GatewayManager | undefined,
  message: string,
  options?: { delayMs?: number; onlyIfRunning?: boolean; mode?: GatewayRefreshMode }
): void {
  if (!gatewayManager) {
    return;
  }

  if (options?.onlyIfRunning && gatewayManager.getStatus().state === 'stopped') {
    return;
  }

  logger.info(message);
  if (options?.mode === 'restart') {
    gatewayManager.debouncedRestart(options?.delayMs);
    return;
  }
  gatewayManager.debouncedReload(options?.delayMs);
}

export async function syncProviderApiKeyToRuntime(
  providerType: string,
  providerId: string,
  apiKey: string
): Promise<void> {
  const ock = getOpenClawProviderKey(providerType, providerId);
  await saveProviderKeyToOpenClaw(ock, apiKey);
}

export async function syncAllProviderAuthToRuntime(): Promise<void> {
  const accounts = await listProviderAccounts();

  for (const account of accounts) {
    const runtimeProviderKey = await resolveRuntimeProviderKey({
      id: account.id,
      name: account.label,
      type: account.vendorId,
      baseUrl: account.baseUrl,
      model: account.model,
      fallbackModels: account.fallbackModels,
      fallbackProviderIds: account.fallbackAccountIds,
      enabled: account.enabled,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });

    const secret = await getProviderSecret(account.id);
    if (!secret) {
      continue;
    }

    if (secret.type === 'api_key') {
      await saveProviderKeyToOpenClaw(runtimeProviderKey, secret.apiKey);
      continue;
    }

    if (secret.type === 'local' && secret.apiKey) {
      await saveProviderKeyToOpenClaw(runtimeProviderKey, secret.apiKey);
      continue;
    }

    if (secret.type === 'oauth') {
      await saveOAuthTokenToOpenClaw(runtimeProviderKey, {
        access: secret.accessToken,
        refresh: secret.refreshToken,
        expires: secret.expiresAt,
        email: secret.email,
        projectId: secret.subject,
      });
    }
  }
}

async function syncProviderSecretToRuntime(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKey: string | undefined
): Promise<void> {
  const secret = await getProviderSecret(config.id);
  if (apiKey !== undefined) {
    const trimmedKey = apiKey.trim();
    if (trimmedKey) {
      await saveProviderKeyToOpenClaw(runtimeProviderKey, trimmedKey);
    }
    return;
  }

  if (secret?.type === 'api_key') {
    await saveProviderKeyToOpenClaw(runtimeProviderKey, secret.apiKey);
    return;
  }

  if (secret?.type === 'oauth') {
    await saveOAuthTokenToOpenClaw(runtimeProviderKey, {
      access: secret.accessToken,
      refresh: secret.refreshToken,
      expires: secret.expiresAt,
      email: secret.email,
      projectId: secret.subject,
    });
    return;
  }

  if (secret?.type === 'local' && secret.apiKey) {
    await saveProviderKeyToOpenClaw(runtimeProviderKey, secret.apiKey);
    return;
  }

  // Fallback: if electron-store has no secret, try openclaw.json
  const fallbackKey = await getApiKeyWithFallback(config.id, runtimeProviderKey);
  if (fallbackKey) {
    await saveProviderKeyToOpenClaw(runtimeProviderKey, fallbackKey);
  }
}

async function resolveRuntimeSyncContext(
  config: ProviderConfig
): Promise<RuntimeProviderSyncContext | null> {
  const runtimeProviderKey = await resolveRuntimeProviderKey(config);
  const meta = getProviderConfig(config.type);
  const api = config.apiProtocol || (config.type === 'custom' ? 'openai-completions' : meta?.api);
  if (!api) {
    return null;
  }

  return {
    runtimeProviderKey,
    meta,
    api,
  };
}

async function syncRuntimeProviderConfig(
  config: ProviderConfig,
  context: RuntimeProviderSyncContext
): Promise<void> {
  const modelId =
    (config.type === 'custom' || config.type === 'ollama') && config.model
      ? extractBareModelId(config.model)
      : config.model;
  await syncProviderConfigToOpenClaw(context.runtimeProviderKey, modelId, {
    baseUrl: normalizeProviderBaseUrl(config, config.baseUrl || context.meta?.baseUrl, context.api),
    api: context.api,
    apiKeyEnv: context.meta?.apiKeyEnv,
    headers: config.headers ?? context.meta?.headers,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  });
}

async function syncCustomProviderAgentModel(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKey: string | undefined
): Promise<void> {
  if (config.type !== 'custom') {
    return;
  }

  const resolvedKey =
    apiKey !== undefined
      ? apiKey.trim() || null
      : await getApiKeyWithFallback(config.id, runtimeProviderKey);
  if (!resolvedKey || !config.baseUrl) {
    return;
  }

  const modelId = config.model ? extractBareModelId(config.model) : undefined;
  await updateAgentModelProvider(runtimeProviderKey, {
    baseUrl: normalizeProviderBaseUrl(
      config,
      config.baseUrl,
      config.apiProtocol || 'openai-completions'
    ),
    api: config.apiProtocol || 'openai-completions',
    models: modelId
      ? [
          {
            id: modelId,
            name: modelId,
            ...(typeof config.contextWindow === 'number'
              ? { contextWindow: config.contextWindow }
              : {}),
            ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
          },
        ]
      : [],
    apiKey: resolvedKey,
  });
}

async function syncProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined
): Promise<RuntimeProviderSyncContext | null> {
  const context = await resolveRuntimeSyncContext(config);
  if (!context) {
    return null;
  }

  await syncProviderSecretToRuntime(config, context.runtimeProviderKey, apiKey);
  await syncRuntimeProviderConfig(config, context);
  await syncCustomProviderAgentModel(config, context.runtimeProviderKey, apiKey);
  return context;
}

export async function syncSavedProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
  gatewayManager?: GatewayManager
): Promise<void> {
  const context = await syncProviderToRuntime(config, apiKey);
  if (!context) {
    return;
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway reload after saving provider "${context.runtimeProviderKey}" config`
  );
}

export async function syncUpdatedProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
  gatewayManager?: GatewayManager
): Promise<void> {
  const context = await syncProviderToRuntime(config, apiKey);
  if (!context) {
    return;
  }

  const ock = context.runtimeProviderKey;
  const fallbackModels = await getProviderFallbackModelRefs(config);

  const defaultProviderId = await getDefaultProvider();
  if (defaultProviderId === config.id) {
    const modelOverride = buildModelOverride(ock, config.model, config.type);
    if (config.type !== 'custom') {
      if (shouldUseExplicitDefaultOverride(config, ock)) {
        await setOpenClawDefaultModelWithOverride(
          ock,
          modelOverride,
          {
            baseUrl: normalizeProviderBaseUrl(
              config,
              config.baseUrl || context.meta?.baseUrl,
              context.api
            ),
            api: context.api,
            apiKeyEnv: context.meta?.apiKeyEnv,
            headers: config.headers ?? context.meta?.headers,
          },
          fallbackModels
        );
      } else {
        await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
      }
    } else {
      await setOpenClawDefaultModelWithOverride(
        ock,
        modelOverride,
        {
          baseUrl: normalizeProviderBaseUrl(
            config,
            config.baseUrl,
            config.apiProtocol || 'openai-completions'
          ),
          api: config.apiProtocol || 'openai-completions',
          headers: config.headers,
        },
        fallbackModels
      );
    }
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway reload after updating provider "${ock}" config`
  );
}

export async function syncDeletedProviderToRuntime(
  provider: ProviderConfig | null,
  providerId: string,
  gatewayManager?: GatewayManager,
  runtimeProviderKey?: string
): Promise<void> {
  if (!provider?.type) {
    return;
  }

  const ock =
    runtimeProviderKey ?? (await resolveRuntimeProviderKey({ ...provider, id: providerId }));
  await removeProviderFromOpenClaw(ock);

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway restart after deleting provider "${ock}"`,
    { mode: 'restart' }
  );
}

export async function syncDeletedProviderApiKeyToRuntime(
  provider: ProviderConfig | null,
  providerId: string,
  runtimeProviderKey?: string
): Promise<void> {
  if (!provider?.type) {
    return;
  }

  const ock =
    runtimeProviderKey ?? (await resolveRuntimeProviderKey({ ...provider, id: providerId }));
  await removeProviderFromOpenClaw(ock);
}

/**
 * Get API key for a provider, falling back to openclaw.json if electron-store
 * has no key. This handles the case where users configure providers directly
 * in openclaw.json rather than through the ClawX UI.
 */
async function getApiKeyWithFallback(
  providerId: string,
  runtimeProviderKey: string
): Promise<string | null> {
  const storeKey = await getApiKey(providerId);
  if (storeKey) return storeKey;

  // Fallback: read apiKey from openclaw.json models.providers
  try {
    const { providers } = await getOpenClawProvidersConfig();
    // Try both the providerId and the runtime key (e.g. "custom-xunfeiMa")
    const entry = providers[providerId] ?? providers[runtimeProviderKey];
    if (entry && typeof entry.apiKey === 'string' && entry.apiKey.trim()) {
      return entry.apiKey.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

export async function syncDefaultProviderToRuntime(
  providerId: string,
  gatewayManager?: GatewayManager
): Promise<void> {
  logger.info(`[syncDefault] START providerId="${providerId}"`);
  console.log(`[syncDefault] START providerId="${providerId}"`);
  const provider = await getProvider(providerId);
  if (!provider) {
    logger.warn(`[syncDefault] ABORT: getProvider("${providerId}") returned null`);
    console.log(`[syncDefault] ABORT: getProvider("${providerId}") returned null`);
    return;
  }

  // Enrich provider with data from openclaw.json if electron-store is incomplete
  if (!provider.model || !provider.apiProtocol) {
    try {
      const { providers: ocProviders } = await getOpenClawProvidersConfig();
      const ockForLookup = getOpenClawProviderKey(provider.type, provider.id);
      const ocEntry = ocProviders[providerId] ?? ocProviders[ockForLookup];
      if (ocEntry) {
        if (!provider.model && Array.isArray(ocEntry.models) && ocEntry.models.length > 0) {
          const first = ocEntry.models[0] as Record<string, unknown> | undefined;
          if (first && typeof first.id === 'string') {
            provider.model = first.id;
          }
        }
        if (!provider.apiProtocol && typeof ocEntry.api === 'string') {
          provider.apiProtocol = ocEntry.api as ProviderConfig['apiProtocol'];
        }
      }
    } catch {
      // ignore
    }
  }
  logger.info(
    `[syncDefault] provider found: type="${provider.type}", model="${provider.model}", baseUrl="${provider.baseUrl}"`
  );
  console.log(
    `[syncDefault] provider found: type="${provider.type}", model="${provider.model}", baseUrl="${provider.baseUrl}"`
  );

  const ock = await resolveRuntimeProviderKey(provider);
  const providerKey = await getApiKeyWithFallback(providerId, ock);
  logger.info(
    `[syncDefault] ock="${ock}", hasApiKey=${!!providerKey}, providerKey=${providerKey ? providerKey.slice(0, 8) + '...' : 'null'}`
  );
  console.log(`[syncDefault] ock="${ock}", hasApiKey=${!!providerKey}`);
  const fallbackModels = await getProviderFallbackModelRefs(provider);
  const oauthTypes = ['qwen-portal', 'minimax-portal', 'minimax-portal-cn'];
  const browserOAuthRuntimeProvider = await getBrowserOAuthRuntimeProvider(provider);
  const isOAuthProvider =
    (oauthTypes.includes(provider.type) && !providerKey) || Boolean(browserOAuthRuntimeProvider);
  logger.info(
    `[syncDefault] isOAuthProvider=${isOAuthProvider}, browserOAuth=${browserOAuthRuntimeProvider}`
  );
  console.log(
    `[syncDefault] isOAuthProvider=${isOAuthProvider}, browserOAuth=${browserOAuthRuntimeProvider}`
  );

  if (!isOAuthProvider) {
    const modelOverride = buildModelOverride(ock, provider.model, provider.type);
    logger.info(
      `[syncDefault] NON-OAUTH path: modelOverride="${modelOverride}", providerType="${provider.type}"`
    );

    if (provider.type === 'custom') {
      await setOpenClawDefaultModelWithOverride(
        ock,
        modelOverride,
        {
          baseUrl: normalizeProviderBaseUrl(
            provider,
            provider.baseUrl,
            provider.apiProtocol || 'openai-completions'
          ),
          api: provider.apiProtocol || 'openai-completions',
          headers: provider.headers,
        },
        fallbackModels
      );
    } else if (shouldUseExplicitDefaultOverride(provider, ock)) {
      await setOpenClawDefaultModelWithOverride(
        ock,
        modelOverride,
        {
          baseUrl: normalizeProviderBaseUrl(
            provider,
            provider.baseUrl || getProviderConfig(provider.type)?.baseUrl,
            provider.apiProtocol || getProviderConfig(provider.type)?.api
          ),
          api: provider.apiProtocol || getProviderConfig(provider.type)?.api,
          apiKeyEnv: getProviderConfig(provider.type)?.apiKeyEnv,
          headers: provider.headers ?? getProviderConfig(provider.type)?.headers,
        },
        fallbackModels
      );
    } else {
      await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
    }

    if (providerKey) {
      await saveProviderKeyToOpenClaw(ock, providerKey);
    }
  } else {
    if (browserOAuthRuntimeProvider) {
      const secret = await getProviderSecret(provider.id);
      if (secret?.type === 'oauth') {
        await saveOAuthTokenToOpenClaw(browserOAuthRuntimeProvider, {
          access: secret.accessToken,
          refresh: secret.refreshToken,
          expires: secret.expiresAt,
          email: secret.email,
          projectId: secret.subject,
        });
      }

      const defaultModelRef =
        browserOAuthRuntimeProvider === GOOGLE_OAUTH_RUNTIME_PROVIDER
          ? GOOGLE_OAUTH_DEFAULT_MODEL_REF
          : OPENAI_OAUTH_DEFAULT_MODEL_REF;
      const modelOverride = provider.model
        ? provider.model.startsWith(`${browserOAuthRuntimeProvider}/`)
          ? provider.model
          : `${browserOAuthRuntimeProvider}/${provider.model}`
        : defaultModelRef;

      await setOpenClawDefaultModel(browserOAuthRuntimeProvider, modelOverride, fallbackModels);
      logger.info(`Configured openclaw.json for browser OAuth provider "${provider.id}"`);
      scheduleGatewayRefresh(
        gatewayManager,
        `Scheduling Gateway reload after provider switch to "${browserOAuthRuntimeProvider}"`
      );
      return;
    }

    const defaultBaseUrl =
      provider.type === 'minimax-portal'
        ? 'https://api.minimax.io/anthropic'
        : provider.type === 'minimax-portal-cn'
          ? 'https://api.minimaxi.com/anthropic'
          : 'https://portal.qwen.ai/v1';
    const api: 'anthropic-messages' | 'openai-completions' =
      provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn'
        ? 'anthropic-messages'
        : 'openai-completions';

    let baseUrl = provider.baseUrl || defaultBaseUrl;
    if ((provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn') && baseUrl) {
      baseUrl =
        baseUrl
          .replace(/\/v1$/, '')
          .replace(/\/anthropic$/, '')
          .replace(/\/$/, '') + '/anthropic';
    }

    const targetProviderKey =
      provider.type === 'minimax-portal' || provider.type === 'minimax-portal-cn'
        ? 'minimax-portal'
        : provider.type;

    await setOpenClawDefaultModelWithOverride(
      targetProviderKey,
      getProviderModelRef(provider),
      {
        baseUrl,
        api,
        authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
        apiKeyEnv: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
      },
      fallbackModels
    );

    logger.info(`Configured openclaw.json for OAuth provider "${provider.type}"`);

    try {
      const defaultModelId = provider.model?.split('/').pop();
      await updateAgentModelProvider(targetProviderKey, {
        baseUrl,
        api,
        authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
        apiKey: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
        models: defaultModelId ? [{ id: defaultModelId, name: defaultModelId }] : [],
      });
    } catch (err) {
      logger.warn(`Failed to update models.json for OAuth provider "${targetProviderKey}":`, err);
    }
  }

  if (provider.type === 'custom' && providerKey && provider.baseUrl) {
    const modelId = provider.model ? extractBareModelId(provider.model) : undefined;
    await updateAgentModelProvider(ock, {
      baseUrl: normalizeProviderBaseUrl(
        provider,
        provider.baseUrl,
        provider.apiProtocol || 'openai-completions'
      ),
      api: provider.apiProtocol || 'openai-completions',
      models: modelId ? [{ id: modelId, name: modelId }] : [],
      apiKey: providerKey,
    });
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway reload after provider switch to "${ock}"`,
    { onlyIfRunning: true }
  );
}
