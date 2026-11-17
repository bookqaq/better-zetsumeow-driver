import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UnsupportedError, ValidationError } from '@bookqaq/zmeow-sdk';
import { wootingImportErrorKind } from '../../src/sdk.ts';
import { WootingProfileVersionError } from '../../src/wooting/index.ts';

test('wootingImportErrorKind distinguishes newer schemas from unknown models', () => {
  assert.equal(
    wootingImportErrorKind(new WootingProfileVersionError('schema too new')),
    'schema',
  );
  assert.equal(wootingImportErrorKind(new UnsupportedError('device 3')), 'model');
  assert.equal(wootingImportErrorKind(new ValidationError('invalid code')), 'code');
});
