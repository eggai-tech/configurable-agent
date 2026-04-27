import type { SpanContext } from '@opentelemetry/api';
import { TraceFlags } from '@opentelemetry/api';

export async function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(raw: string | undefined): SpanContext | null {
  if (!raw) return null;
  const m = TRACEPARENT_RE.exec(raw.trim());
  if (!m) return null;
  const traceId = m[1];
  const spanId = m[2];
  const flagsHex = m[3];
  if (!traceId || !spanId || !flagsHex) return null;
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;
  return {
    traceId,
    spanId,
    traceFlags:
      Number.parseInt(flagsHex, 16) & TraceFlags.SAMPLED ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: true,
  };
}

export interface RunRecord {
  ok: boolean;
  finalText: string;
  error: string | null;
}

export function writeRunRecord(stream: NodeJS.WritableStream, record: RunRecord): void {
  stream.write(`${JSON.stringify(record)}\n`);
}
