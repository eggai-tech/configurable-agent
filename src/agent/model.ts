import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI, google } from '@ai-sdk/google';
import { createOpenAI, openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type LanguageModel } from 'ai';
import type { AgentConfig } from '../config/schema.js';
import { errorMessage } from '../util.js';

export function buildModel(cfg: AgentConfig['model']): LanguageModel {
  switch (cfg.provider) {
    case 'anthropic':
      return cfg.baseUrl
        ? createAnthropic({ baseURL: cfg.baseUrl })(cfg.name)
        : anthropic(cfg.name);
    case 'openai':
      return cfg.baseUrl ? createOpenAI({ baseURL: cfg.baseUrl })(cfg.name) : openai(cfg.name);
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
      maxOutputTokens: 1,
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
    case 'google':
      return 'GOOGLE_GENERATIVE_AI_API_KEY';
    case 'ollama':
      return null;
    case 'openai-compatible':
      return null;
  }
}
