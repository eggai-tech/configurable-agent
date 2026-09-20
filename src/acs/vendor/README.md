# ACS v0.1 schema snapshot

Source: https://github.com/GenAI-Security-Project/agent-control-standard/tree/bfdb898be4a9bcaedd90529b480ae5b62e94f29a/specification/v0.1.0

`schemas.json` bundles the implemented hook schemas and their dependencies. Titles, descriptions, comments and examples are removed; literal newlines in upstream JSON description strings were normalized during parsing. Validation keywords are preserved. Apache-2.0 license is included.

The client applies two explicit restrictions/adaptations in code:

- Invalid modifications become an effective denial, including modification shapes that fail the upstream schema.
- `postCompact.post_compact_chain_hash` is supplied by the Guardian in its signed response, not by the client in its request. The published request schema asks the client for a hash of a future Guardian entry. The client omits that single required field and records the returned chain head. Guardians integrating with this client must accept this convention.

No ACS conformance profile is advertised.
