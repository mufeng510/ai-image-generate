/**
 * doubao-automation.js
 *
 * Phase 1 最小可行性原型：基于 Playwright + 持久化 Chromium 上下文，
 * 实现豆包网页自动化核心流程的骨架。
 *
 * 当前可运行部分（无需凭据）：
 *   - 启动可见 Chromium（headless: false）
 *   - 使用独立用户数据目录持久化会话
 *   - 导航至豆包对话页并观察页面/网络结构
 *   - 拦截 /chat/completion EventStream，提取 image_ori_raw 原图 URL
 *   - 下载并校验图片（格式/大小/SHA-256）
 *
 * 需真实豆包登录凭据才能继续的部分（标记 [需凭据]）：
 *   - 登录豆包
 *   - 上传 5 张参考图片
 *   - 输入提示词并设置生图参数
 *   - 提交生成任务
 *   - 识别生成完成并下载全部图片
 */

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const {
  parseEventStreamText,
  parseChainSingleResponse,
  isDoubaoGenerationApi,
  DOUBAO_ORIGIN,
} = require('./image-extractor');
const { downloadBatch, MIN_FILE_SIZE, MAX_FILE_SIZE } = require('./downloader');

const DEFAULT_USER_DATA_DIR = path.join(__dirname, '..', '.userdata', 'doubao-default');
const TARGET_URL = 'https://www.doubao.com/chat/';
const OUTPUT_DIR = path.join(__dirname, '..', '.output', 'rounds');

/**
 * 确保目录存在。
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 持久化图片发现：将新发现的原图 URL 记录到内存集合，并可持久化到 JSON。
 */
class ImageCollector {
  constructor() {
    this.images = []; // { url, width, height, source, discoveredAt }
    this.seenUrls = new Set();
  }

  add(info, source) {
    if (!info || !info.url) return false;
    if (this.seenUrls.has(info.url)) return false;
    this.seenUrls.add(info.url);
    this.images.push({ ...info, source, discoveredAt: new Date().toISOString() });
    return true;
  }

  getAll() {
    return [...this.images];
  }

  count() {
    return this.images.length;
  }

  saveToFile(filePath) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(this.getAll(), null, 2), 'utf-8');
  }
}

/**
 * 创建并启动可见 Chromium 持久化上下文。
 * 每个账号对应一个独立 userDataDir，这里使用默认目录。
 */
async function launchBrowser(userDataDir = DEFAULT_USER_DATA_DIR) {
  ensureDir(userDataDir);
  console.log(`[原型] 启动可见 Chromium，用户数据目录: ${userDataDir}`);

  const browser = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // 必须有界面，任务对用户可见
    channel: 'chromium', // 使用 Playwright 打包的 Chromium
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });

  console.log('[原型] 浏览器已启动（可见模式）');
  return browser;
}

/**
 * 在页面上设置网络响应拦截，捕获生图接口返回并提取原图 URL。
 */
function setupResponseInterceptor(page, collector) {
  page.on('response', async (response) => {
    const url = response.url();
    if (!isDoubaoGenerationApi(url)) return;

    // 只处理成功的 JSON / EventStream 响应
    const status = response.status();
    if (status < 200 || status >= 300) return;

    const contentType = response.headers()['content-type'] || '';
    const isEventStream = contentType.includes('text/event-stream') || url.includes('/chat/completion');
    const isJSON = contentType.includes('application/json');

    if (!isEventStream && !isJSON) return;

    try {
      const text = await response.text();
      if (!text || text.length < 10) return;

      let added = 0;
      if (url.includes('/im/chain/single')) {
        try {
          const json = JSON.parse(text);
          const imgs = parseChainSingleResponse(json, collector.seenUrls);
          for (const img of imgs) collector.add(img, url);
          added = imgs.length;
        } catch (_) {
          // 非纯 JSON，尝试 EventStream 解析
          const imgs = parseEventStreamText(text, collector.seenUrls);
          for (const img of imgs) collector.add(img, url);
          added = imgs.length;
        }
      } else if (isEventStream || url.includes('/chat/completion')) {
        const imgs = parseEventStreamText(text, collector.seenUrls);
        for (const img of imgs) collector.add(img, url);
        added = imgs.length;
      }

      if (added > 0) {
        console.log(`[原型] 从 ${url} 发现 ${added} 张新图片，累计 ${collector.count()} 张`);
      }
    } catch (err) {
      // 响应体读取失败不中断主流程
      console.warn(`[原型] 读取响应体失败 ${url}: ${err.message}`);
    }
  });

  console.log('[原型] 网络响应拦截器已安装（/chat/completion, /im/chain/single）');
}

/**
 * 观察并打印页面结构摘要（无需登录，用于确认页面是否正常加载及登录墙状态）。
 */
