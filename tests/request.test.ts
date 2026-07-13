import { describe, expect, it } from 'vitest';
import { parseInvokeRequest } from '../src/api/request.js';

describe('parseInvokeRequest', () => {
  it('rejects a body without messages', () => {
    const result = parseInvokeRequest({});
    expect(result.success).toBe(false);
  });

  it('rejects an empty messages array', () => {
    const result = parseInvokeRequest({ messages: [] });
    expect(result.success).toBe(false);
  });

  it('rejects messages with an unknown role', () => {
    const result = parseInvokeRequest({ messages: [{ role: 'robot', content: 'hi' }] });
    expect(result.success).toBe(false);
  });

  it('accepts a plain user message', () => {
    const result = parseInvokeRequest({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.success).toBe(true);
  });

  it('preserves the tool-approval-request signature the SDK schema would strip', () => {
    // A signed approval round-trip: the client re-POSTs the assistant message
    // containing the approval request WITH its HMAC signature. zod parsing
    // via modelMessageSchema drops unknown fields (signature is not in the
    // runtime schema), which would make the SDK reject the resume as
    // "missing signature" — so the boundary must return the ORIGINAL messages.
    const messages = [
      { role: 'user', content: 'delete the record' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'delete_record', input: { id: 7 } },
          { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'c1', signature: 'hmac' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'a1', approved: true }],
      },
    ];

    const result = parseInvokeRequest({ messages });
    if (!result.success) throw new Error('expected the approval round-trip to validate');
    expect(result.messages).toBe(messages);
    const assistant = result.messages[1];
    if (!Array.isArray(assistant?.content)) throw new Error('expected part array');
    expect(assistant.content[1]).toMatchObject({ signature: 'hmac' });
  });
});
