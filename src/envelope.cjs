'use strict';

// ATTRIBUT — envelope assembly + validation.
//
// Wraps a parsed `payload` in the FROZEN envelope shape (the vendored
// src/contract/envelope.schema.json) and validates it against that schema BEFORE
// it is ever sent. Validation failing is a loud error, not a silent drop: a
// payload that does not validate is a contract bug we want surfaced.

const fs = require('fs');
const path = require('path');
// The contract schema declares JSON Schema draft 2020-12, so we use Ajv's
// 2020 dialect entry point (the default Ajv export is draft-07 and rejects it).
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

// Vendored copy of the frozen contract schema. It lives INSIDE the package so a
// global install / npm pack has no dependency on a sibling repo at runtime. The
// upstream source of truth is ingest/contract/envelope.schema.json — re-copy it
// here on release if the contract changes (keep maxLength bounds in sync).
const SCHEMA_PATH = path.resolve(__dirname, 'contract', 'envelope.schema.json');

// Compile the schema once. `allErrors` is off: this validator runs on the hot
// path and we only need the first failure to surface a contract bug, not an
// exhaustive list (which is slower).
let _validate = null;
function getValidator() {
  if (_validate) return _validate;
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  _validate = ajv.compile(schema);
  return _validate;
}

// Build the full envelope around a parsed `payload`. The provider/tool pair
// identifies the source agent — it defaults to anthropic/claude_code but the
// caller overrides via meta._provider/meta._tool (e.g. google/antigravity).
// schema_version is fixed; transport metadata (_trigger/_source/_isCloud) comes
// from the hook context.
function buildEnvelope(payload, meta = {}) {
  const envelope = {
    provider: meta._provider != null ? meta._provider : 'anthropic',
    tool: meta._tool != null ? meta._tool : 'claude_code',
    schema_version: 1,
    payload,
  };
  if (meta._trigger != null) envelope._trigger = meta._trigger;
  if (meta._source != null) envelope._source = meta._source;
  if (meta._isCloud != null) envelope._isCloud = meta._isCloud;
  if (meta._cli_version != null) envelope._cli_version = meta._cli_version;
  return envelope;
}

// Validate an envelope against the frozen schema. Returns { valid, errors }.
function validateEnvelope(envelope) {
  const validate = getValidator();
  const valid = validate(envelope);
  return { valid, errors: valid ? null : validate.errors };
}

// Build + validate in one call. THROWS (loud) if the envelope does not satisfy
// the contract — never returns an invalid envelope for sending.
function buildAndValidate(payload, meta = {}) {
  const envelope = buildEnvelope(payload, meta);
  const { valid, errors } = validateEnvelope(envelope);
  if (!valid) {
    throw new Error(
      `Envelope failed contract validation: ${JSON.stringify(errors, null, 2)}`
    );
  }
  return envelope;
}

module.exports = {
  SCHEMA_PATH,
  getValidator,
  buildEnvelope,
  validateEnvelope,
  buildAndValidate,
};
