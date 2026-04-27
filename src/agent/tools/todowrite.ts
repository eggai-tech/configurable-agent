import { tool } from 'ai';
import { z } from 'zod';
import type { ToolSummaryRuntime } from '../safety/tool-summary.js';
import { type PartialToolResult, intentField, wrapToolExecute } from './result.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

export interface TodoStore {
  todos: TodoItem[];
}

export interface TodoWriteToolConfig {
  maxItems: number;
}

interface TodoWriteArgs {
  todos: TodoItem[];
}

export function createTodoWriteTool(
  store: TodoStore,
  cfg: TodoWriteToolConfig,
  ctx: ToolSummaryRuntime,
) {
  return tool({
    description:
      'Manage a structured todo list to plan and track multi-step work within this run. ' +
      'Each call REPLACES the entire list. Use this to break complex requests into steps, ' +
      'then update status as you progress. Exactly one item should be in_progress at a time. ' +
      'Each todo has: `content` (imperative, e.g. "Add HTTP tool"), `activeForm` ' +
      '(present-continuous shown while working, e.g. "Adding HTTP tool"), and `status` ' +
      '(one of pending / in_progress / completed). Returns the updated list.',
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().min(1).describe('Imperative description of the task'),
            activeForm: z
              .string()
              .min(1)
              .describe('Present-continuous form shown while working on the task'),
            status: z.enum(['pending', 'in_progress', 'completed']),
          }),
        )
        .describe('The full replacement list of todos'),
      ...intentField,
    }),
    execute: async (args, { abortSignal, toolCallId }) =>
      wrapToolExecute<TodoWriteArgs>(
        {
          toolName: 'todowrite',
          labeler: (a) => `update todos (${a.todos.length})`,
          handler: async (a) => runTodoWrite(a, store, cfg),
          ctx,
        },
        args,
        { toolCallId, abortSignal },
      ),
  });
}

async function runTodoWrite(
  args: TodoWriteArgs,
  store: TodoStore,
  cfg: TodoWriteToolConfig,
): Promise<PartialToolResult> {
  if (args.todos.length > cfg.maxItems) {
    throw new Error(`todo list exceeds maxItems (${args.todos.length} > ${cfg.maxItems})`);
  }
  store.todos = args.todos;
  const payload = { todos: store.todos, count: store.todos.length };
  return {
    status: 'succeeded',
    content: JSON.stringify(payload, null, 2),
    return_code: null,
  };
}
