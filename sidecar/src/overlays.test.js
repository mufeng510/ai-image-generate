/**
 * sidecar/src/overlays.test.js
 *
 * 遮罩/弹窗自动关闭逻辑的离线回归测试（node src/overlays.test.js）。
 *
 * 用 headless Chromium + 本地 HTML 夹具（不访问真实豆包页面）模拟豆包 fresh 档案
 * 的「下载电脑版 使用完整功能」推广弹窗（role=dialog、全视口固定定位、关闭按钮
 * aria-label="关闭"），验证：
 *   - hasVisibleOverlay 能识别该弹窗；
 *   - dismissPageOverlays 能点击关闭按钮关闭它；
 *   - 弹窗晚于 hydration 出现（延迟 600ms 注入）时，waitAndDismissOverlays 仍能关闭；
 *   - 干净页面 dismiss 为空操作。
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
  console.log('SKIP overlays.test.js: playwright 未安装');
  process.exit(0);
}

const {
  hasVisibleOverlay,
  dismissPageOverlays,
  waitAndDismissOverlays,
  setLogger,
} = require('./overlays');

const logs = [];
setLogger((level, msg) => logs.push(`${level}: ${msg}`));

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

/** 与豆包 fresh 档案推广弹窗同构的夹具：全视口定位的 role=dialog + aria-label=关闭 的关闭按钮 */
const PROMO_DIALOG_HTML = `
<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head>
<body>
  <div id="app"><textarea placeholder="发消息..."></textarea></div>
  <div id="promo" role="dialog" aria-modal="true" aria-labelledby="promo-title"
       style="position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.45);">
    <div style="position:absolute; top: 20%; left: 30%; width: 480px; height: 300px; background: #fff; border-radius: 12px;">
      <h2 id="promo-title">下载电脑版 使用完整功能</h2>
      <button id="promo-close" aria-label="关闭"
              style="position:absolute; top:12px; right:12px; width:40px; height:40px; border-radius:50%; border:0; cursor:pointer;">✕</button>
    </div>
  </div>
  <script>
    document.getElementById('promo-close').addEventListener('click', () => {
      const el = document.getElementById('promo');
      if (el) el.remove();
    });
  </script>
</body></html>`;

/** 弹窗晚于 hydration 出现的夹具（600ms 后注入）——复现单次 dismiss 时弹窗还没出现的时序 */
const LATE_PROMO_HTML = `
<!doctype html><html><head><meta charset="utf-8"><title>fixture-late</title></head>
<body>
  <div id="app"><textarea placeholder="发消息..."></textarea></div>
  <script>
    setTimeout(() => {
      const promo = document.createElement('div');
      promo.id = 'promo';
      promo.setAttribute('role', 'dialog');
      promo.setAttribute('aria-modal', 'true');
      promo.setAttribute('aria-labelledby', 'promo-title');
      promo.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.45)';
      promo.innerHTML = '<div style="position:absolute;top:20%;left:30%;width:480px;height:300px;background:#fff;border-radius:12px">'
        + '<h2 id="promo-title">下载电脑版 使用完整功能</h2>'
        + '<button id="promo-close" aria-label="关闭" style="position:absolute;top:12px;right:12px;width:40px;height:40px;border-radius:50%;border:0;cursor:pointer">✕</button>'
        + '</div>';
      document.body.appendChild(promo);
      document.getElementById('promo-close').addEventListener('click', () => promo.remove());
    }, 600);
  </script>
</body></html>`;

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.log('SKIP overlays.test.js: 无法启动内置 Chromium：' + (err && err.message ? err.message : String(err)));
    process.exit(0);
  }

  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    await test('hasVisibleOverlay 识别推广弹窗，干净页不误判', async () => {
      await page.setContent(PROMO_DIALOG_HTML, { waitUntil: 'domcontentloaded' });
      const visible = await hasVisibleOverlay(page);
      if (!visible) throw new Error('应识别到可见遮罩，实际未识别');
      await page.setContent('<!doctype html><html><body><p>clean</p></body></html>', { waitUntil: 'domcontentloaded' });
      const clean = await hasVisibleOverlay(page);
      if (clean) throw new Error('干净页不应被判定为有遮罩');
    });

    await test('dismissPageOverlays 通过关闭按钮关闭推广弹窗', async () => {
      await page.setContent(PROMO_DIALOG_HTML, { waitUntil: 'domcontentloaded' });
      const dismissed = await dismissPageOverlays(page);
      if (dismissed < 1) throw new Error(`期望至少关闭 1 个弹窗，实际 ${dismissed}`);
      const stillThere = await page.locator('#promo').count();
      if (stillThere !== 0) throw new Error('弹窗应已从 DOM 移除');
    });

    await test('waitAndDismissOverlays 处理晚于 hydration 出现的弹窗', async () => {
      await page.setContent(LATE_PROMO_HTML, { waitUntil: 'domcontentloaded' });
      // 弹窗 600ms 后出现；wait 窗口内必须被关掉
      const dismissed = await waitAndDismissOverlays(page, { timeoutMs: 8000, stableMs: 800, intervalMs: 150 });
      if (dismissed < 1) throw new Error(`期望至少关闭 1 个弹窗，实际 ${dismissed}`);
      const remaining = await hasVisibleOverlay(page);
      if (remaining) throw new Error('弹窗仍可见');
    });

    await test('干净页 waitAndDismissOverlays 快速返回 0', async () => {
      await page.setContent('<!doctype html><html><body><textarea></textarea></body></html>', { waitUntil: 'domcontentloaded' });
      const t0 = Date.now();
      const dismissed = await waitAndDismissOverlays(page, { timeoutMs: 4000, stableMs: 600, intervalMs: 150 });
      const ms = Date.now() - t0;
      if (dismissed !== 0) throw new Error(`干净页不应关闭任何弹窗，实际 ${dismissed}`);
      if (ms > 3500) throw new Error(`干净页应快速返回（${ms}ms 过长）`);
    });

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('overlays.test.js 执行失败:', err);
  process.exit(1);
});
