import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The Historical Maps instructions told the model both that "no historical geometry provider is
// integrated" and, a section later, to query OpenHistoricalMap for dated divisions. The manifest
// grants that provider, so the first statement is the false one.
test('the historical-maps instructions do not deny the provider the capability grants', () => {
  const capability = JSON.parse(fs.readFileSync(new URL('../capabilities/cartography/capability.json', import.meta.url), 'utf8'));
  const instructions = fs.readFileSync(new URL('../skills/historical-maps/SKILL.md', import.meta.url), 'utf8');
  assert.ok(capability.permissions.maps.providers.includes('openhistoricalmap'));
  assert.match(instructions, /openhistoricalmap/);
  assert.doesNotMatch(instructions, /no historical geometry provider/i);
});
