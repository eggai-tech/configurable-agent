import { describe, expect, it } from 'vitest';
import { type ApprovalConfig, toolNeedsApproval } from '../src/agent/approval.js';

const cfg = (mode: ApprovalConfig['mode'], tools: string[] = []): ApprovalConfig => ({
  mode,
  tools,
});

describe('toolNeedsApproval', () => {
  it('mode "none" never requires approval, even with patterns present', () => {
    expect(toolNeedsApproval('delete_file', cfg('none', ['*']))).toBe(false);
  });

  it('mode "all" requires approval for every tool except internal exemptions', () => {
    expect(toolNeedsApproval('delete_file', cfg('all'))).toBe(true);
    expect(toolNeedsApproval('anything', cfg('all'))).toBe(true);
    // todowrite is an internal, side-effect-free tool and is always exempt.
    expect(toolNeedsApproval('todowrite', cfg('all'))).toBe(false);
  });

  it('mode "selected" matches glob patterns', () => {
    expect(toolNeedsApproval('delete_file', cfg('selected', ['delete_*']))).toBe(true);
    expect(toolNeedsApproval('delete_dir', cfg('selected', ['delete_*']))).toBe(true);
    expect(toolNeedsApproval('read_file', cfg('selected', ['delete_*']))).toBe(false);
    expect(toolNeedsApproval('send_email', cfg('selected', ['send_email', 'delete_*']))).toBe(true);
  });

  it('mode "selected" with "*" matches all but keeps internal exemptions', () => {
    expect(toolNeedsApproval('anything', cfg('selected', ['*']))).toBe(true);
    expect(toolNeedsApproval('todowrite', cfg('selected', ['*']))).toBe(false);
  });

  it('treats "." in a pattern literally, not as a regex wildcard', () => {
    expect(toolNeedsApproval('a.b', cfg('selected', ['a.b']))).toBe(true);
    expect(toolNeedsApproval('axb', cfg('selected', ['a.b']))).toBe(false);
  });
});
