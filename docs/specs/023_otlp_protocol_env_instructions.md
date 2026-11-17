# Instructions

A deployment on Azure Container Apps exports no traces: the agent only sends them over HTTP, and the platform's
managed OpenTelemetry agent only accepts gRPC. Azure sets `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` and
`OTEL_EXPORTER_OTLP_ENDPOINT`; the agent should respect them. Investigate, then implement the fix.

The agent logs `Parse Error: Expected HTTP/, RTSP/ or ICE/` (`HPE_INVALID_CONSTANT`) with a raw packet that is an
HTTP/2 SETTINGS frame.
