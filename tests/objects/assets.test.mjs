import test from 'node:test';
import assert from 'node:assert/strict';
import { assetBytes } from '../../worker/objects/service.ts';

// Regression: production served /image with a 200, the right content-type, and a
// zero-length body because the D1 BLOB value was handed straight to Response().

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

test('assetBytes passes a Uint8Array through unchanged', () => {
  assert.deepEqual(Array.from(assetBytes(PNG)), Array.from(PNG));
});

test('assetBytes unwraps an ArrayBuffer', () => {
  const buf = PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength);
  assert.deepEqual(Array.from(assetBytes(buf)), Array.from(PNG));
});

test('assetBytes unwraps a typed-array view with an offset', () => {
  const padded = new Uint8Array(PNG.length + 4);
  padded.set(PNG, 2);
  const view = new Uint8Array(padded.buffer, 2, PNG.length);
  assert.deepEqual(Array.from(assetBytes(view)), Array.from(PNG));
});

test('assetBytes accepts a plain number array (some D1 shapes)', () => {
  assert.deepEqual(Array.from(assetBytes(Array.from(PNG))), Array.from(PNG));
});

test('assetBytes accepts a { data: number[] } object', () => {
  assert.deepEqual(Array.from(assetBytes({ data: Array.from(PNG) })), Array.from(PNG));
});

test('assetBytes decodes base64 text', () => {
  const b64 = Buffer.from(PNG).toString('base64');
  assert.deepEqual(Array.from(assetBytes(b64)), Array.from(PNG));
});

test('assetBytes returns null for missing data so the route can 404', () => {
  assert.equal(assetBytes(null), null);
  assert.equal(assetBytes(undefined), null);
});
