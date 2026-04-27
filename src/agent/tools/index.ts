import type { AgentConfig } from '../../config/schema.js';
import type { ToolSummaryRuntime } from '../safety/tool-summary.js';
import { createBashTool } from './bash.js';
import { createHttpTool } from './http.js';
import { createMoRunTool } from './mo.js';
import { type TodoStore, createTodoWriteTool } from './todowrite.js';
import { createWebSearchTool } from './websearch.js';

export type ToolSet = Record<
  string,
  ReturnType<
    | typeof createBashTool
    | typeof createWebSearchTool
    | typeof createHttpTool
    | typeof createTodoWriteTool
    | typeof createMoRunTool
  >
>;

export function buildTools(cfg: AgentConfig, ctx: ToolSummaryRuntime): ToolSet {
  const tools: ToolSet = {};
  if (cfg.tools.bash.enabled) {
    const policy = cfg.tools.bash.policy;
    tools.bash = createBashTool(
      {
        timeoutMs: cfg.tools.bash.timeoutMs,
        maxBufferBytes: cfg.tools.bash.maxBufferBytes,
        policy: {
          approvalEnabled: policy.approval.enabled,
          allowCompound: policy.allowCompound,
          disableBuiltinAllow: policy.disableBuiltinAllow,
          bypassSecurityChecks: policy.bypassSecurityChecks,
          allow: policy.allow,
          ask: policy.ask,
          deny: policy.deny,
        },
      },
      ctx,
    );
  }
  if (cfg.tools.websearch.enabled) {
    tools.websearch = createWebSearchTool({ maxResults: cfg.tools.websearch.maxResults }, ctx);
  }
  if (cfg.tools.http.enabled) {
    tools.http = createHttpTool(
      {
        timeoutMs: cfg.tools.http.timeoutMs,
        maxResponseBytes: cfg.tools.http.maxResponseBytes,
      },
      ctx,
    );
  }
  if (cfg.tools.todowrite.enabled) {
    const todoStore: TodoStore = { todos: [] };
    tools.todowrite = createTodoWriteTool(
      todoStore,
      { maxItems: cfg.tools.todowrite.maxItems },
      ctx,
    );
  }
  if (cfg.tools.moRun.enabled) {
    tools.mo_run = createMoRunTool(
      {
        timeoutMs: cfg.tools.moRun.timeoutMs,
        maxBufferBytes: cfg.tools.moRun.maxBufferBytes,
      },
      ctx,
    );
  }
  return tools;
}
