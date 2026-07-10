import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/agent/events.js';
import {
  createTodoStore,
  createTodoWriteTool,
  type TodoWriteInput,
} from '../src/agent/tools/todowrite.js';

const callOptions = { toolCallId: 'call-1', messages: [], context: {} };

// execute() may also be declared as a streaming generator by the SDK types;
// this tool always returns a single envelope.
function asEnvelope(result: AsyncIterable<ToolResult> | ToolResult): ToolResult {
  if (Symbol.asyncIterator in result) throw new Error('unexpected streaming tool result');
  return result;
}

function executeOf(t: ReturnType<typeof createTodoWriteTool>) {
  if (!t.execute) throw new Error('todowrite tool must define execute');
  return t.execute;
}

function envelope(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    label: 'todowrite',
    status: 'succeeded',
    content: '',
    return_code: null,
    args: {},
    duration_ms: 0,
    ...overrides,
  };
}

describe('createTodoWriteTool', () => {
  it('replaces the store with the provided list and returns the full list', async () => {
    const store = createTodoStore();
    const tool = createTodoWriteTool(store);

    const input: TodoWriteInput = {
      todos: [
        { content: 'Step one', activeForm: 'Doing step one', status: 'in_progress' },
        { content: 'Step two', activeForm: 'Doing step two', status: 'pending' },
      ],
    };
    const result = asEnvelope(await executeOf(tool)(input, callOptions));

    expect(result.status).toBe('succeeded');
    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe(2);
    expect(parsed.todos[0].content).toBe('Step one');
    expect(store.todos).toHaveLength(2);
  });

  it('replaces the previous list on a second call', async () => {
    const store = createTodoStore();
    const tool = createTodoWriteTool(store);

    const execute = executeOf(tool);
    await execute(
      { todos: [{ content: 'Old', activeForm: 'Doing old', status: 'in_progress' }] },
      callOptions,
    );
    await execute({ todos: [] }, callOptions);

    expect(store.todos).toHaveLength(0);
  });

  it('toModelOutput returns text for succeeded results', () => {
    const tool = createTodoWriteTool(createTodoStore());

    const out = tool.toModelOutput?.({
      toolCallId: 'call-1',
      input: { todos: [] },
      output: envelope({ content: '{"todos":[]}' }),
    });
    expect(out).toEqual({ type: 'text', value: '{"todos":[]}' });
  });

  it('toModelOutput returns error-text for error results', () => {
    const tool = createTodoWriteTool(createTodoStore());

    const out = tool.toModelOutput?.({
      toolCallId: 'call-1',
      input: { todos: [] },
      output: envelope({ status: 'error', content: 'something went wrong' }),
    });
    expect(out).toEqual({ type: 'error-text', value: 'something went wrong' });
  });
});
