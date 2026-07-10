import { OpenTelemetry } from '@ai-sdk/otel';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { registerTelemetry } from 'ai';
import { VERSION } from '../version.js';
import { logger } from './logger.js';

let sdk: NodeSDK | undefined;

/**
 * Start OpenTelemetry tracing when an OTLP endpoint (or an explicit opt-in) is
 * configured. Registers the AI SDK OpenTelemetry integration so that the
 * `telemetry`-annotated model calls in the agent loop emit spans; without this
 * registration AI SDK v7 produces no telemetry.
 */
export function startTracing(): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_ENABLED) {
    return;
  }

  const resource = defaultResource().merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'configurable-agent',
      [ATTR_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION ?? VERSION,
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
