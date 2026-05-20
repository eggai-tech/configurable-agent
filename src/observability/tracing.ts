import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export function startTracing(): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && !process.env.OTEL_ENABLED) {
    return;
  }
  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]:
        process.env.OTEL_SERVICE_NAME ?? 'configurable-agent',
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          requireParentforIncomingSpans: true,
        },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}
