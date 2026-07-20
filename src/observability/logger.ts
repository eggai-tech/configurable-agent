import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';
import { serviceName, serviceVersion } from './resource.js';

// Errors are logged through a whitelist serializer: SDK errors such as
// APICallError carry the full request body (prompts, system prompt) as
// enumerable properties, which pino's default serializer would leak into logs.
function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  const out: Record<string, unknown> = {
    type: err.name,
    message: err.message,
    stack: err.stack,
  };
  if ('statusCode' in err && typeof err.statusCode === 'number') {
    out.statusCode = err.statusCode;
  }
  if (err.cause instanceof Error) {
    out.cause = { type: err.cause.name, message: err.cause.message };
  }
  return out;
}

// Logs go to stderr (fd 2): the CLI `run` mode reserves stdout for its single
// machine-readable JSON record. JSON lines carry OTel correlation fields
// (trace_id/span_id/trace_flags of the active span) and the same
// service.name/service.version as the trace resource, so any log line can be
// joined with its trace in the backend.
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { 'service.name': serviceName(), 'service.version': serviceVersion() },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: { err: serializeError },
    mixin() {
      const spanContext = trace.getSpan(context.active())?.spanContext();
      if (!spanContext || !isSpanContextValid(spanContext)) return {};
      return {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: `0${spanContext.traceFlags.toString(16)}`,
      };
    },
  },
  pino.destination(2),
);
