import { context, isSpanContextValid, trace } from '@opentelemetry/api';
import pino from 'pino';
import { serviceName, serviceVersion } from './resource.js';

// Keep every enumerable property of the error so SDK errors (status code,
// url, response body, ...) stay fully inspectable in the logs.
function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  return {
    ...err,
    type: err.name,
    message: err.message,
    stack: err.stack,
    cause: err.cause instanceof Error ? serializeError(err.cause) : err.cause,
  };
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
