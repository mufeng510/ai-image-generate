/**
 * sidecar/src/extractor.js
 *
 * 基于 ihmily/doubao-nomark 油猴脚本核心提取逻辑（MIT 许可），改写为 Node.js + Playwright DOM 扫描。
 *
 * 核心数据源：页面渲染的  标签 src 属性。
 * 筛选规则（对应脚本的图片捕获逻辑）：
 *   - 只保留 tos-cn-i-a9rns2rl98 路径的图片资源 URL（豆包图片生成服务）
 *   - 排除 /icon/、action_bar_icon、.svg 等 UI 资源
 *   - 按 URL 身份（origin+pathname，去掉查询参数）去重，避免同一张图片重复下载
 *
 * 适用场景：豆包对话页（单页应用，切换对话不触发 /im/chain/single 网络请求，故以 DOM 提取为主）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { downloadImage, extFromUrl } = require('./downloader');

/** 判断是否为 HTTP(S) URL */
function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** 判断是否为 UI 图标/资源，应被过滤 */
function isUiAsset(url) {
  const low = url.toLowerCase();
  // 生成图片的路径模式：tos-cn-i-a9rns2rl98（豆包图片生成服务）
  // 只有命中此路径的才保留，其余均视为 UI 资源过滤
  if (!low.includes('tos-cn-i-a9rns2rl98')) return true;
  if (low.includes('/icon/') || low.includes('action_bar_icon')) return true;
  if (low.endsWith('.svg')) return true;
  return false;
}

/** URL 身份（去掉查询参数和片段，用于去重） */
function urlIdentity(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (_) {
    return url;
  }
}

/** 在 Playwright 页面中提取所有生成图片的 URL（DOM 扫描） */
async function extractImagesFromDom(page) {
  return await page.evaluate(() => {
    const seen = new Set();
    const results = [];
    const add = (url) => {
      if (!url || !isHttpUrl(url)) return;
      if (isUiAsset(url)) return;
      const id = urlIdentity(url);
      if (seen.has(id)) return;
      seen.add(id);
      results.push({ url, identity: id });
    };

    document.querySelectorAll('img').forEach((img) => {
      const src = img.src || img.getAttribute('src');
      if (src) add(src);
      const curSrc = img.currentSrc;
      if (curSrc) add(curSrc);
    });

    return results;

    function isHttpUrl(v) {
      return typeof v === 'string' && /^https?:\/\//i.test(v);
    }
    function isUiAsset(u) {
      const low = u.toLowerCase();
      if (!low.includes('tos-cn-i-a9rns2rl98')) return true;
      if (low.includes('/icon/') || low.includes('action_bar_icon')) return true;
      if (low.endsWith('.svg')) return true;
      return false;
    }
    function urlIdentity(u) {
      try {
        const x = new URL(u);
        return x.origin + x.pathname;
      } catch (_) {
        return u;
      }
    }
  });
}

/** 提取图片并下载保存到本地（返回下载结果列表） */
async function extractAndSaveImages(page, roundDir, emitter) {
  const rawImages = await extractImagesFromDom(page);
  emitter({ type: 'log', level: 'info', message: `页面中发现 ${rawImages.length} 张生成图片（已去重，排除 UI 图标）` });

  if (rawImages.length === 0) {
    return { images: [], results: [], successCount: 0, failedCount: 0 };
  }

  fs.mkdirSync(roundDir, { recursive: true });

  let success = 0, failed = 0;
  const results = [];
  const images = [];

  for (let i = 0; i < rawImages.length; i++) {
    const imgUrl = rawImages[i].url;
    const index = i + 1;
    const destPath = path.join(roundDir, `image_${String(index).padStart(3, '0')}.png`);

    emitter({
      type: 'event',
      event: 'download_progress',
      current: index,
      total: rawImages.length,
      message: `下载中: ${path.basename(destPath)}`
    });

    const res = await downloadImage(page, imgUrl, destPath);

    if (res.ok) {
      images.push({ url: imgUrl, index, saved_path: res.path });
      success += 1;
      emitter({
        type: 'event',
        event: 'download_progress',
        current: index,
        total: rawImages.length,
        message: `下载成功: ${path.basename(res.path)} (${res.size} bytes)`
      });
    } else {
      failed += 1;
      emitter({
        type: 'event',
        event: 'download_progress',
        current: index,
        total: rawImages.length,
        message: `下载失败: ${res.error}`
      });
    }

    results.push({
      index,
      url: imgUrl,
      ok: res.ok,
      skipped: !!res.skipped,
      path: res.path,
      size: res.size,
      sha256: res.sha256,
      ext: res.ext,
      error: res.error,
    });
  }

  return { images, results, successCount: success, failedCount: failed };
}

module.exports = {
  isHttpUrl,
  isUiAsset,
  urlIdentity,
  extFromUrl,
  extractImagesFromDom,
  extractAndSaveImages,
};
