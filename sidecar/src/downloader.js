/**
 * sidecar/src/downloader.js
 *
 * 豆包原始图片下载与完整性校验模块（Node.js + Playwright）。
 *
 * 特点：
 *   - 在页面上下文中通过 fetch 获取图片，携带页面 Cookie 凭据，能访问豆包原始资源；
 *   - 按实际 Content-Type / 文件魔数保留原始扩展名（JPG/PNG/WEBP 等），不统一转码；
 *   - 下载后校验文件存在性、大小合理性、内容完整性、实际格式、SHA-256；
 *   - 支持跳过已完整保存的图片（避免重复下载）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 图片文件魔数（前几个字节） -> 扩展名 */
const MAGIC_TO_EXT = [
  // PNG
  { sig: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ext: '.png' },
  // JPEG
  { sig: Buffer.from([0xff, 0xd8, 0xff]), ext: '.jpg' },
  // WebP (RIFF....WEBP)
  { sig: Buffer.from([0x52, 0x49, 0x46, 0x46]), ext: '.webp', check: (buf) => buf.toString('ascii', 8, 12) === 'WEBP' },
  // GIF
  { sig: Buffer.from([0x47, 0x49, 0x46, 0x38]), ext: '.gif' },
  // BMP
  { sig: Buffer.from([0x42, 0x4d]), ext: '.bmp' },
];

/** 合理的图片文件大小范围（字节）：最小 1KB，最大 50MB */
const MIN_FILE_SIZE = 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** 根据 URL 路径判断扩展名 */
function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{1,5})(?:\?|$)/i);
    if (m) return '.' + m[1].toLowerCase();
  } catch (_) {}
  return '.png';
}

/** 根据文件内容魔数判断扩展名 */
function extFromMagicBytes(buf) {
  if (!buf || buf.length === 0) return null;
  for (const { sig, ext, check } of MAGIC_TO_EXT) {
    if (buf.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) { if (buf[i] !== sig[i]) { match = false; break; } }
    if (!match) continue;
    if (check && !check(buf)) continue;
    return ext;
  }
  return null;
}

/** 计算文件的 SHA-256 哈希 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 判断目标文件是否已完整保存（存在且大小合理） */
function isFileComplete(filePath, expectedSize) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (expectedSize != null && stat.size !== expectedSize) return false;
    return stat.size >= MIN_FILE_SIZE && stat.size <= MAX_FILE_SIZE;
  } catch (_) {
    return false;
  }
}

/** 在页面上下文中下载单张图片并保存（携带页面 Cookie 凭据） */
async function downloadImage(page, url, destPath) {
  const result = { ok: false, path: destPath, error: null };

  // 若已完整保存，跳过
  if (isFileComplete(destPath)) {
    result.ok = true;
    result.skipped = true;
    try {
      result.size = fs.statSync(destPath).size;
      result.sha256 = await sha256File(destPath);
    } catch (_) {}
    return result;
  }

  let buffer;
  try {
    // 在页面内通过 fetch 获取 ArrayBuffer，携带页面 Cookie，再以 base64 返回给 Node 写入本地
    const dataUrl = await page.evaluate(async (targetUrl) => {
      const resp = await fetch(targetUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ab = await resp.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = '';
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }, url);
    buffer = Buffer.from(dataUrl, 'base64');
  } catch (err) {
    result.error = err.message || String(err);
    return result;
  }

  // 文件大小合理性
  if (buffer.length < MIN_FILE_SIZE || buffer.length > MAX_FILE_SIZE) {
    result.error = `文件大小不合理: ${buffer.length} 字节`;
    return result;
  }

  // 按实际内容判断扩展名（魔数优先，其次 URL 路径）
  let ext = extFromMagicBytes(buffer);
  if (!ext) ext = extFromUrl(url);
  result.ext = ext;

  const finalDestPath = destPath.replace(/\.[^/.]+$/, ext);
  if (finalDestPath !== destPath && fs.existsSync(destPath)) {
    try { fs.renameSync(destPath, finalDestPath); } catch (_) {}
  }

  // 确保目录存在
  const destDir = path.dirname(finalDestPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // 若目标已存在（但不完整），先删除避免损坏文件残留
  try {
    if (fs.existsSync(finalDestPath)) fs.unlinkSync(finalDestPath);
  } catch (_) {}

  try {
    fs.writeFileSync(finalDestPath, buffer);
  } catch (err) {
    result.error = `写入文件失败: ${err.message || String(err)}`;
    return result;
  }

  // 校验：再次读取，确认文件完整并计算 SHA-256
  try {
    const stat = fs.statSync(finalDestPath);
    if (stat.size !== buffer.length) {
      result.error = '写入后文件大小不一致';
      return result;
    }
    result.size = stat.size;
    result.sha256 = await sha256File(finalDestPath);
  } catch (err) {
    result.error = `校验文件失败: ${err.message || String(err)}`;
    return result;
  }

  result.ok = true;
  result.path = finalDestPath;
  return result;
}

module.exports = {
  extFromUrl,
  extFromMagicBytes,
  sha256File,
  isFileComplete,
  downloadImage,
  MIN_FILE_SIZE,
  MAX_FILE_SIZE,
};

// 下载器单元测试（需在 Node.js 环境下运行）
function testDownloader() {
  let passed = 0;
  let failed = 0;

  // extFromMagicBytes 测试
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpgSig = Buffer.from([0xff, 0xd8, 0xff]);
  const webpSig = Buffer.concat([Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.alloc(4), Buffer.from([0x57, 0x45, 0x42, 0x50])]);

  const tests = [
    [extFromMagicBytes(pngSig), '.png', 'PNG magic'],
    [extFromMagicBytes(jpgSig), '.jpg', 'JPEG magic'],
    [extFromMagicBytes(webpSig), '.webp', 'WebP magic'],
    [extFromMagicBytes(Buffer.alloc(0)), null, 'Empty buffer'],
    [extFromMagicBytes(Buffer.from([0, 0, 0, 0])), null, 'Unknown bytes'],
  ];

  for (const [actual, expected, desc] of tests) {
    if (actual === expected) {
      passed++;
    } else {
      failed++;
      console.error(`FAIL: ${desc}: expected ${expected}, got ${actual}`);
    }
  }

  // extFromUrl 测试
  const urlTests = [
    ['https://example.com/image.png', '.png', 'PNG URL'],
    ['https://example.com/image.jpg', '.jpg', 'JPEG URL'],
    ['https://example.com/image.webp', '.webp', 'WEBP URL'],
    ['https://example.com/noext', '.png', 'No extension defaults to png'],
  ];

  for (const [url, expected, desc] of urlTests) {
    const actual = extFromUrl(url);
    if (actual === expected) {
      passed++;
    } else {
      failed++;
      console.error(`FAIL: ${desc}: expected ${expected}, got ${actual}`);
    }
  }

  console.log(`下载器测试结果: ${passed} 通过, ${failed} 失败`);
  return failed === 0;
}

// 如果直接运行此文件，执行测试
if (require.main === module) {
  const success = testDownloader();
  process.exit(success ? 0 : 1);
}
