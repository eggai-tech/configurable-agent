import type { SSEStreamingApi } from 'hono/streaming';
import type { AgentEvent } from '../agent/events.js';

export async function writeAgentEvent(stream: SSEStreamingApi, event: AgentEvent): Promise<void> {
  const { type, ...data } = event;
  await stream.writeSSE({
    event: type,
    data: JSON.stringify(data),
  });
}
