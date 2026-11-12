/**
 * sidecar/src/deleter.test.js
 *
 * 自动删除豆包会话逻辑的离线回归测试（node src/deleter.test.js）。
 *
 * 用 headless Chromium + 本地 HTML 夹具（不访问真实豆包页面）模拟：
 *   - 正常流程：打开右上角 ⋯ →「删除」→ 确认框点红色「删除」→ 侧边栏条目被移除；
 *   - 菜单里没有「删除」：不点任何危险项，ok:false + reason，条目保留；
 *   - 当前页不是会话详情页（URL 无 /chat/<id>）：直接跳过。
 *
 * 浏览器来自仓库 runtime/ms-playwright（或通过 PLAYWRIGHT_BROWSERS_PATH 指定）；
 * 找不到浏览器时跳过（exit 0）而不是失败，避免拖垮离线校验。
 */

'use strict';

const path = require('path');
const fs = require('fs');

// 默认指向仓库内置运行时（若已通过环境变量指定则尊重之）
try {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const repo = path.join(__dirname, '..', '..', 'runtime', 'ms-playwright');
    if (fs.existsSync(repo)) process.env.PLAYWRIGHT_BROWSERS_PATH = repo;
  }
} catch (_) { /* 忽略探测失败 */ }

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (err) {
  console.log('SKIP deleter.test.js: playwright 未安装');
  process.exit(0);
}

const { chatIdFromUrl, deleteCurrentConversation } = require('./deleter');

const FIXTURE_ROOT = path.join(__dirname, '..', 'test', 'fixtures');
const TO_FILE_URL = (...parts) => 'file:///' + path.join(FIXTURE_ROOT, ...parts).split(path.sep).join('/');

let passed = 0;
let failed = 0;

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

(async () => {
  // 纯函数单测
  console.log('deleter URL 解析测试');
  const cases = [
    ['https://www.doubao.com/chat/38452124429268482', '38452124429268482'],
    ['https://www.doubao.com/chat/38452124429268482?from=sidebar', '38452124429268482'],
    ['https://www.doubao.com/chat/38452124429268482#x', '38452124429268482'],
    ['https://www.doubao.com/chat/', null],
    ['https://www.doubao.com/chat/abc', null],
    ['https://www.doubao.com/', null],
    ['', null],
  ];
  for (const [input, expected] of cases) {
    const actual = chatIdFromUrl(input);
    if (actual === expected) { passed++; } else { failed++; console.error(`  ✗ chatIdFromUrl(${JSON.stringify(input)}): expected ${expected}, got ${actual}`); }
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chromium' });
  } catch (err) {
    console.log('SKIP deleter 浏览器夹具测试: 无法启动 Chromium -', err.message);
    console.log(`删除会话测试结果: ${passed} 通过, ${failed} 失败`);
    process.exit(failed === 0 ? 0 : 1);
  }

  const page = await browser.newPage();

  await test('正常流程：打开 ⋯ → 删除 → 确认删除，条目被移除', async () => {
    await page.goto(TO_FILE_URL('delete-conversation', 'chat', '123456789', 'index.html'));
    const res = await deleteCurrentConversation(page);
    if (!res.ok) throw new Error('expected ok, got reason: ' + res.reason);
    if (res.chat_id !== '123456789') throw new Error('wrong chat_id: ' + res.chat_id);
    const remaining = await page.locator('a#conversation_123456789').count();
    if (remaining !== 0) throw new Error('sidecar item still present after delete');
  });

  await test('菜单无「删除」：不误点、ok:false、条目保留', async () => {
    await page.goto(TO_FILE_URL('delete-conversation-no-delete', 'chat', '223456789', 'index.html'));
    const res = await deleteCurrentConversation(page);
    if (res.ok) throw new Error('expected ok:false, got ok:true');
    if (res.reason !== 'delete_menuitem_not_found') throw new Error('unexpected reason: ' + res.reason);
    const remaining = await page.locator('a#conversation_223456789').count();
    if (remaining !== 1) throw new Error('sidecar item was changed unexpectedly');
  });

  await test('非会话详情页：直接跳过，ok:false', async () => {
    await page.goto(TO_FILE_URL('delete-conversation-no-delete', 'plain.html'));
    const res = await deleteCurrentConversation(page);
    if (res.ok) throw new Error('expected ok:false');
    if (res.reason !== 'not_chat_detail') throw new Error('unexpected reason: ' + res.reason);
  });

  await browser.close();

  console.log(`删除会话测试结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