async function observePage(page) {
  const title = await page.title().catch(() => '(未知)');
  const url = page.url();
  console.log(`[原型] 页面标题: ${title}`);
  console.log(`[原型] 当前 URL: ${url}`);

  // 检查是否出现登录相关特征
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const likelyLoginPage =
    /登录|登入|sign in|login|账号|密码/i.test(bodyText) ||
    /login/i.test(url);

  if (likelyLoginPage) {
    console.log('[原型] 检测到登录页面（[需凭据]：需在可见浏览器中手动登录后继续）');
  } else {
    console.log('[原型] 页面似乎已进入主内容区（[需凭据]：请确认是否已登录）');
  }

  // 列出页面上常见的生图相关输入/按钮选择器（供后续实测参考）
  const selectors = [
    'textarea, input[type="text"]',
    'input[type="file"]',
    'button',
    '[data-testid]',
  ];
  for (const sel of selectors) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) console.log(`[原型] 选择器 "${sel}" 匹配 ${count} 个元素`);
    } catch (_) {}
  }

  return { title, url, likelyLoginPage, bodyText };
}

/**
 * 保存页面截图与 HTML，用于诊断。
 */
async function saveDiagnostics(page, tag) {
  const dir = path.join(__dirname, '..', '.output', 'diagnostics');
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  const base = path.join(dir, `${tag}_${stamp}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    console.log(`[原型] 截图已保存: ${base}.png`);
  } catch (err) {
    console.warn(`[原型] 截图失败: ${err.message}`);
  }
  try {
    const html = await page.content();
    fs.writeFileSync(`${base}.html`, html, 'utf-8');
    console.log(`[原型] HTML 已保存: ${base}.html`);
  } catch (err) {
    console.warn(`[原型] HTML 保存失败: ${err.message}`);
  }
}

/**
 * 主流程。
 */
async function main() {
  const userDataDir = process.env.DOUBAO_USER_DATA_DIR || DEFAULT_USER_DATA_DIR;
  const headlessEnv = process.env.HEADLESS === 'true';

  ensureDir(OUTPUT_DIR);

  console.log('========================================');
  console.log('豆包批量生图 Phase 1 最小可行性原型');
  console.log('========================================');
  console.log(`用户数据目录: ${userDataDir}`);
  console.log(`目标页面: ${TARGET_URL}`);
  console.log(`输出目录: ${OUTPUT_DIR}`);
  console.log(`有界面模式: ${!headlessEnv}`);
  console.log('========================================\n');

  const browser = await launchBrowser(userDataDir);
  const collector = new ImageCollector();

  let page;
  try {
    const pages = browser.pages();
    page = pages[0] || (await browser.newPage());

    setupResponseInterceptor(page, collector);

    console.log(`[原型] 导航至 ${TARGET_URL} ...`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000); // 等待首屏与网络请求

    const obs = await observePage(page);
    await saveDiagnostics(page, 'after-navigate');

    // 保存已发现的图片（首次运行通常为空，因尚未登录/生图）
    collector.saveToFile(path.join(OUTPUT_DIR, 'discovered-images.json'));

    console.log('\n----------------------------------------');
    console.log('Phase 1 原型运行摘要');
    console.log('----------------------------------------');
    console.log(`浏览器：可见 Chromium（Playwright 持久化上下文）`);
    console.log(`页面状态：${obs.likelyLoginPage ? '登录页（需凭据）' : '主内容页'}`);
    console.log(`发现原图数量：${collector.count()} 张`);
    console.log(`已保存图片清单：${path.join(OUTPUT_DIR, 'discovered-images.json')}`);
    console.log('\n[需凭据] 后续步骤（需在可见浏览器中手动登录后执行）：');
    console.log('  1. 登录豆包（会话持久化于用户数据目录，仅需首次）');
    console.log('  2. 上传 5 张参考图片');
    console.log('  3. 输入提示词、设置生图参数');
    console.log('  4. 提交生成，等待 EventStream 返回 image_ori_raw');
    console.log('  5. 调用 downloadBatch 下载并校验全部图片');
    console.log('----------------------------------------\n');

    // 保持浏览器打开一段时间，方便用户手动操作观察（可通过环境变量控制）
    const keepOpenMs = Number(process.env.KEEP_OPEN_MS || '0');
    if (keepOpenMs > 0) {
      console.log(`[原型] 保持浏览器打开 ${keepOpenMs} ms，供手动观察...`);
      await page.waitForTimeout(keepOpenMs);
    }
  } finally {
    // 默认不自动关闭，以便用户在可见窗口中继续手动登录/观察。
    // 如需自动关闭，设置 CLOSE_ON_EXIT=true
    if (process.env.CLOSE_ON_EXIT === 'true') {
      await browser.close();
      console.log('[原型] 浏览器已关闭');
    } else {
      console.log('[原型] 浏览器保持打开（设置 CLOSE_ON_EXIT=true 可自动关闭）');
    }
  }
}

main().catch((err) => {
  console.error('[原型] 致命错误:', err);
  process.exit(1);
});
