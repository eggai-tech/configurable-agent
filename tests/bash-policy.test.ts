import { describe, expect, it } from 'vitest';
import { type BashPolicyConfig, classify } from '../src/agent/tools/bash-policy.js';

function cfg(overrides: Partial<BashPolicyConfig> = {}): BashPolicyConfig {
  return {
    allowCompound: false,
    disableBuiltinAllow: false,
    bypassSecurityChecks: false,
    allow: [],
    ask: [],
    deny: [],
    ...overrides,
  };
}

const NO_SESSION = new Set<string>();

describe('classify — builtin allowlist', () => {
  it('allows `kubectl get pods`', () => {
    const v = classify('kubectl get pods', cfg(), NO_SESSION);
    expect(v.decision).toBe('allow');
    expect(v.matchedRule).toBe('kubectl get');
  });

  it('allows `ls -la /tmp`', () => {
    const v = classify('ls -la /tmp', cfg(), NO_SESSION);
    expect(v.decision).toBe('allow');
  });

  it('asks for `kubectl delete pod foo` (not in builtin)', () => {
    const v = classify('kubectl delete pod foo', cfg(), NO_SESSION);
    expect(v.decision).toBe('ask');
  });

  it('omits env/printenv from builtin allow (secret leak)', () => {
    expect(classify('env', cfg(), NO_SESSION).decision).toBe('ask');
    expect(classify('printenv', cfg(), NO_SESSION).decision).toBe('ask');
  });
});

describe('classify — deny tier', () => {
  it('denies when a deny rule matches', () => {
    const v = classify('rm -rf /tmp/foo', cfg({ deny: ['rm'] }), NO_SESSION);
    expect(v.decision).toBe('deny');
    expect(v.matchedRule).toBe('rm');
  });

  it('deny overrides builtin allow', () => {
    const v = classify('ls /etc/shadow', cfg({ deny: ['ls /etc/shadow'] }), NO_SESSION);
    expect(v.decision).toBe('deny');
  });
});

describe('classify — ask tier overrides allow', () => {
  it('ask: [env] wins even with allow: [env]', () => {
    const v = classify('env', cfg({ allow: ['env'], ask: ['env'] }), NO_SESSION);
    expect(v.decision).toBe('ask');
    expect(v.matchedRule).toBe('env');
  });

  it('ask: [kubectl get] overrides builtin allow', () => {
    const v = classify('kubectl get pods', cfg({ ask: ['kubectl get'] }), NO_SESSION);
    expect(v.decision).toBe('ask');
  });
});

describe('classify — compound commands (bypass defense)', () => {
  it.each([
    ['kubectl get pods; rm -rf /', ';'],
    ['kubectl get pods && rm -rf /', '&&'],
    ['kubectl get pods || rm -rf /', '||'],
    ['kubectl get pods | jq .', '|'],
    ['cat file > /tmp/out', '>'],
    ['cat < /tmp/in', '<'],
  ])('forces ask for compound: `%s` (operator %s)', (command) => {
    const v = classify(command, cfg(), NO_SESSION);
    expect(v.decision).toBe('ask');
    expect(v.reason).toBe('compound command');
    expect(v.isCompound).toBe(true);
  });

  it('detects command substitution via `$(...)`', () => {
    const v = classify('kubectl get $(whoami)', cfg(), NO_SESSION);
    expect(v.decision).toBe('ask');
    expect(v.isCompound).toBe(true);
  });

  it('detects backtick substitution', () => {
    const v = classify('kubectl get `whoami`', cfg(), NO_SESSION);
    expect(v.decision).toBe('ask');
    expect(v.isCompound).toBe(true);
  });

  it('allows compound when allowCompound=true', () => {
    const v = classify('kubectl get pods | jq .', cfg({ allowCompound: true }), NO_SESSION);
    expect(v.decision).toBe('allow');
  });
});

describe('classify — user allow rules', () => {
  it('allows a user-configured allow rule', () => {
    const v = classify('helm upgrade foo ./chart', cfg({ allow: ['helm upgrade'] }), NO_SESSION);
    expect(v.decision).toBe('allow');
    expect(v.matchedRule).toBe('helm upgrade');
  });

  it('default is ask for unmatched commands', () => {
    const v = classify('make deploy', cfg(), NO_SESSION);
    expect(v.decision).toBe('ask');
    expect(v.matchedRule).toBeNull();
  });
});

describe('classify — session rules', () => {
  it('session rule makes a matching call allow', () => {
    const session = new Set(['kubectl delete pod']);
    const v = classify('kubectl delete pod foo', cfg(), session);
    expect(v.decision).toBe('allow');
    expect(v.matchedRule).toBe('kubectl delete pod');
  });

  it('session rule does NOT bypass compound check', () => {
    const session = new Set(['kubectl get']);
    const v = classify('kubectl get pods; rm -rf /', cfg(), session);
    expect(v.decision).toBe('ask');
    expect(v.reason).toBe('compound command');
  });

  it('deny still wins over session allow', () => {
    const session = new Set(['kubectl delete']);
    const v = classify('kubectl delete pod foo', cfg({ deny: ['kubectl delete'] }), session);
    expect(v.decision).toBe('deny');
  });
});

describe('classify — disableBuiltinAllow', () => {
  it('asks for builtin commands when builtins are disabled', () => {
    const v = classify('ls', cfg({ disableBuiltinAllow: true }), NO_SESSION);
    expect(v.decision).toBe('ask');
  });

  it('user allow still works with builtins disabled', () => {
    const v = classify('ls', cfg({ disableBuiltinAllow: true, allow: ['ls'] }), NO_SESSION);
    expect(v.decision).toBe('allow');
  });
});

describe('classify — bypassSecurityChecks', () => {
  it('allows an unknown command when bypass is on', () => {
    const v = classify('make deploy', cfg({ bypassSecurityChecks: true }), NO_SESSION);
    expect(v.decision).toBe('allow');
    expect(v.reason).toBe('bypassSecurityChecks');
    expect(v.matchedRule).toBeNull();
  });

  it('allows a compound command when bypass is on', () => {
    const v = classify(
      'kubectl get pods; rm -rf /',
      cfg({ bypassSecurityChecks: true }),
      NO_SESSION,
    );
    expect(v.decision).toBe('allow');
    expect(v.reason).toBe('bypassSecurityChecks');
  });

  it('overrides a matching deny rule when bypass is on', () => {
    const v = classify(
      'rm -rf /tmp/foo',
      cfg({ bypassSecurityChecks: true, deny: ['rm'] }),
      NO_SESSION,
    );
    expect(v.decision).toBe('allow');
    expect(v.reason).toBe('bypassSecurityChecks');
  });

  it('still enforces policy when bypass is off', () => {
    const v = classify('make deploy', cfg({ bypassSecurityChecks: false }), NO_SESSION);
    expect(v.decision).toBe('ask');
  });
});

describe('classify — suggestedRules', () => {
  it('suggests a two-token rule for kubectl/helm/git', () => {
    const v = classify('kubectl delete pod foo', cfg(), NO_SESSION);
    expect(v.suggestedRules).toContain('kubectl delete');
  });

  it('suggests the head token for other commands', () => {
    const v = classify('make deploy', cfg(), NO_SESSION);
    expect(v.suggestedRules).toContain('make');
  });
});
