import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { generateText, type LanguageModel } from 'ai';
import type { AgentConfig } from '../config/schema.js';
import { errorMessage } from '../util.js';

const AZURE_SCOPE = 'https://cognitiveservices.azure.com/.default';

// One Entra token provider per process, so every model built (main loop,
// compaction, tool summaries, /ready probe) shares its token cache.
let azureTokenProvider: (() => Promise<string>) | undefined;

export function buildModel(cfg: AgentConfig['model']): LanguageModel {
  switch (cfg.provider) {
    case 'anthropic':
      return cfg.baseUrl
        ? createAnthropic({ baseURL: cfg.baseUrl })(cfg.name)
        : anthropic(cfg.name);
    case 'openai':
      return cfg.baseUrl ? createOpenAI({ baseURL: cfg.baseUrl })(cfg.name) : openai(cfg.name);
    case 'azure':
      // Entra ID only: DefaultAzureCredential picks managed identity, AKS
      // workload identity, or `az login` from the environment.
      azureTokenProvider ??= getBearerTokenProvider(new DefaultAzureCredential(), AZURE_SCOPE);
      return createAzure({ baseURL: cfg.baseUrl, tokenProvider: azureTokenProvider })(cfg.name);
    case 'google':
      return cfg.baseUrl
        ? createGoogleGenerativeAI({ baseURL: cfg.baseUrl })(cfg.name)
        : google(cfg.name);
    case 'ollama': {
      const baseURL = cfg.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
      const ollama = createOpenAICompatible({ name: 'ollama', baseURL });
      return ollama(cfg.name);
    }
    case 'openai-compatible': {
      const baseURL = cfg.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
      const apiKey = process.env.OPENAI_API_KEY ?? '';
      const compat = createOpenAICompatible({ name: 'openai-compatible', baseURL, apiKey });
      return compat(cfg.name);
    }
  }
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
}

/**
 * Actively verify the configured model is reachable and authorized by issuing a
 * single minimal generation. Catches failure modes that a presence-of-env-var
 * check cannot — a wrong/revoked key, an unreachable or malformed `baseUrl`, an
 * unknown model name. Used by the `/ready` deep probe; intentionally opt-in
 * because each call hits the provider.
 */
export async function probeModel(
  cfg: AgentConfig['model'],
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    await generateText({
      model: buildModel(cfg),
      prompt: 'ping',
      // 16, not 1: some reasoning models enforce a minimum output budget and
      // would 400 on a smaller value, turning a healthy setup into "not ready".
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: signal,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export function requiredEnvVarFor(provider: AgentConfig['model']['provider']): string | null {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'azure':
      return null;
    case 'google':
      return 'GOOGLE_GENERATIVE_AI_API_KEY';
    case 'ollama':
      return null;
    case 'openai-compatible':
      return null;
  }
}
