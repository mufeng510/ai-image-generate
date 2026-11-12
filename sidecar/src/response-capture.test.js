/**
 * sidecar/src/response-capture.test.js
 *
 * 网络拦截（/chat/completion EventStream + /im/chain/single 消息链快照）解析与接线的离线测试。
 * 不访问真实豆包页面：网络响应用 Playwright route fulfill 模拟。
 * 部分用例用无头 Chromium（仓库 runtime/ms-playwright 或 PLAYWRIGHT_BROWSERS_PATH），
 * 找不到浏览器时接线用例跳过（不拖垮校验），纯解析用例始终执行。
 *
 * 数据形态依据 ihmily/doubao-nomark 扩展（MIT）的解析实现 + doubao_parser 实证：
 *   creation.image.image_ori_raw = { url, width, height }，无水印原图直链（/rc_gen_image/ … image_raw …）。
 */

'use strict';

const path = require('path');
const fs = require('fs');

try {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const repo = path.join(__dirname, '..', '..', 'runtime', 'ms-playwright');
    if (fs.existsSync(repo)) process.env.PLAYWRIGHT_BROWSERS_PATH = repo;
  }
} catch (_) { /* 忽略探测失败 */ }

const {
  installResponseCapture,
  getCapturedImages,
  clearCaptured,
  addCreations,
  imageFromCreation,
  isOriginalGenUrl,
  extractFromCompletionStreamBody,
  extractFromChainSingleBody,
} = require('./response-capture');

