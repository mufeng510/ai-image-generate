/**
 * downloader.js
 *
 * 豆包原始图片下载与完整性校验模块。
 * 特点：
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

const CONTENT_TYPE_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

/** 合理的图片文件大小范围（字节）：最小 1KB，最大 50MB */
const MIN_FILE_SIZE = 1024;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * 根据 Content-Type 推断扩展名。
 */
function extFromContentType(contentType) {
  if (!contentType) return null;
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  return CONTENT_TYPE_TO_EXT[type] || null;
}

/**
 * 根据文件内容魔数推断扩展名。
 */
function extFromMagicBytes(buf) {
  if (!buf || buf.length === 0) return null;
  for (const { sig, ext, check } of MAGIC_TO_EXT) {
    if (buf.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i += 1) {
      if (buf[i] !== sig[i]) { match = false; break; }
    }
    if (!match) continue;
    if (check && !check(buf)) continue;
    return ext;
  }
  return null;
}

/**
 * 计算文件的 SHA-256 哈希。
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 判断目标文件是否已完整保存（存在且大小与预期一致）。
 * expectedSize 为 null 时仅判断存在性。
 */
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

/**
 * 下载单张图片并保存。
 * @param {string} url - 图片原始 URL
 * @param {string} destPath - 保存路径
 * @param {object} opts - { expectedSize?, timeoutMs?, referer? }
 * @returns {Promise<{ok: boolean, path?: string, size?: number, sha256?: string, ext?: string, error?: string}>}
 */
async function downloadImage(url, destPath, opts = {}) {
  const { expectedSize, timeoutMs = 60000, referer } = opts;
  const result = { ok: false, path: destPath, error: null };

  // 若已完整保存，跳过
  if (isFileComplete(destPath, expectedSize)) {
    result.ok = true;
    result.skipped = true;
    try {
      result.size = fs.statSync(destPath).size;
      result.sha256 = await sha256File(destPath);
    } catch (_) {}
    return result;
  }

  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {};
    if (referer) headers['Referer'] = referer;
    response = await fetch(url, {
      headers,
      signal: controller.signal,
      // 重定向默认跟随
    });
    clearTimeout(timer);
  } catch (err) {
    result.error = err.message || String(err);
    return result;
  }

  if (!response.ok) {
    result.error = `HTTP ${response.status}`;
    return result;
  }

  const contentType = response.headers.get('content-type') || '';
  const suggestedExt = extFromContentType(contentType);

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    result.error = `读取响应体失败: ${err.message || String(err)}`;
    return result;
  }

  // 根据实际内容判断扩展名，优先魔数，其次 Content-Type，再 URL 后缀
  let ext = extFromMagicBytes(buffer);
  if (!ext && suggestedExt) ext = suggestedExt;
  if (!ext) {
    try {
      const u = new URL(url);
      const match = u.pathname.match(/\.([a-z0-9]{1,5})$/i);
      if (match) ext = '.' + match[1].toLowerCase();
    } catch (_) {}
  }
  if (!ext) ext = '.png';
  result.ext = ext;

  // 文件大小合理性
  if (buffer.length < MIN_FILE_SIZE || buffer.length > MAX_FILE_SIZE) {
    result.error = `文件大小不合理: ${buffer.length} 字节`;
    return result;
  }

  // 确保目录存在
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // 若目标已存在（但不完整），先删除避免损坏文件残留
  try {
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  } catch (_) {}

  try {
    fs.writeFileSync(destPath, buffer);
  } catch (err) {
    result.error = `写入文件失败: ${err.message || String(err)}`;
    return result;
  }

  // 校验：再次读取，确认文件完整并计算 SHA-256
  try {
    const stat = fs.statSync(destPath);
    if (stat.size !== buffer.length) {
      result.error = '写入后文件大小不一致';
      return result;
    }
    result.size = stat.size;
    result.sha256 = await sha256File(destPath);
  } catch (err) {
    result.error = `校验文件失败: ${err.message || String(err)}`;
    return result;
  }

  result.ok = true;
  return result;
}

/**
 * 批量下载图片。
 * @param {Array<{url:string, index?:number, name?:string}>} items
 * @param {string} outDir
 * @param {object} opts
 * @returns {Promise<{results: Array<{index, url, ok, path, size, sha256, ext, error, skipped}>, successCount, failedCount}>}
 */
async function downloadBatch(items, outDir, opts = {}) {
  const { concurrency = 1, referer, onProgress } = opts;
  const results = [];
  let successCount = 0;
  let failedCount = 0;

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 串行或限制并发下载（Playwright 上下文共享 Cookie，建议低并发）
  const queue = [...items];
  const running = [];

  const enqueue = () => {
    while (running.length < concurrency && queue.length > 0) {
      const item = queue.shift();
      const p = (async () => {
        const index = item.index != null ? item.index : results.length;
        const name = item.name || `image_${String(index + 1).padStart(3, '0')}`;
        // 若 item 没带扩展名，先按 .png 占位，下载后会根据实际格式重命名
        const baseName = name.replace(/\.[^/.]+$/, '');
        const destPath = path.join(outDir, `${baseName}.png`);
        const res = await downloadImage(item.url, destPath, {
          expectedSize: item.expectedSize,
          timeoutMs: opts.timeoutMs,
          referer,
        });
        // 按实际扩展名重命名
        let finalPath = destPath;
        if (res.ok && res.ext && res.ext !== '.png') {
          finalPath = path.join(outDir, `${baseName}${res.ext}`);
          try {
            if (finalPath !== destPath && fs.existsSync(destPath)) {
              fs.renameSync(destPath, finalPath);
            }
          } catch (_) {}
        }
        const entry = {
          index,
          url: item.url,
          ok: res.ok,
          skipped: !!res.skipped,
          path: res.ok ? finalPath : null,
          size: res.size,
          sha256: res.sha256,
          ext: res.ext,
          error: res.error,
        };
        results.push(entry);
        if (res.ok) successCount += 1;
        else failedCount += 1;
        onProgress?.(entry);
        return entry;
      })();
      running.push(p);
      p.finally(() => {
        const idx = running.indexOf(p);
        if (idx >= 0) running.splice(idx, 1);
        enqueue();
      });
    }
  };

  // 启动首批
  enqueue();
  // 等待全部完成
  await Promise.all(running);

  return { results, successCount, failedCount };
}

module.exports = {
  extFromContentType,
  extFromMagicBytes,
  sha256File,
  isFileComplete,
  downloadImage,
  downloadBatch,
  MIN_FILE_SIZE,
  MAX_FILE_SIZE,
};
