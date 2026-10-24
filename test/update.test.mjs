import assert from 'node:assert/strict';
import test from 'node:test';
import { isNewerVersion } from '../update.mjs';

test('update comparison accepts only newer three-part releases', () => {
  assert.equal(isNewerVersion('v1.4.1', '1.4.0'), true);
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
  assert.equal(isNewerVersion('v1.4.0', '1.4.0'), false);
  assert.equal(isNewerVersion('1.3.9', '1.4.0'), false);
  assert.equal(isNewerVersion('latest', '1.4.0'), false);
});