let passed = 0;
let failed = 0;
const logs = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'value'} mismatch: actual=${actual} expected=${expected}`);
  }
}

/** 构造一个 creation（image_ori_raw 原图数据在 rc_gen_image 下，image_raw rendition） */
function makeCreation(fileBase, { ext = 'png', rendition = 'image_raw_hflow', width = 1536, height = 1024, key = '' } = {}) {
  return {
    image: {
      key: key || `tos-cn-i-a9rns2rl98/${fileBase}.jpeg`,
      image_ori_raw: {
        url: `https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/${fileBase}.jpeg~tplv-a9rns2rl98-${rendition}:SEVD.${ext}?lk3s=8e244e95&rcl=20261111&rrcfp=755f3169&x-signature=%2Fde%3D`,
        width,
        height,
      },
      image_ori: { url: `https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/${fileBase}.jpeg~tplv-a9rns2rl98-image-qvalue.png?lk3s=a` },
      image_thumb: { url: `https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/${fileBase}.jpeg~tplv-a9rns2rl98-cthumb_dwm3.png?lk3s=b` },
    },
  };
}

(async () => {
  console.log('response-capture 网络拦截测试');

  // ---------- isOriginalGenUrl ----------
  await test('isOriginalGenUrl：image_raw 保留，cgen/cthumb/qvalue 过滤', async () => {
    assertEqual(isOriginalGenUrl('https://x/tos-cn-i-a9rns2rl98/rc_gen_image/a.jpeg~tplv-a9rns2rl98-image_raw_hflow:SEVD.png?q=1'), true, 'raw');
    assertEqual(isOriginalGenUrl('https://x/tos-cn-i-a9rns2rl98/rc_gen_image/a.jpeg~tplv-a9rns2rl98-cgen_lwm3.png?q=1'), false, 'cgen');
    assertEqual(isOriginalGenUrl('https://x/tos-cn-i-a9rns2rl98/rc_gen_image/a.jpeg~tplv-a9rns2rl98-cthumb_dwm3.png?q=1'), false, 'cthumb');
    assertEqual(isOriginalGenUrl('https://x/tos-cn-i-a9rns2rl98/other/a.jpeg~tplv-a9rns2rl98-image_raw_hflow:SEVD.png'), false, '非 rc_gen_image');
  });

  // ---------- EventStream 解析（patch_op，content 为对象/JSON 字符串两种形态） ----------
  const creationA = makeCreation('aaaa0001', { ext: 'png' });
  const creationAHeic = makeCreation('aaaa0001', { ext: 'heic' });
  const creationB = makeCreation('bbbb0002', { ext: 'jpeg' });
  const patchLineObj = JSON.stringify({
    patch_op: [{ patch_value: { content_block: [{ content: { creation_block: { creations: [creationA, creationAHeic] } } }] } }],
  });
  const patchLineStr = JSON.stringify({
    patch_op: [{ patch_value: { content_block: [{ content: JSON.stringify({ creation_block: { creations: [creationB] } }) }] } }],
  });
  const junkLines = ['event: ping', 'data: [DONE]', 'data: {"unrelated":1}', 'data: {broken json', 'data: {}'].join('\n');

  await test('extractFromCompletionStreamBody：解析 patch_op（content 对象形态）', async () => {
    const creations = extractFromCompletionStreamBody(`data: ${patchLineObj}\n`);
    assertEqual(creations.length, 2, 'creations 数量');
    assertEqual(creations[0].image.image_ori_raw.url.includes('image_raw_hflow'), true, 'image_ori_raw 字段存在');
  });

  await test('extractFromCompletionStreamBody：解析 patch_op（content 为 JSON 字符串形态）', async () => {
    const creations = extractFromCompletionStreamBody(`data: ${patchLineStr}\n`);
    assertEqual(creations.length, 1, 'creations 数量');
  });

  await test('extractFromCompletionStreamBody：junk/[DONE]/坏 JSON 行不抛错且不解析出 creations', async () => {
    const creations = extractFromCompletionStreamBody(junkLines);
    assertEqual(creations.length, 0, 'creations 数量');
  });

  // ---------- EventStream 解析（event_data 旧格式） ----------
  await test('extractFromCompletionStreamBody：解析 event_data（message.content 为 JSON 字符串）', async () => {
    const inner = JSON.stringify({ creations: [creationB] });
    const eventData = JSON.stringify({ message: { content: inner } });
    const line = JSON.stringify({ event_data: eventData });
    const creations = extractFromCompletionStreamBody(`data: ${line}\n`);
    assertEqual(creations.length, 1, 'creations 数量');
    assertEqual(creations[0].image.image_ori_raw.url.includes('bbbb0002'), true, '正确取到 creation');
  });

  // ---------- rich_media_layout_block（画布/富文本形态） ----------
  await test('extractFromCompletionStreamBody：rich_media_layout_block.media[].creation 形态', async () => {
    const rich = { rich_media_layout_block: { media: [{ creation: creationA }] } };
    const line = JSON.stringify({ patch_op: [{ patch_value: { content_block: [{ content: rich }] } }] });
    const creations = extractFromCompletionStreamBody(`data: ${line}\n`);
    assertEqual(creations.length, 1, 'creations 数量');
  });

  // ---------- content_v2 优先于 content ----------
  await test('creationsFromBlock：content_v2 优先于 content', async () => {
    const v2 = { creation_block: { creations: [creationA] } };
    const v1 = { creation_block: { creations: [creationB] } };
    const line = JSON.stringify({ patch_op: [{ patch_value: { content_block: [{ content: v1, content_v2: v2 }] } }] });
    const creations = extractFromCompletionStreamBody(`data: ${line}\n`);
    assertEqual(creations.length, 1, 'creations 数量');
    assertEqual(creations[0].image.image_ori_raw.url.includes('aaaa0001'), true, '取自 content_v2');
  });

  // ---------- /im/chain/single 解析 ----------
  const chainBody = JSON.stringify({
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          { content_block: [{ content: { creation_block: { creations: [creationA] } } }] },
          { content_block: [{ content_v2: JSON.stringify({ rich_media_layout_block: { media: [{ creation: creationB }] } }) }] },
        ],
      },
    },
  });

  await test('extractFromChainSingleBody：消息链快照（content 对象 + content_v2 字符串两种）', async () => {
    const creations = extractFromChainSingleBody(chainBody);
    assertEqual(creations.length, 2, 'creations 数量');
  });

  await test('extractFromChainSingleBody：非标准结构返回空数组不抛错', async () => {
    assertEqual(extractFromChainSingleBody('{}').length, 0, '空对象');
    assertEqual(extractFromChainSingleBody('not json').length, 0, '非 JSON');
    assertEqual(extractFromChainSingleBody('{"downlink_body":{}}').length, 0, '缺 messages');
  });

  // ---------- 原图过滤与去重（写入 page 缓存） ----------
  await test('addCreations/getCapturedImages：过滤非原图片段、同底图 PNG 优先、跨响应按 identity 去重', async () => {
    const page = {}; // WeakMap key 仅需对象引用
    // 1) 先写入 heic，再写入 png（应被 png 覆盖）
    addCreations(page, [creationAHeic]);
    addCreations(page, [creationA]);
    // 2) 写入 cgen 水印 rendition 版 image_ori_raw（应被过滤）
    const watermarked = {
      image: {
        key: 'tos-cn-i-a9rns2rl98/wm000999.jpeg',
        image_ori_raw: {
          url: 'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/wm000999.jpeg~tplv-a9rns2rl98-cgen_dwm3.png?lk3s=x',
          width: 1536, height: 1024,
        },
      },
    };
    addCreations(page, [watermarked]);
    // 3) chain/single 再送同一文件（签名不同，identity 相同 → 不重复）
    addCreations(page, [creationA]);

    const images = getCapturedImages(page);
    assertEqual(images.length, 1, '去重后仅 1 张');
    assertEqual(/\.png(?:[?~]|$)/i.test(images[0].url), true, 'PNG 变体胜出');
    assertEqual(images[0].identity.includes('aaaa0001'), true, 'identity 含底图文件名');
    assertEqual(images[0].width, 1536, '宽度透传');
    clearCaptured(page);
    assertEqual(getCapturedImages(page).length, 0, 'clearCaptured 生效');
  });

  await test('imageFromCreation：视频创建（无 image）被跳过、空 creation 安全', async () => {
    assertEqual(imageFromCreation({ video: { vid: 'v1' } }), null, '视频创建');
    assertEqual(imageFromCreation(null), null, 'null');
    assertEqual(imageFromCreation({}), null, '空对象');
    assertEqual(imageFromCreation({ image: {} }), null, '无 image_ori_raw');
  });

  // ---------- 无头 Chromium 接线测试（无浏览器时跳过） ----------
  let chromium = null;
  try { ({ chromium } = require('playwright')); } catch (_) { chromium = null; }

  if (!chromium) {
    console.log('  - 跳过接线测试：playwright 未安装');
  } else {
    const STREAM_BODY = [
      `data: ${JSON.stringify({ patch_op: [{ patch_value: { content_block: [{ content: { creation_block: { creations: [makeCreation('wire0003')] } } }] } }] })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    const CHAIN_BODY = JSON.stringify({
      downlink_body: {
        pull_singe_chain_downlink_body: {
          messages: [{ content_block: [{ content: { creation_block: { creations: [makeCreation('wire0004')] } } }] }],
        },
      },
    });

    await test('installResponseCapture：headless Chromium 拦截 chat/completion 与 im/chain/single', async () => {
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      try {
        const ctx = await browser.newContext();
        await ctx.route('**/test-fixture', (route) =>
          route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>fixture</body></html>' }));
        await ctx.route('**/chat/completion', (route) =>
          route.fulfill({ contentType: 'text/event-stream', body: STREAM_BODY }));
        await ctx.route('**/im/chain/single', (route) =>
          route.fulfill({ contentType: 'application/json', body: CHAIN_BODY }));
        const page = await ctx.newPage();
        installResponseCapture(page, (level, msg) => logs.push(`${level}: ${msg}`));
        await page.goto('https://local-fixture/test-fixture');
        await page.evaluate(async () => {
          await fetch('/chat/completion').then((r) => r.text());
          await fetch('/im/chain/single').then((r) => r.text());
        });
        // body 读取与缓存写入为异步 .then，轮询等待
        for (let i = 0; i < 40 && getCapturedImages(page).length < 2; i += 1) {
          await page.waitForTimeout(50);
        }
        const images = getCapturedImages(page);
        assertEqual(images.length, 2, '拦截到两条响应中的原图');
        if (!images.some((img) => img.identity.includes('wire0003'))) throw new Error('缺少 chat/completion 原图');
        if (!images.some((img) => img.identity.includes('wire0004'))) throw new Error('缺少 im/chain/single 原图');
      } finally {
        await browser.close();
      }
    });
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
