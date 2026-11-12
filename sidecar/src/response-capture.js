/**
 * sidecar/src/response-capture.js
 *
 * 基于 ihmily/doubao-nomark 浏览器扩展的网络拦截逻辑（MIT 许可），改写为 Playwright page.on('response') 监听。
 *
 * 聊天页（/chat/<id>）的生成结果不内嵌在静态 HTML 中（页面内嵌的 trimmedChainRecentConvCells 仅骨架，
 * messages 为空），而是经由运行时网络请求承载：
 *   - /chat/completion   生成过程 EventStream（data: {...} 行），含 patch_op / event_data 携带 creations
 *   - /im/chain/single   消息链快照 JSON，downlink_body.pull_singe_chain_downlink_body.messages[].content_block
 * 从中解析 creations，取 creation.image.image_ori_raw（无水印原图直链），按底图 key 去重缓存。
 *
 * 铁律：取不到原图时绝不回退下载渲染用 <img>（cgen/cthumb rendition 带「豆包AI生成」水印），
 * 由调用方（probeAndExtract）决定停下报错。
 */

'use strict';

const { generatedImageKey, decodeUnicodeEscapes } = require('./extractor');

/** page -> Map(identity -> {url, identity, key, width, height}) */
const stores = new WeakMap();

function storeFor(page) {
  let store = stores.get(page);
  if (!store) {
    store = new Map();
    stores.set(page, store);
  }
  return store;
}

function tryParseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

/** 清洗 URL：解 \uXXXX 转义、&amp;、去尾部转义反斜杠 */
function cleanUrl(raw) {
  if (typeof raw !== 'string') return null;
  const u = decodeUnicodeEscapes(raw).replace(/&amp;/g, '&').replace(/\\+$/, '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

/** 无水印原图判定：必须在 /rc_gen_image/ 下且为 image_raw rendition（与 parseImageOriRaws 一致） */
function isOriginalGenUrl(url) {
  return url.includes('/rc_gen_image/') && url.includes('image_raw');
}

/** 同图多 rendition 的格式优先级：PNG > JPG > HEIC > WEBP > 其他 */
function extPriority(url) {
  if (/\.png(?:[?~]|$)/i.test(url)) return 0;
  if (/\.jpe?g(?:[?~]|$)/i.test(url)) return 1;
  if (/\.heic(?:[?~]|$)/i.test(url)) return 2;
  if (/\.webp(?:[?~]|$)/i.test(url)) return 3;
  return 4;
}

/** 从单个 creation 对象提取原图条目；不符合原图规则返回 null */
function imageFromCreation(creation) {
  if (!creation || typeof creation !== 'object') return null;
  const image = creation.image;
  if (!image || typeof image !== 'object') return null;
  const rawValue = image.image_ori_raw;
  if (!rawValue) return null;
  const rawUrl = typeof rawValue === 'string' ? rawValue : rawValue.url;
  const url = cleanUrl(rawUrl);
  if (!url || !isOriginalGenUrl(url)) return null;
  const width = Number(typeof rawValue === 'object' && rawValue ? rawValue.width : 0) || 0;
  const height = Number(typeof rawValue === 'object' && rawValue ? rawValue.height : 0) || 0;
  return {
    url,
    identity: generatedImageKey(url),
    key: typeof image.key === 'string' ? image.key.trim() : '',
    width,
    height,
  };
}

/** 收集 creations 中的原图到 page 的缓存（同底图 key：PNG 优先，后到的低优先级格式不覆盖高优先级） */
function addCreations(page, creations) {
  if (!page || !Array.isArray(creations)) return 0;
  const store = storeFor(page);
  let added = 0;
  for (const creation of creations) {
    const item = imageFromCreation(creation);
    if (!item) continue;
    const cur = store.get(item.identity);
    if (!cur) {
      store.set(item.identity, item);
      added += 1;
      continue;
    }
    if (extPriority(item.url) < extPriority(cur.url)) {
      store.set(item.identity, item);
      added += 1;
    }
  }
  return added;
}

/** 从 content 对象/JSON 字符串提取 creations（兼容 creation_block 与 rich_media_layout_block 两种形态，以及 content_v2） */
function getCreationsFromContent(content) {
  let value = content;
  if (typeof value === 'string') value = tryParseJson(value);
  if (!value || typeof value !== 'object') return [];

  const creations = [];
  const block = value.creation_block;
  if (block && Array.isArray(block.creations)) {
    creations.push(...block.creations);
  }
  const media = value.rich_media_layout_block && value.rich_media_layout_block.media;
  if (Array.isArray(media)) {
    for (const item of media) {
      if (item && item.creation && typeof item.creation === 'object') {
        creations.push(item.creation);
      }
    }
  }
  return creations;
}

/** 内容块：优先 content_v2，回退 content，再回退块本身 */
function creationsFromBlock(block) {
  if (!block || typeof block !== 'object') return [];
  return getCreationsFromContent(
    block.content_v2 !== undefined ? block.content_v2
      : block.content !== undefined ? block.content
        : block
  );
}

/** 解析 /im/chain/single 响应体 → creations */
function extractFromChainSingleBody(body) {
  const data = typeof body === 'string' ? tryParseJson(body) : body;
  if (!data || typeof data !== 'object') return [];
  const downlink = data.downlink_body;
  const chainBody = downlink && (downlink.pull_singe_chain_downlink_body || downlink.pull_single_chain_downlink_body);
  const messages = chainBody && chainBody.messages;
  if (!Array.isArray(messages)) return [];
  const creations = [];
  for (const item of messages) {
    const blocks = item && item.content_block;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      creations.push(...creationsFromBlock(block));
    }
  }
  return creations;
}

/** 解析 completion EventStream 的 patch_op → creations */
function findCreationsInPatch(patchOps) {
  if (!Array.isArray(patchOps)) return [];
  const creations = [];
  for (const op of patchOps) {
    const blocks = op && op.patch_value && op.patch_value.content_block;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      creations.push(...creationsFromBlock(block));
    }
  }
  if (creations.length) return creations;

  // 兜底：creation_full_content（整段消息 JSON 数组）
  const extPatch = patchOps.find((op) => op && op.patch_value && op.patch_value.ext && op.patch_value.ext.creation_full_content);
  if (!extPatch) return [];
  const content = tryParseJson(extPatch.patch_value.ext.creation_full_content);
  if (!Array.isArray(content)) return [];
  for (const item of content) {
    const blockContent = item && item.BlockInfo && item.BlockInfo.BlockContent;
    creations.push(...creationsFromBlock(blockContent));
  }
  return creations;
}

