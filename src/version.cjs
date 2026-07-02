'use strict';
// Build-time git SHA, overwritten by .github/workflows/publish.yml before `npm publish`.
// Stays 'dev' for local/unpublished runs.
module.exports = { GIT_SHA: 'dev' };
