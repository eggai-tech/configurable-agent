import { VERSION } from '../version.js';

// Single source for the service identity so logs and traces can never diverge.
export function serviceName(): string {
  return process.env.OTEL_SERVICE_NAME ?? 'configurable-agent';
}

export function serviceVersion(): string {
  return process.env.OTEL_SERVICE_VERSION ?? VERSION;
}
