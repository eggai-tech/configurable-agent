import { type ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { tool } from 'ai';
import { z } from 'zod';
import type { AgentEmitter } from '../events.js';
import type { ToolSummaryRuntime } from '../safety/tool-summary.js';
import { type BashPolicyConfig, classify } from './bash-policy.js';
import { type PartialToolResult, type ToolResult, intentField, wrapToolExecute } from './result.js';

export interface BashToolConfig {
  timeoutMs: number;
  maxBufferBytes: number;
  policy: BashPolicyConfig & {
    approvalEnabled: boolean;
  };
}

interface BashArgs {
  command: string;
}

export function createBashTool(cfg: BashToolConfig, ctx: ToolSummaryRuntime) {
  return tool({
    description:
      'Run a shell command inside the agent container using /bin/sh -c. ' +
      'Returns merged stdout+stderr output and the exit code. Commands are killed after the configured timeout. ' +
      'Some commands may require human approval before executing.',
    inputSchema: z.object({
      command: z.string().min(1).describe('The shell command to execute'),
      ...intentField,
    }),
    execute: async (args, { abortSignal, toolCallId }) =>
      wrapToolExecute<BashArgs>(
        {
          toolName: 'bash',
          labeler: (a) => a.command,
          handler: async (a, opts) => {
            const gate = await gateCommand(a.command, cfg, ctx, opts.toolCallId);
            if (gate) return gate;
            return runBashStreaming(a.command, cfg, ctx.emit, opts.toolCallId, opts.abortSignal);
          },
          ctx,
        },
        args,
        { toolCallId, abortSignal },
      ),
  });
}

export async function gateCommand(
  command: string,
  cfg: BashToolConfig,
  ctx: ToolSummaryRuntime,
  toolCallId: string,
): Promise<PartialToolResult | null> {
  const verdict = classify(command, cfg.policy, ctx.sessionAllowRules);

  if (verdict.decision === 'allow') return null;

  if (verdict.decision === 'deny') {
    return {
      status: 'denied',
      denied_reason: verdict.reason === 'compound command' ? 'policy_compound' : 'policy_deny',
      content: `Blocked by policy: ${verdict.reason}`,
      return_code: null,
    };
  }

  const prior = ctx.approvals.get(toolCallId);
  if (prior) {
    if (prior.decision === 'deny') {
      return {
        status: 'denied',
        denied_reason: 'user_denied',
        content: 'A human reviewer denied this command.',
        return_code: null,
      };
    }
    if (prior.decision === 'allow_session' && prior.rule) {
      ctx.sessionAllowRules.add(prior.rule);
    }
    return null;
  }

  if (!cfg.policy.approvalEnabled) {
    return {
      status: 'denied',
      denied_reason: 'policy_deny',
      content:
        'This command requires human approval but approval is disabled for this deployment. ' +
        'Use a read-only alternative or a more specific command.',
      return_code: null,
    };
  }

  ctx.pendingApprovals.add(toolCallId);
  await ctx.emit({
    type: 'tool_approval_requested',
    id: toolCallId,
    tool: 'bash',
    command,
    reason: verdict.reason,
    policy: 'ask',
    suggestedRules: verdict.suggestedRules,
  });

  return {
    status: 'approval_required',
    content: 'Awaiting human approval. The client must re-invoke with an approval decision.',
    return_code: null,
  };
}

export async function runBashStreaming(
  command: string,
  cfg: BashToolConfig,
  emit: AgentEmitter,
  toolCallId: string,
  abortSignal: AbortSignal | undefined,
): Promise<PartialToolResult> {
  return new Promise<PartialToolResult>((resolve) => {
    const child: ChildProcess = spawn('/bin/sh', ['-c', command], {
      signal: abortSignal,
    });

    let outputBuf = '';
    let totalBytes = 0;
    let truncated = false;
    let timedOut = false;
    let seq = 0;
    let chunkQueue = Promise.resolve();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, cfg.timeoutMs);

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const appendChunk = async (text: string) => {
      if (text.length === 0) return;
      totalBytes += Buffer.byteLength(text, 'utf8');
      const remaining = cfg.maxBufferBytes - Buffer.byteLength(outputBuf, 'utf8');
      if (remaining > 0) {
        if (Buffer.byteLength(text, 'utf8') <= remaining) {
          outputBuf += text;
        } else {
          outputBuf += truncateUtf8ByBytes(text, remaining);
          truncated = true;
        }
      } else {
        truncated = true;
      }
      await emit({
        type: 'tool_output_chunk',
        id: toolCallId,
        text,
        seq: seq++,
      });
    };

    const enqueueChunk = (text: string) => {
      chunkQueue = chunkQueue.then(() => appendChunk(text)).catch(() => undefined);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      enqueueChunk(stdoutDecoder.write(chunk));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      enqueueChunk(stderrDecoder.write(chunk));
    });

    child.on('error', () => {
      // handled via 'close'
    });

    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      enqueueChunk(stdoutDecoder.end() + stderrDecoder.end());
      await chunkQueue;
      const exitCode = typeof code === 'number' ? code : signal === 'SIGTERM' && timedOut ? 124 : 1;
      await emit({
        type: 'tool_stream_end',
        id: toolCallId,
        exitCode,
        timedOut,
        totalBytes,
        truncated,
      });
      resolve({
        status: 'succeeded',
        content: outputBuf,
        return_code: exitCode,
        ...(truncated ? { truncated: true } : {}),
      });
    });

    if (abortSignal) {
      abortSignal.addEventListener(
        'abort',
        () => {
          child.kill('SIGTERM');
        },
        { once: true },
      );
    }
  });
}

export type { ToolResult };

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}
