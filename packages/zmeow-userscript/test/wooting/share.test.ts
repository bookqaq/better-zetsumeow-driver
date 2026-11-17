import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  WOOTING_SHARE_ENDPOINT,
  convertWootingProfile,
  fetchWootingShare,
  parseWootingShare,
  summarizeWootingProfile,
} from '../../src/wooting/index.ts';
import { TransportError, ValidationError } from '@bookqaq/zmeow-sdk';

const ASSETS = new URL('../../../../assets/wooting-share/', import.meta.url);
const SHARE_CODE = 'a05d1869a2a5b2bc5983a492c87181622eb9';

function shareBody(): string {
  return readFileSync(new URL('wootility_profile_share_a05d1869a2a5b2bc5983a492c87181622eb9.txt', ASSETS), 'utf8');
}

function readProfile(name: string): string {
  return readFileSync(new URL(name, ASSETS), 'utf8');
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

test('fetchWootingShare requests the official endpoint and parses the profile', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const stub: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse(shareBody());
  };

  const profile = await fetchWootingShare(SHARE_CODE, { fetch: stub });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${WOOTING_SHARE_ENDPOINT}?code=${SHARE_CODE}`);
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('origin'), 'https://wootility.io');

  const summary = summarizeWootingProfile(profile);
  assert.equal(summary.model, '60he');
  assert.equal(summary.modelTitle, 'Wooting 60HE (ARM)');
  assert.equal(summary.targetDevice, 5);
  assert.equal(summary.name, 'zekken');
  assert.equal(summary.guid, SHARE_CODE);
  assert.equal(summary.version, 12);
});

test('fetched zekken profile converts onto compact65 and skips the (1,0) cell', async () => {
  const stub: typeof fetch = async () => jsonResponse(shareBody());
  const profile = await fetchWootingShare(SHARE_CODE, { fetch: stub });

  const compact = convertWootingProfile(profile);
  assert.equal(compact.layout, 'compact65');
  assert.deepEqual(compact.stats, {
    remapKeys: 57,
    colorKeys: 58,
    travelKeys: 58,
    featureKeys: 0,
    skippedCells: 5,
    unknownKeycodes: 0,
  });
  // The (1,0) cell is Escape: compact65 has no Escape (and no hardCode 0 at
  // all), so the cell is skipped and must not surface as a Backquote remap on
  // hardCode 13.
  assert.equal(compact.remap[0]![0], undefined);
  assert.equal(compact.remap[0]![13], undefined);

  // v12 share profiles encode analog values in millimetres and custom
  // actuations in 0.1 mm steps.
  assert.equal(compact.travel[14]!.pressMm, 0.1); // Digit1, customActuations value 1
  assert.equal(compact.travel[29]!.pressMm, 0.1); // W, global actPoint
  assert.equal(compact.travel[29]!.releaseMm, 0.15); // Wooting RT sensitivity
  assert.equal(compact.travel[29]!.fast, true);
  assert.equal(compact.travel[29]!.fastOutMm, 0.1);
  assert.equal(compact.travel[29]!.deadDownMm, 0);
  assert.equal(compact.travel[29]!.deadUpMm, 0);
  assert.ok(!compact.warnings.some((line) => line.includes('below 0.1mm')));
  assert.ok(!compact.warnings.some((line) => line.includes('0.00mm')));
});

test('v14 profile parses fractional custom actuations and boolean per-key RT', () => {
  const profile = parseWootingShare(readProfile('wootility_profile_share_b927255f8e15e3cee2216398ecd100f283a1.txt'));
  assert.equal(profile.version, 14);
  const plan = convertWootingProfile(profile);

  // v14 stores custom actuations in millimetres: 1 is 1.0 mm, 0.7 is 0.7 mm.
  assert.equal(plan.travel[17]!.pressMm, 1); // Digit4, custom 1
  assert.equal(plan.travel[56]!.pressMm, 2); // X, custom 2
  assert.equal(plan.travel[29]!.pressMm, 0.7); // W, custom 0.7

  // The global RT switch is off, but boolean per-key RT entries are on.
  assert.equal(plan.travel[29]!.fast, true);
  assert.equal(plan.travel[29]!.releaseMm, 0.15);
  assert.equal(plan.travel[29]!.fastOutMm, 0);
  assert.equal(plan.travel[40]!.fast, true); // Backslash, per-key RT true
  assert.equal(plan.travel[14]!.fast, false); // Digit1, no per-key RT
  assert.ok(plan.warnings.some((line) => line.includes('per-layer RGB')));
  assert.ok(plan.warnings.some((line) => line.includes('digital mode')));
  assert.ok(plan.warnings.some((line) => line.includes('Tachyon mode')));
});

test('v15 profile imports SOCD and mod-tap advanced keys', () => {
  const plan = convertWootingProfile(readProfile('wootility_profile_share_e883d4a46db97c6d467eb13ea5297199e1bc.txt'));
  assert.equal(plan.stats.featureKeys, 4);

  const socd = plan.features.filter((feature) => feature.kind === 'socd');
  assert.deepEqual(
    socd.map((feature) => feature.hardCode),
    [42, 29], // A, W
  );
  assert.deepEqual(socd[0]!.targetHardCodes, [44]); // D
  assert.equal(socd[0]!.first1, 1);
  assert.equal(socd[0]!.first2, 1); // last input priority
  assert.equal(socd[0]!.bottom, false);
  assert.deepEqual(socd[1]!.targetHardCodes, [43]); // S

  // Custom actuation 993/4096 = 0.24; RT primary (press) 7695/4096 = 1.88,
  // secondary (release) 993/4096 = 0.24.
  assert.equal(plan.travel[29]!.pressMm, 0.24);
  assert.equal(plan.travel[29]!.releaseMm, 0.24);
  assert.equal(plan.travel[29]!.travelDownMm, 1.88);
  assert.equal(plan.travel[29]!.travelUpMm, 0.24);
  assert.equal(plan.travel[29]!.fastOutMm, 0.24);

  const modTap = plan.features.filter((feature) => feature.kind === 'mt');
  assert.equal(modTap.length, 2);
  assert.deepEqual(modTap[0]!.targetHidCodes, [229, 82]); // hold RightCtrl, tap Up
  assert.ok(!plan.warnings.some((line) => line.includes('AKC settings')));
  assert.equal(plan.warnings.filter((line) => line.includes('not present')).length, 2);
});

test('legacy AKC shapes convert SOCD/RS/MT/TGL and skip DKS/layers', () => {
  const plan = convertWootingProfile({
    version: 12,
    target: { device: 11 },
    analog: { actPoint: 0.7, rapidTrigger: true, rapidTriggerSensitivity: 0.15 },
    akc: [
      {
        keyIndex: { rowNr: 3, colNr: 1 },
        layer: 0,
        socd: {
          secondaryKey: { rowNr: 3, colNr: 3 },
          socd: 4,
          inputBothOnBottomOut: true,
        },
      },
      {
        keyIndex: { rowNr: 2, colNr: 2 },
        layer: 0,
        rappySnappy: {
          secondaryKey: { rowNr: 3, colNr: 2 },
          socd: 0,
          inputBothOnBottomOut: true,
        },
      },
      {
        keyIndex: { rowNr: 3, colNr: 2 },
        layer: 0,
        modTap: { tapKey: 4, holdKey: 5 },
      },
      {
        keyIndex: { rowNr: 3, colNr: 3 },
        layer: 0,
        toggleKey: { keybind: 6 },
      },
      { keyIndex: { rowNr: 3, colNr: 4 }, layer: 0, dks: { action0: null } },
      {
        keyIndex: { rowNr: 3, colNr: 5 },
        layer: 1,
        socd: { secondaryKey: { rowNr: 3, colNr: 6 }, socd: 1 },
      },
    ],
  });
  assert.deepEqual(
    plan.features.map((feature) => feature.kind),
    ['socd', 'rs', 'mt', 'tgl'],
  );
  assert.equal(plan.features[0]!.bottom, true);
  assert.equal(plan.features[1]!.bottom, true);
  assert.deepEqual(plan.features[2]!.targetHidCodes, [8, 7]); // hold, tap
  assert.deepEqual(plan.features[3]!.targetHidCodes, [9]);
  assert.ok(plan.warnings.some((line) => line.includes('DKS')));
  assert.ok(plan.warnings.some((line) => line.includes('layer 1')));
});

test('fetchWootingShare maps HTTP 404 to ValidationError with the server message', async () => {
  const stub: typeof fetch = async () =>
    jsonResponse('{"error":"Profile not found with id 0000"}', 404);
  await assert.rejects(
    () => fetchWootingShare('0000', { fetch: stub }),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.message.includes('HTTP 404') &&
      error.message.includes('Profile not found'),
  );
});

test('fetchWootingShare classifies HTTP 429 as a transport/rate-limit failure', async () => {
  const stub: typeof fetch = async () => jsonResponse('{"error":"Too many requests"}', 429);
  await assert.rejects(
    () => fetchWootingShare(SHARE_CODE, { fetch: stub }),
    (error: unknown) =>
      error instanceof TransportError &&
      error.message.includes('HTTP 429') &&
      error.message.includes('Too many requests'),
  );
});

test('fetchWootingShare wraps network failures in TransportError', async () => {
  const stub: typeof fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    () => fetchWootingShare(SHARE_CODE, { fetch: stub }),
    (error: unknown) =>
      error instanceof TransportError &&
      error.message.includes('Failed to fetch the Wooting share profile') &&
      error.message.includes('Failed to fetch'),
  );
});

test('fetchWootingShare rejects an empty share code', async () => {
  await assert.rejects(() => fetchWootingShare('   '), ValidationError);
});
