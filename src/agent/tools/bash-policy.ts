import { parse as shellParse } from 'shell-quote';

export interface BashPolicyConfig {
  allowCompound: boolean;
  disableBuiltinAllow: boolean;
  bypassSecurityChecks: boolean;
  allow: string[];
  ask: string[];
  deny: string[];
}

export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface PolicyVerdict {
  decision: PolicyDecision;
  reason: string;
  matchedRule: string | null;
  isCompound: boolean;
  suggestedRules: string[];
}

export const BUILTIN_ALLOW_RULES: readonly string[] = [
  'ls',
  'pwd',
  'whoami',
  'id',
  'date',
  'uname',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'grep',
  'rg',
  'find',
  'ps',
  'df',
  'du',
  'jq',
  'kubectl get',
  'kubectl describe',
  'kubectl logs',
  'kubectl top',
  'kubectl version',
  'kubectl config current-context',
  'kubectl config get-contexts',
  'helm list',
  'helm status',
  'helm get values',
  'git status',
  'git log',
  'git diff',
  'git show',
  'git branch',
];

export function classify(
  command: string,
  cfg: BashPolicyConfig,
  sessionAllowRules: ReadonlySet<string>,
): PolicyVerdict {
  if (cfg.bypassSecurityChecks) {
    return {
      decision: 'allow',
      reason: 'bypassSecurityChecks',
      matchedRule: null,
      isCompound: false,
      suggestedRules: [],
    };
  }

  const parsed = shellParse(command);
  const isCompound = hasOperatorOrSubstitution(parsed) || hasRawCompoundChars(command);
  const tokens = extractLiteralTokens(parsed);

  if (isCompound && !cfg.allowCompound) {
    const leadingRule = suggestRuleFromTokens(tokens);
    return {
      decision: 'ask',
      reason: 'compound command',
      matchedRule: null,
      isCompound: true,
      suggestedRules: leadingRule ? [leadingRule] : [],
    };
  }

  const denyHit = firstMatch(tokens, cfg.deny);
  if (denyHit) {
    return {
      decision: 'deny',
      reason: `denied by rule: ${denyHit}`,
      matchedRule: denyHit,
      isCompound,
      suggestedRules: [],
    };
  }

  const askHit = firstMatch(tokens, cfg.ask);
  if (askHit) {
    return {
      decision: 'ask',
      reason: `matches ask rule: ${askHit}`,
      matchedRule: askHit,
      isCompound,
      suggestedRules: [askHit],
    };
  }

  const sessionHit = firstMatch(tokens, [...sessionAllowRules]);
  if (sessionHit) {
    return {
      decision: 'allow',
      reason: `session-allowed rule: ${sessionHit}`,
      matchedRule: sessionHit,
      isCompound,
      suggestedRules: [],
    };
  }

  const userAllowHit = firstMatch(tokens, cfg.allow);
  if (userAllowHit) {
    return {
      decision: 'allow',
      reason: `matches allow rule: ${userAllowHit}`,
      matchedRule: userAllowHit,
      isCompound,
      suggestedRules: [],
    };
  }

  if (!cfg.disableBuiltinAllow) {
    const builtinHit = firstMatch(tokens, [...BUILTIN_ALLOW_RULES]);
    if (builtinHit) {
      return {
        decision: 'allow',
        reason: `builtin read-only: ${builtinHit}`,
        matchedRule: builtinHit,
        isCompound,
        suggestedRules: [],
      };
    }
  }

  const leadingRule = suggestRuleFromTokens(tokens);
  return {
    decision: 'ask',
    reason: 'no policy match',
    matchedRule: null,
    isCompound,
    suggestedRules: leadingRule ? [leadingRule] : [],
  };
}

function firstMatch(commandTokens: string[], rules: string[]): string | null {
  for (const rule of rules) {
    const ruleTokens = tokenizeRule(rule);
    if (ruleTokens.length === 0) continue;
    if (tokensStartWith(commandTokens, ruleTokens)) return rule;
  }
  return null;
}

function tokensStartWith(command: string[], prefix: string[]): boolean {
  if (prefix.length > command.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (command[i] !== prefix[i]) return false;
  }
  return true;
}

function tokenizeRule(rule: string): string[] {
  const parsed = shellParse(rule);
  return extractLiteralTokens(parsed);
}

type ShellParseEntry = ReturnType<typeof shellParse>[number];

function extractLiteralTokens(parsed: ShellParseEntry[]): string[] {
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') out.push(entry);
  }
  return out;
}

function hasOperatorOrSubstitution(parsed: ShellParseEntry[]): boolean {
  for (const entry of parsed) {
    if (typeof entry === 'string') continue;
    if (entry && typeof entry === 'object') return true;
  }
  return false;
}

function hasRawCompoundChars(command: string): boolean {
  const withoutQuoted = stripQuoted(command);
  return /[`\n\r]/.test(withoutQuoted);
}

function stripQuoted(s: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function suggestRuleFromTokens(tokens: string[]): string | null {
  const head = tokens[0];
  if (head === undefined) return null;
  if (head === 'kubectl' || head === 'helm' || head === 'git') {
    const second = tokens[1];
    return second !== undefined ? `${head} ${second}` : head;
  }
  return head;
}
