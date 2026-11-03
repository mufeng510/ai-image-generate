/**
 * validate-extractor.js
 *
 * 对 image-extractor.js 使用合成数据（模拟豆包真实响应结构）做离线验证。
 * 不涉及网络，不需要登录凭据。
 *
 * 运行：node src/validate-extractor.js
 */

'use strict';

const assert = require('assert');
const {
  getCreationImageInfo,
  getDoubaoBlockCreations,
  collectImagesFromValue,
  parseEventStreamText,
  parseStreamChunkData,
  parseChainSingleResponse,
  normalizeImageUrl,
  isDoubaoGenerationApi,
} = require('./image-extractor');

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

// ---------- normalizeImageUrl ----------
ok('normalizeImageUrl 把 &amp; 还原为 &', () => {
  eq(normalizeImageUrl('https://x.com/a?p=1&amp;q=2'), 'https://x.com/a?p=1&q=2');
  eq(normalizeImageUrl('https://x.com/a'), 'https://x.com/a');
  eq(normalizeImageUrl(''), '');
});

// ---------- getCreationImageInfo ----------
ok('getCreationImageInfo 从 image_ori_raw 对象提取', () => {
  const info = getCreationImageInfo({
    image: { image_ori_raw: { url: 'https://cdn.example.com/img.png', width: 1024, height: 768 } },
  });
  eq(info, { url: 'https://cdn.example.com/img.png', width: 1024, height: 768 });
});

ok('getCreationImageInfo 字符串形式的 image_ori_raw', () => {
  const info = getCreationImageInfo({
    image: { image_ori_raw: 'https://cdn.example.com/img.webp' },
  });
  eq(info, { url: 'https://cdn.example.com/img.webp', width: 0, height: 0 });
});

ok('getCreationImageInfo 非图片 creation 返回 null', () => {
  eq(getCreationImageInfo({ video: {} }), null);
  eq(getCreationImageInfo({}), null);
  eq(getCreationImageInfo(null), null);
});

// ---------- getDoubaoBlockCreations ----------
ok('getDoubaoBlockCreations 从 creation_block 提取', () => {
  const creations = getDoubaoBlockCreations({
    content_v2: {
      creation_block: {
        creations: [
          { image: { image_ori_raw: { url: 'https://a.com/1.png' } } },
          { image: { image_ori_raw: { url: 'https://a.com/2.png' } } },
        ],
      },
    },
  });
  eq(creations.length, 2);
});

ok('getDoubaoBlockCreations 从 rich_media_layout_block.media 提取', () => {
  const creations = getDoubaoBlockCreations({
    content: {
      rich_media_layout_block: {
        media: [
          { creation: { image: { image_ori_raw: { url: 'https://a.com/3.png' } } } },
          { creation: { video: {} } },
        ],
      },
    },
  });
  eq(creations.length, 2);
  eq(creations[1].video, {});
});

ok('getDoubaoBlockCreations 空内容返回 []', () => {
  eq(getDoubaoBlockCreations({}).length, 0);
  eq(getDoubaoBlockCreations(null).length, 0);
});

// ---------- parseStreamChunkData ----------
ok('parseStreamChunkData patch_op 形态提取图片', () => {
  const images = parseStreamChunkData({
    patch_op: [
      {
        patch_value: {
          content_block: [
            {
              content_v2: {
                creation_block: {
                  creations: [
                    { image: { image_ori_raw: { url: 'https://a.com/sse-1.png' } } },
                  ],
                },
              },
            },
          ],
        },
      },
    ],
  });
  eq(images.length, 1);
  eq(images[0].url, 'https://a.com/sse-1.png');
});

ok('parseStreamChunkData event_data 形态提取图片', () => {
  const images = parseStreamChunkData({
    event_data: JSON.stringify({
      message: {
        content: JSON.stringify({
          creations: [
            { image: { image_ori_raw: { url: 'https://a.com/sse-2.png' } } },
          ],
        }),
      },
    }),
  });
  eq(images.length, 1);
  eq(images[0].url, 'https://a.com/sse-2.png');
});

ok('parseStreamChunkData 非图片创建被跳过', () => {
  const images = parseStreamChunkData({
    patch_op: [
      {
        patch_value: {
          content_block: [
            {
              content: {
                creation_block: {
                  creations: [{ video: {} }],
                },
              },
            },
          ],
        },
      },
    ],
  });
  eq(images.length, 0);
});

// ---------- parseEventStreamText ----------
ok('parseEventStreamText 逐行提取 data: 中的 image_ori', () => {
  const seen = new Set();
  const data1 = {
    event_data: JSON.stringify({
      message: { content: { creations: [{ image: { image_ori_raw: { url: 'https://a.com/sse-3.png' } } }] } },
    }),
  };
  const data2 = {
    patch_op: [
      {
        patch_value: {
          content_block: [
            {
              content_v2: {
                creation_block: {
                  creations: [{ image: { image_ori_raw: { url: 'https://a.com/sse-4.png' } } }],
                },
              },
            },
          ],
        },
      },
    ],
  };
  const sse = [
    `data: ${JSON.stringify(data1)}`,
    `data: ${JSON.stringify(data2)}`,
    ': comment line (no data: prefix)',
    'data: {"other":"no image"}',
  ].join('\n');
  const imgs = parseEventStreamText(sse, seen);
  eq(imgs.length, 2);
  eq(imgs.map((i) => i.url).sort(), ['https://a.com/sse-3.png', 'https://a.com/sse-4.png'].sort());
});

ok('parseEventStreamText 去重已见 URL', () => {
  const seen = new Set(['https://a.com/dup.png']);
  const sse =
    'data: {"patch_op":[{"patch_value":{"content_block":[{"content":{"creation_block":{"creations":[{"image":{"image_ori_raw":{"url":"https://a.com/dup.png"}}}}]}}]}]}\n';
  const imgs = parseEventStreamText(sse, seen);
  eq(imgs.length, 0);
});

// ---------- parseChainSingleResponse ----------
ok('parseChainSingleResponse 从 downlink_body.messages 提取', () => {
  const seen = new Set();
  const json = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            content_block: [
              {
                content: {
                  creation_block: {
                    creations: [
                      { image: { image_ori_raw: { url: 'https://a.com/chain-1.png' } } },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  };
  const imgs = parseChainSingleResponse(json, seen);
  eq(imgs.length, 1);
  eq(imgs[0].url, 'https://a.com/chain-1.png');
});

// ---------- collectImagesFromValue ----------
ok('collectImagesFromValue 递归遍历未知结构', () => {
  const images = [];
  const creation = {
    image: { image_ori_raw: { url: 'https://a.com/recursive.png' } },
  };
  const block = { content_v2: { creation_block: { creations: [creation] } } };
  const message = { content_block: [block] };
  const data = {
    data: { message_snapshot: { message_list: [message] } },
  };
  collectImagesFromValue(data, images);
  eq(images.length, 1);
  eq(images[0].url, 'https://a.com/recursive.png');
});

// ---------- isDoubaoGenerationApi ----------
ok('isDoubaoGenerationApi 识别生图接口', () => {
  assert.strictEqual(isDoubaoGenerationApi('https://www.doubao.com/chat/completion'), true);
  assert.strictEqual(isDoubaoGenerationApi('https://www.doubao.com/im/chain/single'), true);
  assert.strictEqual(
    isDoubaoGenerationApi('https://www.doubao.com/creativity/canvas_workspace/doc/get'),
    true
  );
  assert.strictEqual(isDoubaoGenerationApi('https://www.doubao.com/other/api'), false);
  assert.strictEqual(isDoubaoGenerationApi('not-a-url'), false);
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
