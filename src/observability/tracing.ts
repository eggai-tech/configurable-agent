import { OpenTelemetry } from '@ai-sdk/otel';
import type { SpanContext } from '@opentelemetry/api';
import { TraceFlags } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { registerTelemetry, type TelemetryOptions } from 'ai';
import { logger } from './logger.js';
import { serviceName, serviceVersion } from './resource.js';

let sdk: NodeSDK | undefined;

function isFalsy(value: string | undefined): boolean {
  return value === undefined || value === '' || value === '0' || value === 'false';
}

/**
 * Start OpenTelemetry tracing when an OTLP endpoint (or OTEL_ENABLED) is
 * configured. Registers the AI SDK OpenTelemetry integration; without this
 * registration AI SDK v7 produces no telemetry.
 */
export function startTracing(): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && isFalsy(process.env.OTEL_ENABLED)) {
    return;
  }

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName(),
      [ATTR_SERVICE_VERSION]: serviceVersion(),
    }),
  );

  sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  registerTelemetry(new OpenTelemetry());
  logger.debug('tracing started');
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
  logger.debug('tracing shut down');
}

/**
 * Telemetry options for AI SDK calls. Prompt/tool content is recorded on spans
 * by default (eval tooling reads tool-call details from traces, spec 004);
 * operators handling sensitive data opt out with OTEL_RECORD_CONTENT=0, which
 * keeps metadata spans (model, usage, latency) but strips inputs/outputs.
 */
export function telemetryOptions(functionId: string): TelemetryOptions {
  const recordContent = !['0', 'false'].includes(process.env.OTEL_RECORD_CONTENT ?? '');
  return { functionId, recordInputs: recordContent, recordOutputs: recordContent };
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parse a W3C `traceparent` value into a remote SpanContext, or null. */
export function parseTraceparent(raw: string | undefined): SpanContext | null {
  if (!raw) return null;
  const m = TRACEPARENT_RE.exec(raw.trim());
  if (!m) return null;
  const [, traceId, spanId, flagsHex] = m;
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
