import type { SSEStreamingApi } from 'hono/streaming';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/loop.js';
import { writeAgentEvent } from '../src/api/sse.js';

type WriteArg = { event?: string; data: string; id?: string };

function fakeStream(): { stream: SSEStreamingApi; writes: WriteArg[] } {
  const writes: WriteArg[] = [];
  const stream = {
    async writeSSE(msg: WriteArg) {
      writes.push(msg);
    },
  } as unknown as SSEStreamingApi;
  return { stream, writes };
}

describe('writeAgentEvent', () => {
  it('encodes the event type as the SSE event name', async () => {
    const { stream, writes } = fakeStream();
    const event: AgentEvent = { type: 'content_delta', text: 'hello' };
    await writeAgentEvent(stream, event);
    expect(writes).toEqual([{ event: 'content_delta', data: JSON.stringify({ text: 'hello' }) }]);
  });

  it('serializes tool_call with id/name/args', async () => {
    const { stream, writes } = fakeStream();
    await writeAgentEvent(stream, {
      type: 'tool_call',
      id: 'c1',
      name: 'bash',
      args: { command: 'ls' },
    });
    expect(writes[0]?.event).toBe('tool_call');
    expect(JSON.parse(writes[0]?.data ?? '{}')).toEqual({
      id: 'c1',
      name: 'bash',
      args: { command: 'ls' },
    });
  });

  it('serializes final with structured payload when present', async () => {
    const { stream, writes } = fakeStream();
    await writeAgentEvent(stream, {
      type: 'final',
      content: 'done',
      structured: { answer: 42 },
      stopReason: 'stop',
      steps: 3,
      truncated: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(writes[0]?.event).toBe('final');
    expect(JSON.parse(writes[0]?.data ?? '{}')).toEqual({
      content: 'done',
      structured: { answer: 42 },
      stopReason: 'stop',
      steps: 3,
      truncated: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});
