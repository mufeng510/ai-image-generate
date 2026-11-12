/**
 * sidecar/src/extractor.js
 *
 * 2.1.4 起：主流程（probeAndExtract）取「无水印原图 image_ori_raw」改为走网络拦截
 * （见 ./response-capture.js：/chat/completion EventStream + /im/chain/single 消息链快照），
 * 本模块保留：
 *   - parseImageOriRaws：页面静态内嵌 JSON 中的 image_ori_raw 正则解析（兜底，聊天页通常 0 命中）；
 *   - generatedImageKey / dedupeGeneratedImages / decodeUnicodeEscapes 等共享工具；
 *   - extractImagesFromDom / extractAndSaveImages：DOM <img> 扫描（cgen/cthumb 展示 rendition，
 *     带「豆包AI生成」水印）。主流程不再调用；仅保留供离线测试与历史兼容，禁止用于下载交付。
 * 适用场景：豆包对话页（单页应用，消息快照不内嵌于静态 HTML）。
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

/** 生成图 URL 的文件标识：路径中的底图 ID（去掉 ~tplv... 缩放后缀、忽略 origin/查询串）。
 *  同一底图的缩略图与高清图可能落在不同 CDN 域（p11/p3/p6/p26），且查询签名不同，
 *  只有底图路径本身是稳定标识。 */
function generatedImageKey(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/~tplv[^/]*/g, '');
  } catch (_) {
    return url.replace(/~tplv[^/]*/g, '').replace(/\?.*$/, '');
  }
}

/**
 * DOM 兜底去重：同一文件标识只保留一张，高清优先（cgen > cthumb）。
 * 豆包页面为每张生成图渲染两个 <img>（src 与 currentSrc/srcSet 指向不同缩放版本），
 * 直接按 src 计数会把缩略图与高清图各算一份。
 */
function dedupeGeneratedImages(images) {
  const rank = (url) => (/cthumb/i.test(url || '') ? 1 : 0);
  const best = new Map();
  for (const img of images) {
    const key = generatedImageKey(img.url);
    const cur = best.get(key);
    if (!cur) {
      best.set(key, img);
      continue;
    }
    if (rank(img.url) < rank(cur.url)) best.set(key, img);
  }
  return Array.from(best.values());
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

/** 解码 HTML/JSON 中的 \uXXXX 转义 */
function decodeUnicodeEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 从 HTML 文本解析 image_ori_raw（无水印原图）URL 列表 */
function parseImageOriRaws(html) {
  if (!html) return [];
  const re = /image_ori_raw(?:\\":\{\\"url\\":\\"|":\{"url":")([^"]+)/g;
  const candidates = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    candidates.push(m[1]);
  }

  // 解码转义（HTML/JSON 中 URL 结尾可能残留转义反斜杠，必须去掉）
  const decoded = candidates
    .map((u) => decodeUnicodeEscapes(u))
    .map((u) => u.replace(/&amp;/g, '&'))
    .map((u) => u.replace(/\\+$/, ''))
    .filter((u) => /^https?:\/\//i.test(u));

  // 只要原始无水印图（/rc_gen_image/ + image_raw），按文件标识去重，优先 PNG
  const byKey = new Map();
  const extPriority = (url) => {
    if (/\.png(?:[?~]|$)/i.test(url)) return 0;
    if (/\.jpe?g(?:[?~]|$)/i.test(url)) return 1;
    if (/\.heic(?:[?~]|$)/i.test(url)) return 2;
    if (/\.webp(?:[?~]|$)/i.test(url)) return 3;
    return 4;
  };
  const keyOf = (url) => generatedImageKey(url);

  for (const url of decoded) {
    if (!url.includes('/rc_gen_image/') || !url.includes('image_raw')) continue;
    const key = keyOf(url);
    const cur = byKey.get(key);
    if (!cur || extPriority(url) < extPriority(cur)) {
      byKey.set(key, url);
    }
  }

  return Array.from(byKey.values()).map((url) => ({ url, identity: keyOf(url) }));
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
  decodeUnicodeEscapes,
  parseImageOriRaws,
  extFromUrl,
  extractImagesFromDom,
  extractAndSaveImages,
  generatedImageKey,
  dedupeGeneratedImages,
};
