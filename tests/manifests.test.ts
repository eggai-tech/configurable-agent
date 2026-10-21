import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadConfig } from '../src/config/load.js';

// Every config sample that ships with the repo must load through the real
// schema. These files are not exercised by the runtime, so a schema change
// (e.g. a renamed key) can silently break the Helm chart, the raw k8s
// manifest or the marketplace descriptor — exactly what happened when
// toolOutput.triggerTokens became triggerChars.
const repoRoot = resolve(import.meta.dirname, '..');

function readYaml(relativePath: string): unknown {
  return parseYaml(readFileSync(join(repoRoot, relativePath), 'utf8'));
}

describe('shipped config samples validate against the schema', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'configurable-agent-manifests-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function loadFromObject(name: string, config: unknown) {
    const path = join(dir, `${name}.yaml`);
    writeFileSync(path, stringifyYaml(config), 'utf8');
    return loadConfig(path);
  }

  it('example.config.yaml', () => {
    expect(() => loadConfig(join(repoRoot, 'example.config.yaml'))).not.toThrow();
  });

  it('helm/values.yaml default config', () => {
    const values = readYaml('helm/values.yaml') as { config: unknown };
    const cfg = loadFromObject('helm', values.config);
    expect(cfg.safety.toolOutput.triggerChars).toBeGreaterThan(0);
  });

  it('k8s/configmap.yaml config.yaml', () => {
    const configMap = readYaml('k8s/configmap.yaml') as { data: { 'config.yaml': string } };
    const path = join(dir, 'k8s.yaml');
    writeFileSync(path, configMap.data['config.yaml'], 'utf8');
    expect(() => loadConfig(path)).not.toThrow();
  });

  it('descriptor.yaml examples', () => {
    const descriptor = readYaml('descriptor.yaml') as { examples: unknown[] };
    expect(descriptor.examples.length).toBeGreaterThan(0);
    descriptor.examples.forEach((example, i) => {
      expect(() => loadFromObject(`descriptor-${i}`, example)).not.toThrow();
    });
  });
});
