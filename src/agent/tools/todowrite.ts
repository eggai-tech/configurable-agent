import { type Tool, tool } from 'ai';
import { z } from 'zod';
import type { ToolResult } from '../events.js';
import { toolResultToModelOutput } from '../events.js';

// Single source of truth: the tool's input schema. All todo types derive from
// it, so the model-facing contract and the TypeScript types cannot drift.
const TodoItemSchema = z.object({
  content: z
    .string()
    .min(1, 'todo content must not be empty')
    .describe('Imperative description of the task'),
  activeForm: z
    .string()
    .min(1, 'todo activeForm must not be empty')
    .describe('Present-continuous form shown while working on the task'),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

const TodoWriteInputSchema = z.object({
  todos: z.array(TodoItemSchema).describe('The full replacement list of todos'),
});

export type TodoItem = z.infer<typeof TodoItemSchema>;
export type TodoStatus = TodoItem['status'];
export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

export interface TodoStore {
  todos: TodoItem[];
}

export function createTodoStore(): TodoStore {
  return { todos: [] };
}

export function createTodoWriteTool(store: TodoStore): Tool<TodoWriteInput, ToolResult> {
  return tool({
    description:
      'Manage a structured todo list to plan and track multi-step work within this run. ' +
      'Each call REPLACES the entire list. Use this to break complex requests into steps, ' +
      'then update status as you progress. Exactly one item should be in_progress at a time. ' +
      'Each todo has: `content` (imperative, e.g. "Add HTTP tool"), `activeForm` ' +
      '(present-continuous shown while working, e.g. "Adding HTTP tool"), and `status` ' +
      '(one of pending / in_progress / completed). Returns the updated list.',
    inputSchema: TodoWriteInputSchema,
    execute: async (args): Promise<ToolResult> => {
      const start = Date.now();
      store.todos = args.todos;
      return {
        label: 'todowrite',
        status: 'succeeded',
        content: JSON.stringify({ todos: store.todos, count: store.todos.length }, null, 2),
        return_code: null,
        args,
        duration_ms: Date.now() - start,
      };
    },
    toModelOutput: toolResultToModelOutput,
  });
}
