import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionStudy } from '../src/domain/study.ts';

test('study lifecycle keeps publication and retirement separate', () => {
  assert.equal(canTransitionStudy('draft', 'publishing'), true);
  assert.equal(canTransitionStudy('publishing', 'ready'), true);
  assert.equal(canTransitionStudy('ready', 'retiring'), true);
  assert.equal(canTransitionStudy('retiring', 'retired'), true);
  assert.equal(canTransitionStudy('retired', 'draft'), false);
  assert.equal(canTransitionStudy('ready', 'draft'), false);
});
