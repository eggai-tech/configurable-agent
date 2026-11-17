import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { shutdownTracing, startTracing } from '../src/observability/tracing.js';

const OTEL_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_TRACES_EXPORTER',
] as const;

function listen(server: http.Server | http2.Http2Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

/** Start tracing, export one span, and flush by shutting down. */
async function exportOneSpan(): Promise<void> {
  startTracing();
  trace.getTracer('test').startSpan('probe').end();
  await shutdownTracing();
}

describe('startTracing exporter selection', () => {
  afterEach(async () => {
    await shutdownTracing();
    for (const name of OTEL_VARS) delete process.env[name];
    // NodeSDK registers globals that a later start in this file cannot replace.
    trace.disable();
  });

  it('speaks gRPC when OTEL_EXPORTER_OTLP_PROTOCOL=grpc', async () => {
    const calls: Array<{ path: unknown; contentType: unknown }> = [];
    const server = http2.createServer();
    server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
      calls.push({ path: headers[':path'], contentType: headers['content-type'] });
      stream.resume();
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      // An empty ExportTraceServiceResponse: uncompressed, zero-length message.
      stream.end(Buffer.alloc(5));
    });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = await listen(server);
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc';

    await exportOneSpan();
    server.close();

    // Metrics may be exported to the same endpoint; only the trace call matters here.
    expect(calls).toContainEqual({
      path: '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
      contentType: 'application/grpc',
    });
  });

  it('defaults to OTLP http/protobuf', async () => {
    const calls: Array<{ url: unknown; contentType: unknown }> = [];
    const server = http.createServer((req, res) => {
      calls.push({ url: req.url, contentType: req.headers['content-type'] });
      req.resume();
      req.on('end', () => res.writeHead(200).end());
    });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = await listen(server);

    await exportOneSpan();
    server.close();

    expect(calls).toContainEqual({ url: '/v1/traces', contentType: 'application/x-protobuf' });
  });
});
