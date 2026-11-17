import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { shutdownTracing, startTracing } from '../src/observability/tracing.js';

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
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    // Without this the next startTracing() cannot replace the global tracer provider.
    trace.disable();
  });

  it('speaks gRPC when OTEL_EXPORTER_OTLP_PROTOCOL=grpc', async () => {
    const calls: string[] = [];
    const server = http2.createServer();
    server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
      calls.push(`${headers[':path']} ${headers['content-type']}`);
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
    expect(calls).toContain(
      '/opentelemetry.proto.collector.trace.v1.TraceService/Export application/grpc',
    );
  });

  it('defaults to OTLP http/protobuf', async () => {
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      calls.push(`${req.url} ${req.headers['content-type']}`);
      req.resume();
      req.on('end', () => res.writeHead(200).end());
    });
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = await listen(server);

    await exportOneSpan();
    server.close();

    expect(calls).toContain('/v1/traces application/x-protobuf');
  });
});
