import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildModel, requiredEnvVarFor } from '../src/agent/model.js';
import type { AgentConfig } from '../src/config/schema.js';

// Fake Entra credential: no network, fixed token.
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  getBearerTokenProvider: () => async () => 'entra-token',
}));

type ModelConfig = AgentConfig['model'];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildModel — azure provider', () => {
  it('sends the Entra token as a bearer header to the configured baseUrl', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const model = buildModel({
      provider: 'azure',
      name: 'gpt-5-deployment',
      baseUrl: 'https://my-res.openai.azure.com/openai',
    });

    await expect(generateText({ model, prompt: 'ping', maxRetries: 0 })).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://my-res.openai.azure.com/openai/v1/responses?api-version=v1');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer entra-token');
    expect(headers.get('api-key')).toBeNull();
  });

  it('needs no API key env var', () => {
    expect(requiredEnvVarFor('azure')).toBeNull();
  });
});

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
