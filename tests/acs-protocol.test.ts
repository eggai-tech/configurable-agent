import { describe, expect, it } from 'vitest';
import vectors from '../docs/acs-signing-vectors.json' with { type: 'json' };
import {
  applyModifications,
  deriveKey,
  type RequestEnvelope,
  type ResponseEnvelope,
  signEnvelope,
  verifyEnvelope,
} from '../src/acs/protocol.js';

describe('ACS signing interoperability', () => {
  const key = deriveKey(vectors.secret, vectors.sessionId);
  it('matches independent HKDF and envelope HMAC test vectors', () => {
    expect(key.toString('hex')).toBe(vectors.derivedKeyHex);
    for (const vector of vectors.vectors) {
      expect(
        signEnvelope(vector.envelope as RequestEnvelope | ResponseEnvelope, key, vectors.keyId),
      ).toEqual(vector.signature);
    }
  });
  it('binds every envelope field and uses a session-specific key', () => {
    const vector = vectors.vectors[1];
    if (!vector) throw new Error('missing vector');
    const response = structuredClone(vector.envelope) as ResponseEnvelope;
    response.result.signature = vector.signature;
    expect(verifyEnvelope(response, key, vectors.keyId)).toBe(true);
    expect(
      verifyEnvelope(response, deriveKey(vectors.secret, 'different-session'), vectors.keyId),
    ).toBe(false);
    response.id = 'different-id';
    expect(verifyEnvelope(response, key, vectors.keyId)).toBe(false);
  });
  it('rejects non-JCS Unicode and overlapping parent/child redactions', () => {
    const vector = vectors.vectors[0];
    if (!vector) throw new Error('missing vector');
    expect(() =>
      signEnvelope({ ...vector.envelope, id: '\ud800' } as RequestEnvelope, key, vectors.keyId),
    ).toThrow();
    expect(() =>
      applyModifications(
        { a: { b: 'value' } },
        { redactions: [{ path: '/a' }, { path: '/a/b' }] },
        'steps/agentResponse',
      ),
    ).toThrow();
  });
});
