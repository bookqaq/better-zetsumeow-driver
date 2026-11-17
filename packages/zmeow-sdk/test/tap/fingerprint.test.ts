import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KNOWN_DRIVER_HASHES,
  clearFingerprintCache,
  fingerprintDriverAssets,
  makeFingerprint,
  productRecordMatches,
  readProductRecord,
} from '../../src/tap/fingerprint.ts';
import { ZETSU63_PRODUCT } from '../../src/generated/product-zetsu63.ts';

function fakeDocument(): Document {
  return {
    querySelector(selector: string) {
      if (selector === 'script[type="module"][src]') {
        return { src: 'https://driver.test/assets/index-unknown.js' };
      }
      if (selector.includes('/hid-')) {
        return { href: 'https://driver.test/assets/hid-unknown.js' };
      }
      return null;
    },
  } as unknown as Document;
}

test('fingerprintDriverAssets flags unknown protocol resource hashes', async () => {
  clearFingerprintCache();
  const fetchImpl = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as typeof fetch;
  const result = await fingerprintDriverAssets(fakeDocument(), fetchImpl, globalThis.crypto);
  assert.equal(result.checked, true);
  assert.equal(result.hashKnown, false);
  assert.equal(result.indexHash?.length, 64);
  assert.equal(result.hidHash?.length, 64);
  assert.ok(result.reasons.some((reason) => reason.includes('hid protocol resource hash changed')));
  clearFingerprintCache();
});

test('readProductRecord validates the official product table shape', () => {
  const record = readProductRecord(
    {
      data: {
        keys_product_list: [
          {
            id: ZETSU63_PRODUCT.id,
            title: ZETSU63_PRODUCT.title,
            vid: ZETSU63_PRODUCT.vid,
            pid: ZETSU63_PRODUCT.pid,
            pid_screen: ZETSU63_PRODUCT.pidScreen,
            usage: ZETSU63_PRODUCT.usage,
            usagePage: ZETSU63_PRODUCT.usagePages.join(','),
            head_num: '0xab',
            head_num_screen: '0xab',
            cate_id: ZETSU63_PRODUCT.cateId,
            f_id: ZETSU63_PRODUCT.fId,
            fm_id: ZETSU63_PRODUCT.fmId,
          },
        ],
      },
    },
    ZETSU63_PRODUCT.id,
  );
  assert.ok(record);
  assert.equal(productRecordMatches(record, ZETSU63_PRODUCT), true);
});

test('makeFingerprint records an untested firmware version', () => {
  const fingerprint = makeFingerprint({
    assets: {
      indexHash: KNOWN_DRIVER_HASHES.index,
      hidHash: KNOWN_DRIVER_HASHES.hid,
      screenHash: null,
      checked: true,
      hashKnown: true,
      reasons: [],
    },
    productOk: true,
    firmwareVersion: '9.9.9',
    protocolOk: true,
  });
  assert.equal(fingerprint.checked, true);
  assert.equal(fingerprint.hashKnown, true);
  assert.ok(fingerprint.reasons.some((reason) => reason.includes('9.9.9')));
});
