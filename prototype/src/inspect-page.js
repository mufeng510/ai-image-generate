/**
 * inspect-page.js
 *
 * Phase 1 原型：仅验证可在无登录凭据下完成的项。
 *   - 启动可见 Chromium（持久化上下文）
 *   - 打开豆包对话页，观察页面是否正常加载
 *   - 判断是否落在登录页（需凭据后续操作）
 *   - 保存截图与 HTML 用于诊断
 *   - 报告页面上可见的表单/按钮元素数量（供后续实测参考）
 *
 * 运行：npx playwright install chromium 后，再 node src/inspect-page.js
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, '..', '.userdata', 'inspect-default');
const TARGET_URL = 'https://www.doubao.com/chat/';

async function main() {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const outDir = path.join(__dirname, '..', '.output', 'inspect');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('[检查] 启动可见 Chromium...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  console.log(`[检查] 导航至 ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const title = await page.title().catch(() => '(未知)');
  const url = page.url();
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const likelyLogin =
    /登录|登入|sign in|login|账号|密码/i.test(bodyText) || /login/i.test(url);

  console.log(`[检查] 标题: ${title}`);
  console.log(`[检查] URL: ${url}`);
  console.log(`[检查] 是否登录页: ${likelyLogin ? '是（需凭据后续操作）' : '否'}`);

  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  await page.screenshot({ path: path.join(outDir, `inspect_${stamp}.png`), fullPage: true });
  fs.writeFileSync(path.join(outDir, `inspect_${stamp}.html`), await page.content(), 'utf-8');
  console.log(`[检查] 截图/HTML 已保存至 ${outDir}`);

  // 统计常见元素（供后续选择器实测参考）
  for (const sel of ['input[type="file"]', 'textarea', 'button', '[data-testid]']) {
    try {
      const n = await page.locator(sel).count();
      if (n > 0) console.log(`[检查] "${sel}": ${n} 个`);
    } catch (_) {}
  }

  if (likelyLogin) {
    console.log('\n[结论] 浏览器成功启动并加载豆包页面，但停留在登录页。');
    console.log('[结论] 登录、上传、生图、下载等环节需真实豆包账号凭据后续验证。');
  } else {
    console.log('\n[结论] 页面已进入主内容区，可继续后续自动化步骤。');
  }

  // 保持打开供观察，除非设置 CLOSE_ON_EXIT=true
  if (process.env.CLOSE_ON_EXIT === 'true') {
    await context.close();
    console.log('[检查] 浏览器已关闭');
  } else {
    console.log('[检查] 浏览器保持打开（CLOSE_ON_EXIT=true 可自动关闭）');
  }
}

main().catch((err) => {
  console.error('[检查] 失败:', err);
  process.exit(1);
});
