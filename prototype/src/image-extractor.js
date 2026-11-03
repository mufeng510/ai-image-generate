/**
 * image-extractor.js
 *
 * 从油猴脚本《无印豆包 - 素材提取》（MIT 许可，ihmily/doubao-nomark）中提炼的
 * 豆包原图提取逻辑，改写为 Node.js + Playwright 可复用模块。
 *
 * 核心数据源：creation.image.image_ori_raw.url —— 豆包返回的原始无水印图片地址。
 * 适用来源：
 *   - POST /chat/completion 的 EventStream（SSE）流式生图结果
 *   - /im/chain/single 聊天历史快照
 *   - 分享页 /thread/*、/share/* 中的路由数据脚本标签
 *
 * 不依赖脆弱的 DOM 选择器，以网络层响应提取为主。
 */

'use strict';

/** 豆包对话主机 */
const DOUBAO_ORIGIN = 'https://www.doubao.com';

/**
 * 判断是否为 HTTP(S) URL。
 */
function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * 把 HTML 转义的 &amp; 还原为 &（最多 3 轮）。
 */
function normalizeImageUrl(url) {
  if (typeof url !== 'string') return '';
  let text = url;
  for (let i = 0; i < 3; i += 1) {
    const decoded = text.replace(/&amp;/g, '&');
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

/**
 * 从单个 creation 对象提取原图信息。
 * 返回 { url, width, height } 或 null。
 */
function getCreationImageInfo(creation) {
  if (!creation || typeof creation !== 'object') return null;

  const image = creation.image;
  if (!image) return null;

  const raw = image.image_ori_raw;
  if (!raw) return null;

  let url = '';
  let width = 0;
  let height = 0;

  if (typeof raw === 'string') {
    url = normalizeImageUrl(raw);
  } else if (typeof raw === 'object' && raw.url) {
    url = normalizeImageUrl(raw.url);
    width = Number(raw.width || 0);
    height = Number(raw.height || 0);
  }

  if (!isHttpUrl(url)) return null;
  return { url, width, height };
}

/**
 * 从一个 content block 中提取所有 creation 对象。
 * 支持两种结构：
 *   - content.creation_block.creations[]
 *   - content.rich_media_layout_block.media[].creation
 */
function getDoubaoBlockCreations(block) {
  if (!block || typeof block !== 'object') return [];

  const content = block.content_v2 || block.content || block;
  let data = content;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) {
      return [];
    }
  }
  if (!data || typeof data !== 'object') return [];

  const creations = [];

  const creationBlock = data.creation_block;
  if (
    creationBlock &&
    typeof creationBlock === 'object' &&
    Array.isArray(creationBlock.creations)
  ) {
    creations.push(...creationBlock.creations);
  }

  const richMedia = data.rich_media_layout_block;
  if (richMedia && typeof richMedia === 'object' && Array.isArray(richMedia.media)) {
    for (const item of richMedia.media) {
      if (item && typeof item === 'object' && item.creation) {
        creations.push(item.creation);
      }
    }
  }

  return creations;
}

/**
 * 递归遍历任意 JSON 值，收集所有 creation 并提取原图。
 * 适用于分享页路由数据等未知结构。
 */
function collectImagesFromValue(value, images, depth = 0, seen = new Set()) {
  if (depth > 40 || value == null) return;
  if (seen.has(value)) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
      try {
        collectImagesFromValue(JSON.parse(trimmed), images, depth + 1, seen);
      } catch (_) {
        // 普通文本字段，忽略
      }
    }
    return;
  }

  if (typeof value !== 'object') return;
  seen.add(value);

  for (const creation of getDoubaoBlockCreations(value)) {
    if (creation && creation.video) continue; // 本项目仅处理图片
    const info = getCreationImageInfo(creation);
    if (!info || images.some((img) => img.url === info.url)) continue;
    images.push(info);
  }

  if (Array.isArray(value)) {
    for (const item of value) collectImagesFromValue(item, images, depth + 1, seen);
    return;
  }
  for (const key of Object.keys(value)) {
    collectImagesFromValue(value[key], images, depth + 1, seen);
  }
}

/**
 * 解析 EventStream（SSE）文本，提取图片。
 * 对每一行 `data: <json>`，若 json 含 event_data/patch_op 且含 image_ori，
 * 则通过 parseStreamChunk 提取图片。
 *
 * 返回新增图片数组。
 */