/** 解析 completion EventStream 的 event_data（旧格式）→ creations */
function findCreationsInEventData(rawEventData) {
  const eventData = typeof rawEventData === 'string' ? tryParseJson(rawEventData) : rawEventData;
  if (!eventData || typeof eventData !== 'object') return [];
  const message = eventData.message;
  if (!message || typeof message !== 'object') return [];
  const rawContent = message.content_v2 !== undefined ? message.content_v2 : message.content;
  const content = typeof rawContent === 'string' ? tryParseJson(rawContent) : rawContent;
  if (!content || typeof content !== 'object') return [];
  if (Array.isArray(content.creations)) return content.creations;
  return getCreationsFromContent(content);
}

/** 解析 /chat/completion EventStream 全文 → creations */
function extractFromCompletionStreamBody(body) {
  if (typeof body !== 'string' || !body.trim()) return [];
  const creations = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') continue;
    // 廉价过滤：不含 image/creation 的行与生图无关（视频 fallback_api 行含 image 也会被放行，无害）
    if (!jsonStr.includes('image') && !jsonStr.includes('creation')) continue;
    const data = tryParseJson(jsonStr);
    if (!data || typeof data !== 'object') continue;
    if (data.patch_op) creations.push(...findCreationsInPatch(data.patch_op));
    if (data.event_data) creations.push(...findCreationsInEventData(data.event_data));
  }
  return creations;
}

/** 返回 page 上已捕获的原图列表（Map 迭代顺序 = 首次出现顺序） */
function getCapturedImages(page) {
  const store = page && stores.get(page);
  if (!store) return [];
  return Array.from(store.values());
}

/** 清空 page 上的捕获缓存（新一轮生成开始时调用，避免上一轮的图混入本轮） */
function clearCaptured(page) {
  const store = page && stores.get(page);
  if (store) store.clear();
}

/**
 * 为 page 安装网络响应监听。幂等（重复调用为空操作）。
 * EventStream 的 body 会在生成结束后才完整，response.text() 随之 resolve，无需轮询。
 */
function installResponseCapture(page, logFn) {
  if (!page || typeof page.on !== 'function') return;
  if (page.__doubaoNomarkCaptureInstalled) return;
  page.__doubaoNomarkCaptureInstalled = true;

  const info = typeof logFn === 'function' ? logFn : () => {};
  page.on('response', (response) => {
    let url = '';
    try { url = response.url(); } catch (_) { return; }
    const isCompletion = url.includes('/chat/completion');
    const isChain = url.includes('/im/chain/single');
    if (!isCompletion && !isChain) return;
    const source = isCompletion ? '/chat/completion' : '/im/chain/single';
    response.text().then((body) => {
      try {
        const creations = isCompletion
          ? extractFromCompletionStreamBody(body)
          : extractFromChainSingleBody(body);
        const added = addCreations(page, creations);
        if (added > 0) {
          info('info', `网络拦截：从 ${source} 捕获 ${added} 张无水印原图（累计 ${getCapturedImages(page).length} 张）`);
        }
      } catch (err) {
        info('warn', `网络拦截解析失败（${source}）: ${err && err.message ? err.message : err}`);
      }
    }).catch(() => { /* body 不可读（流中断等）：本次响应放弃，交由重试/人工处理 */ });
  });
}

module.exports = {
  installResponseCapture,
  getCapturedImages,
  clearCaptured,
  addCreations,
  getCreationsFromContent,
  findCreationsInPatch,
  findCreationsInEventData,
  extractFromChainSingleBody,
  extractFromCompletionStreamBody,
  imageFromCreation,
  isOriginalGenUrl,
};
