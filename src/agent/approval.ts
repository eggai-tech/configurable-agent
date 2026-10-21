import type { AgentConfig } from '../config/schema.js';

export type ApprovalConfig = AgentConfig['safety']['approval'];

// Internal, side-effect-free tools that are never gated on human approval.
const NEVER_APPROVED_TOOLS = new Set(['todowrite']);

/**
 * Decide whether a model-invoked tool call must be approved by a human before
 * it executes, per the configured approval policy:
 * - `none`     — never (default).
 * - `all`      — every tool except the internal exemptions.
 * - `selected` — only tools whose name matches a glob pattern in `tools`.
 */
export function toolNeedsApproval(toolName: string, approval: ApprovalConfig): boolean {
  if (approval.mode === 'none' || NEVER_APPROVED_TOOLS.has(toolName)) return false;
  if (approval.mode === 'all') return true;
  return approval.tools.some((pattern) => globToRegExp(pattern).test(toolName));
}

const escapeRegExp = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Compile a glob-style pattern (`*` wildcard) into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
}