function parseEventStreamText(text, existingUrls = new Set()) {
  const newImages = [];
  const lines = text.split('\n');
  let buffer = '';

  // SSE 可能分段，这里按行处理每个完整的 data 行
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.startsWith('data: ')) continue;

    const jsonStr = line.slice(6).trim();
    if (!jsonStr.includes('image_ori') && !jsonStr.includes('fallback_api')) continue;

    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (_) {
      continue;
    }

    const extracted = parseStreamChunkData(data);
    for (const info of extracted) {
      if (!existingUrls.has(info.url)) {
        existingUrls.add(info.url);
        newImages.push(info);
      }
    }
  }

  return newImages;
}

/**
 * 解析单个 SSE data 对象（对应脚本 parseStreamChunk）。
 * 支持 patch_op 和 event_data 两种形态。
 */
function parseStreamChunkData(data) {
  const images = [];
  if (!data || typeof data !== 'object') return images;

  let creations = [];

  if (Array.isArray(data.patch_op)) {
    for (const op of data.patch_op) {
      if (!op || typeof op.patch_value !== 'object') continue;
      const contentBlock = op.patch_value.content_block;
      if (!Array.isArray(contentBlock)) continue;
      for (const block of contentBlock) {
        for (const creation of getDoubaoBlockCreations(block)) {
          if (creation && creation.video) continue;
          const info = getCreationImageInfo(creation);
          if (info) creations.push(info);
        }
      }
    }

    // 兜底：creation_full_content
    if (creations.length === 0) {
      const extPatch = data.patch_op.find(
        (op) =>
          op &&
          typeof op.patch_value === 'object' &&
          op.patch_value.ext &&
          typeof op.patch_value.ext.creation_full_content === 'string'
      );
      if (extPatch) {
        try {
          const full = JSON.parse(extPatch.patch_value.ext.creation_full_content);
          for (const item of full) {
            const blocks = item && item.BlockInfo && item.BlockInfo.BlockContent;
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                for (const creation of getDoubaoBlockCreations(block)) {
                  if (creation && creation.video) continue;
                  const info = getCreationImageInfo(creation);
                  if (info) creations.push(info);
                }
              }
            }
          }
        } catch (_) {
          // 忽略解析失败
        }
      }
    }
  } else if (data.event_data) {
    let eventData;
    try {
      eventData = typeof data.event_data === 'string' ? JSON.parse(data.event_data) : data.event_data;
    } catch (_) {
      return images;
    }
    if (!eventData || !eventData.message || !eventData.message.content) return images;

    let messageContent;
    try {
      messageContent =
        typeof eventData.message.content === 'string'
          ? JSON.parse(eventData.message.content)
          : eventData.message.content;
    } catch (_) {
      return images;
    }
    if (!messageContent || !Array.isArray(messageContent.creations)) return images;
    for (const creation of messageContent.creations) {
      if (creation && creation.video) continue;
      const info = getCreationImageInfo(creation);
      if (info) creations.push(info);
    }
  }

  for (const info of creations) {
    images.push(info);
  }
  return images;
}

/**
 * 从 /im/chain/single 的完整 JSON 响应中提取图片。
 * 路径：downlink_body.pull_singe_chain_downlink_body.messages[].content_block[]
 */
function parseChainSingleResponse(json, existingUrls = new Set()) {
  const newImages = [];
  if (!json || typeof json !== 'object') return newImages;

  const messages =
    json.downlink_body &&
    json.downlink_body.pull_singe_chain_downlink_body &&
    Array.isArray(json.downlink_body.pull_singe_chain_downlink_body.messages)
      ? json.downlink_body.pull_singe_chain_downlink_body.messages
      : [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const blocks = message.content_block;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      for (const creation of getDoubaoBlockCreations(block)) {
        if (creation && creation.video) continue;
        const info = getCreationImageInfo(creation);
        if (!info || existingUrls.has(info.url)) continue;
        existingUrls.add(info.url);
        newImages.push(info);
      }
    }
  }

  return newImages;
}

/**
 * 判断给定 URL 是否属于豆包生图相关接口。
 */
function isDoubaoGenerationApi(url) {
  if (!isHttpUrl(url)) return false;
  return (
    url.includes('/chat/completion') ||
    url.includes('/im/chain/single') ||
    url.includes('/creativity/canvas_workspace/doc/get')
  );
}

module.exports = {
  DOUBAO_ORIGIN,
  isHttpUrl,
  normalizeImageUrl,
  getCreationImageInfo,
  getDoubaoBlockCreations,
  collectImagesFromValue,
  parseEventStreamText,
  parseStreamChunkData,
  parseChainSingleResponse,
  isDoubaoGenerationApi,
};
