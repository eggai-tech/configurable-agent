# Plan: pick the OTLP trace exporter from the environment

## Finding

`startTracing()` passed `traceExporter: new OTLPTraceExporter()` from `@opentelemetry/exporter-trace-otlp-http`. An
explicit `traceExporter` makes `NodeSDK` skip its own exporter selection, so `OTEL_EXPORTER_OTLP_PROTOCOL` was never
read and every span went out as OTLP/HTTP JSON over HTTP/1.1.

Replicated against a local HTTP/2 server with `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`: `main` fails with
`Parse Error: Expected HTTP/, RTSP/ or ICE/`, the error from the deployment. Without `traceExporter` the same setup
calls `/opentelemetry.proto.collector.trace.v1.TraceService/Export` as `application/grpc`.

## Fix

- `startTracing()`: drop `traceExporter`. `NodeSDK` then builds the exporter from the standard variables:
  `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, else `OTEL_EXPORTER_OTLP_PROTOCOL` (`grpc`, `http/protobuf`, `http/json`), and
  `OTEL_TRACES_EXPORTER` (`otlp`, `console`, `zipkin`, `none`).
- Remove the direct dependency `@opentelemetry/exporter-trace-otlp-http`. The three OTLP trace exporters are
  dependencies of `@opentelemetry/sdk-node`, and the image installs production `node_modules`, so nothing is added.
- Test: start tracing against local servers and assert the transport for `grpc` and for the default.
- User guide, `run` usage text and changelog name the variables.

## Behaviour changes

- With no protocol set, spans are sent as `http/protobuf` (the OpenTelemetry default) instead of `http/json`. The
  endpoint and path (`/v1/traces`) are the same and OTLP/HTTP receivers accept both.
- `OTEL_TRACES_EXPORTER` is now honoured; `none` exports nothing.

## Not addressed

Metrics are unchanged. `NodeSDK` already set up an OTLP metric reader from the environment (it follows
`OTEL_EXPORTER_OTLP_PROTOCOL` and `OTEL_METRICS_EXPORTER`), so auto-instrumentation metrics go to the same endpoint.
An endpoint that takes traces only needs `OTEL_METRICS_EXPORTER=none`.
