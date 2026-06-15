import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { AgentConfig } from '../config/schema.js';

export function buildModel(cfg: AgentConfig['model']): LanguageModel {
  switch (cfg.provider) {
    case 'anthropic':
      return anthropic(cfg.name);
    case 'openai':
      return openai(cfg.name);
    case 'google':
      return google(cfg.name);
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
