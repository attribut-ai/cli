'use strict';

// _cli_version PASS-THROUGH TEST — the build-time git SHA (from src/version.cjs,
// stamped by publish.yml) is an optional top-level envelope field. It must copy
// through buildEnvelope verbatim and the resulting envelope must still satisfy
// the frozen contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildEnvelope, validateEnvelope } = require('../src/envelope.cjs');

const PAYLOAD = { sessionId: 's1' };

test('buildEnvelope copies _cli_version through verbatim', () => {
  const envelope = buildEnvelope(PAYLOAD, { _cli_version: 'abc123' });
  assert.equal(envelope._cli_version, 'abc123');
});

test('an envelope carrying _cli_version passes contract validation', () => {
  const envelope = buildEnvelope(PAYLOAD, { _cli_version: 'abc123' });
  const { valid, errors } = validateEnvelope(envelope);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('_cli_version is omitted when not supplied', () => {
  const envelope = buildEnvelope(PAYLOAD, {});
  assert.equal('_cli_version' in envelope, false);
});
