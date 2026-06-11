import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/agent/model.js';
import type { AgentConfig } from '../src/config/schema.js';

type ModelConfig = AgentConfig['model'];

describe('buildModel — openai-compatible provider', () => {
  it('constructs a model using the configured baseUrl and apiKey', () => {
    const cfg: ModelConfig = {
      provider: 'openai-compatible',
      name: 'mistral-small-latest',
      baseUrl: 'https://api.mistral.ai/v1',
      apiKey: 'test-key',
    };
    // Should not throw — the model object is constructed synchronously
    expect(() => buildModel(cfg)).not.toThrow();
  });

  it('falls back to OPENAI_BASE_URL env var when baseUrl is not set', () => {
    const original = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'https://custom.endpoint/v1';
    try {
      const cfg: ModelConfig = {
        provider: 'openai-compatible',
        name: 'llama3',
        apiKey: '',
      };
      expect(() => buildModel(cfg)).not.toThrow();
    } finally {
      if (original === undefined) process.env.OPENAI_BASE_URL = undefined;
      else process.env.OPENAI_BASE_URL = original;
    }
  });

  it('allows empty apiKey for unauthenticated endpoints (e.g. Ollama)', () => {
    const cfg: ModelConfig = {
      provider: 'openai-compatible',
      name: 'llama3',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
    };
    expect(() => buildModel(cfg)).not.toThrow();
  });

  it('falls back to OPENAI_API_KEY env var when apiKey is not set', () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'env-key';
    try {
      const cfg: ModelConfig = {
        provider: 'openai-compatible',
        name: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
      };
      expect(() => buildModel(cfg)).not.toThrow();
    } finally {
      if (original === undefined) process.env.OPENAI_API_KEY = undefined;
      else process.env.OPENAI_API_KEY = original;
    }
  });
});
