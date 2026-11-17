import assert from 'node:assert/strict';
import { test } from 'node:test';

import { layoutOverlapInfo } from '../../src/config/layout.ts';

test('layoutOverlapInfo: extended79 onto compact65 shares 65 keys and skips 14', () => {
  assert.deepEqual(layoutOverlapInfo('extended79', 'compact65'), {
    sourceLayout: 'extended79',
    targetLayout: 'compact65',
    sharedKeys: 65,
    skippedKeys: 14,
  });
});

test('layoutOverlapInfo: compact65 onto extended79 is a strict subset', () => {
  assert.deepEqual(layoutOverlapInfo('compact65', 'extended79'), {
    sourceLayout: 'compact65',
    targetLayout: 'extended79',
    sharedKeys: 65,
    skippedKeys: 0,
  });
});
