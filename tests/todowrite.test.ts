import { describe, expect, it } from 'vitest';
import { createTodoStore, createTodoWriteTool } from '../src/agent/tools/todowrite.js';

describe('createTodoWriteTool', () => {
  it('replaces the store with the provided list and returns the full list', async () => {
    const store = createTodoStore();
    const tool = createTodoWriteTool(store);

    const execute = (tool as unknown as { execute: (args: unknown) => Promise<unknown> }).execute;
    const result = (await execute({
      todos: [
        { content: 'Step one', activeForm: 'Doing step one', status: 'in_progress' },
        { content: 'Step two', activeForm: 'Doing step two', status: 'pending' },
      ],
    })) as { status: string; content: string };

    expect(result.status).toBe('succeeded');
    const parsed = JSON.parse(result.content);
    expect(parsed.count).toBe(2);
    expect(parsed.todos[0].content).toBe('Step one');
    expect(store.todos).toHaveLength(2);
  });

  it('replaces the previous list on a second call', async () => {
    const store = createTodoStore();
    const tool = createTodoWriteTool(store);
    const execute = (tool as unknown as { execute: (args: unknown) => Promise<unknown> }).execute;

    await execute({ todos: [{ content: 'Old', activeForm: 'Doing old', status: 'in_progress' }] });
    await execute({ todos: [] });

    expect(store.todos).toHaveLength(0);
  });

  it('toModelOutput returns text for succeeded results', () => {
    const tool = createTodoWriteTool(createTodoStore());
    const toModelOutput = (
      tool as unknown as { toModelOutput: (output: unknown) => { type: string; value: string } }
    ).toModelOutput;

    const out = toModelOutput({ status: 'succeeded', content: '{"todos":[]}' });
    expect(out.type).toBe('text');
    expect(out.value).toBe('{"todos":[]}');
  });

  it('toModelOutput returns error-text for error results', () => {
    const tool = createTodoWriteTool(createTodoStore());
    const toModelOutput = (
      tool as unknown as { toModelOutput: (output: unknown) => { type: string; value: string } }
    ).toModelOutput;

    const out = toModelOutput({ status: 'error', content: 'something went wrong' });
    expect(out.type).toBe('error-text');
    expect(out.value).toBe('something went wrong');
  });
});
