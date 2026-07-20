import { describe, expect, it } from 'vitest';
import { buildModel } from '../src/agent/model.js';
import type { AgentConfig } from '../src/config/schema.js';

type ModelConfig = AgentConfig['model'];

describe('buildModel — openai-compatible provider', () => {
  it('constructs a model using the configured baseUrl', () => {
    const cfg: ModelConfig = {
      provider: 'openai-compatible',
      name: 'mistral-small-latest',
      baseUrl: 'https://api.mistral.ai/v1',
    };
    expect(() => buildModel(cfg)).not.toThrow();
  });

  it('falls back to OPENAI_BASE_URL env var when baseUrl is not set', () => {
    const original = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = 'https://custom.endpoint/v1';
    try {
      const cfg: ModelConfig = {
        provider: 'openai-compatible',
        name: 'llama3',
      };
      expect(() => buildModel(cfg)).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = original;
    }
  });

  it('reads OPENAI_API_KEY from environment', () => {
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
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });
});
