/**
 * sidecar/src/extractor.test.js
 *
 * DOM 兜底提取的去重逻辑离线单元测试（node src/extractor.test.js）。
 * 覆盖豆包页面「每个生成图渲染两个 <img>（src / currentSrc 分别指向 cthumb 缩略图与 cgen 高清图）」的实测形态
 * （task #17 输出 10 张中 5 张缩略图的事故；src 与 currentSrc 经常落在不同 CDN 域）。
 */

'use strict';

const { generatedImageKey, dedupeGeneratedImages } = require('./extractor');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'expected'} mismatch: actual=${actual} expected=${expected}`);
  }
}

// task #17 实测下载的 10 个 URL（5 张生成图 × cthumb 缩略图 + cgen 高清图，src 与 currentSrc 跨 CDN 域）
const TASK17_URLS = [
  { url: 'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/b9bfaa45311148e0b1c37408db6e699c.jpeg~tplv-a9rns2rl98-cthumb_lwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x1' },
  { url: 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/b9bfaa45311148e0b1c37408db6e699c.jpeg~tplv-a9rns2rl98-cgen_lwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x2' },
  { url: 'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/8772afa5a82f475995ff30e71fd42e15.jpeg~tplv-a9rns2rl98-cthumb_lwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x3' },
  { url: 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/8772afa5a82f475995ff30e71fd42e15.jpeg~tplv-a9rns2rl98-cgen_lwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x4' },
  { url: 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/81660b5f5e5441a4a55222f191b6d743.jpeg~tplv-a9rns2rl98-cthumb_lwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x5' },
  { url: 'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/81660b5f5e5441a4a55222f191b6d743.jpeg~tplv-a9rns2rl98-cgen_lwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x6' },
  { url: 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/1a935da22bb84f5b9d60c2fd31066629.jpeg~tplv-a9rns2rl98-cthumb_lwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x7' },
  { url: 'https://p6-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/1a935da22bb84f5b9d60c2fd31066629.jpeg~tplv-a9rns2rl98-cgen_lwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x8' },
  { url: 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/e6c5a5ad001e4c4ebe77adbacfae9394.jpeg~tplv-a9rns2rl98-cthumb_dwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x9' },
  { url: 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/e6c5a5ad001e4c4ebe77adbacfae9394.jpeg~tplv-a9rns2rl98-cgen_dwm3.png?lk3s=8e244e95&rrcfp=755f3169&x-signature=x10' },
];

(async () => {
  console.log('extractor DOM 兜底去重测试');

  await test('generatedImageKey 忽略 origin、查询串与 ~tplv 缩放后缀', async () => {
    const u = TASK17_URLS[0].url;
    assertEqual(generatedImageKey(u), '/tos-cn-i-a9rns2rl98/rc_gen_image/b9bfaa45311148e0b1c37408db6e699c.jpeg', '底图 key');
    assertEqual(generatedImageKey(TASK17_URLS[1].url), generatedImageKey(u), 'cgen 与 cthumb 同 key（跨 CDN 域）');
  });

  await test('dedupeGeneratedImages：#17 实测 10 个 URL → 5 张，全部为 cgen 高清图', async () => {
    const out = dedupeGeneratedImages(TASK17_URLS);
    assertEqual(out.length, 5, '保留 5 张');
    if (out.some((img) => /cthumb/i.test(img.url))) {
      throw new Error('保留了缩略图，期望全部为 cgen 高清图');
    }
  });

  await test('dedupeGeneratedImages：先出现 cgen 时不被后续 cthumb 覆盖', async () => {
    const out = dedupeGeneratedImages([TASK17_URLS[1], TASK17_URLS[0]]);
    assertEqual(out.length, 1, '同 key 坍缩为 1 张');
    if (/cthumb/i.test(out[0].url)) throw new Error('cthumb 覆盖了 cgen');
  });

  await test('dedupeGeneratedImages：无缩放后缀的 URL 原样保留且完全相同的 URL 去重', async () => {
    const out = dedupeGeneratedImages([
      { url: 'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/aaa' },
      { url: 'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/bbb' },
      { url: 'https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/aaa' },
    ]);
    assertEqual(out.length, 2, '完全相同的 URL 去重、不同底图各保留');
  });

  await test('dedupeGeneratedImages：保持首次出现顺序', async () => {
    const out = dedupeGeneratedImages([TASK17_URLS[2], TASK17_URLS[0], TASK17_URLS[4]]); // thumb2, thumb1, thumb3
    const keys = out.map((img) => generatedImageKey(img.url));
    assertEqual(keys[0].includes('8772af'), true, '第一个保留 8772af');
    assertEqual(keys[1].includes('b9bfaa'), true, '第二个保留 b9bfaa');
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    process.exit(1);
  }
})();
