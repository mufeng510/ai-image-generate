/**
 * validate-downloader.js
 *
 * 对 downloader.js 的离线逻辑做验证（不发网络请求）：
 *   - 根据 Content-Type 判断扩展名
 *   - 根据文件魔数判断扩展名
 *   - 文件完整性判断（存在性、大小、范围）
 *   - SHA-256 计算
 *
 * 运行：node src/validate-downloader.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  extFromContentType,
  extFromMagicBytes,
  isFileComplete,
  sha256File,
  MIN_FILE_SIZE,
  MAX_FILE_SIZE,
} = require('./downloader');

let passed = 0;
let failed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-downloader-test-'));

try {
  // ---------- extFromContentType ----------
  ok('extFromContentType image/jpeg -> .jpg', () => eq(extFromContentType('image/jpeg'), '.jpg'));
  ok('extFromContentType image/png -> .png', () => eq(extFromContentType('image/png'), '.png'));
  ok('extFromContentType image/webp -> .webp', () => eq(extFromContentType('image/webp'), '.webp'));
  ok('extFromContentType 带参数 image/png; charset=utf-8', () =>
    eq(extFromContentType('image/png; charset=utf-8'), '.png')
  );
  ok('extFromContentType 未知类型 -> null', () => eq(extFromContentType('text/html'), null));
  ok('extFromContentType 空 -> null', () => eq(extFromContentType(''), null));

  // ---------- extFromMagicBytes ----------
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpgSig = Buffer.from([0xff, 0xd8, 0xff]);
  const webpRiff = Buffer.concat([
    Buffer.from([0x52, 0x49, 0x46, 0x46]),
    Buffer.alloc(4),
    Buffer.from([0x57, 0x45, 0x42, 0x50]),
  ]);
  const gifSig = Buffer.from([0x47, 0x49, 0x46, 0x38]);

  ok('extFromMagicBytes PNG', () => eq(extFromMagicBytes(pngSig), '.png'));
  ok('extFromMagicBytes JPEG', () => eq(extFromMagicBytes(jpgSig), '.jpg'));
  ok('extFromMagicBytes WebP', () => eq(extFromMagicBytes(webpRiff), '.webp'));
  ok('extFromMagicBytes GIF', () => eq(extFromMagicBytes(gifSig), '.gif'));
  ok('extFromMagicBytes 未知 -> null', () => eq(extFromMagicBytes(Buffer.from([0, 0, 0, 0])), null));
  ok('extFromMagicBytes 空 -> null', () => eq(extFromMagicBytes(Buffer.alloc(0)), null));

  // ---------- isFileComplete ----------
  const smallFile = path.join(tmpDir, 'small.bin');
  const bigFile = path.join(tmpDir, 'big.bin');
  const emptyFile = path.join(tmpDir, 'empty.bin');
  fs.writeFileSync(smallFile, Buffer.alloc(2048)); // 2KB，合理
  fs.writeFileSync(bigFile, Buffer.alloc(60 * 1024 * 1024)); // 60MB，超限
  fs.writeFileSync(emptyFile, Buffer.alloc(0));

  ok('isFileComplete 存在且大小合理 -> true', () =>
    assert.strictEqual(isFileComplete(smallFile, 2048), true));
  ok('isFileComplete 期望大小不匹配 -> false', () =>
    assert.strictEqual(isFileComplete(smallFile, 1024), false));
  ok('isFileComplete 文件过大 -> false', () => assert.strictEqual(isFileComplete(bigFile, 60 * 1024 * 1024), false));
  ok('isFileComplete 空文件 -> false', () => assert.strictEqual(isFileComplete(emptyFile, 0), false));
  ok('isFileComplete 不存在 -> false', () => assert.strictEqual(isFileComplete(path.join(tmpDir, 'nope.bin')), false));

  // ---------- sha256File ----------
  const hashFile = path.join(tmpDir, 'hash.bin');
  const content = Buffer.from('hello doubao prototype');
  fs.writeFileSync(hashFile, content);
  const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
  ok('sha256File 计算正确', async () => {
    const actual = await sha256File(hashFile);
    eq(actual, expectedHash);
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

process.exit(failed > 0 ? 1 : 0);
