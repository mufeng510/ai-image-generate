/**
 * phase1-e2e.js
 *
 * Phase 1 端到端实测脚本（基于 ihmily/doubao-nomark 油猴脚本核心提取逻辑改写，MIT 许可）。
 *
 * 核心数据源：creation.image.image_ori_raw.url —— 豆包返回的原始无水印图片地址。
 *
 * 支持两种模式（通过环境变量 DOUBAO_MODE 控制，无交互阻塞）：
 *   A - 新生成模式：导航豆包对话页，等你在可见浏览器中上传参考图片、输入提示词、提交生成，
 *       脚本拦截 /chat/completion EventStream，抓取返回的原图 URL 并下载。
 *   B - 现有对话模式：直接导航到指定旧对话 URL（DOUBAO_DIALOG_URL），页面加载时拦截
 *       /im/chain/single 响应，提取该对话历史中的原图 URL 并下载。
 *
 * 环境变量：
 *   DOUBAO_MODE         A | B，默认 B
 *   DOUBAO_DIALOG_URL   模式 B 下的旧对话页面 URL
 *   DOUBAO_PROMPT       本轮实际使用的提示词（写入 prompt.txt 元数据）
 *   DOUBAO_IMAGES       参考图片本地路径，逗号分隔（写入 references.json）
 *   CLOSE_ON_EXIT       true 则运行结束后关闭浏览器
 *
 * 运行：node src/phase1-e2e.js
 *
 * 安全：登录操作完全在你本地可见浏览器中完成，脚本不会索取或记录密码/验证码。
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const {
  parseEventStreamText,
  parseChainSingleResponse,
  isDoubaoGenerationApi,
  isHttpUrl,
  normalizeImageUrl,
} = require('./image-extractor');
const { downloadBatch } = require('./downloader');

const USER_DATA_DIR = path.join(__dirname, '..', '.userdata', 'doubao-default');
const TARGET_URL = 'https://www.doubao.com/chat/';
const ROOT_OUTPUT = path.join(__dirname, '..', '.output', 'rounds');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function pad(n) { return String(n).padStart(2, '0'); }
function timestampDirName() {
  const now = new Date();
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${String(now.getMilliseconds()).padStart(3, '0')}`;
}

class ImageCollector {
  constructor() {
    this.images = [];
    this.seenUrls = new Set();
  }
  add(info, source) {
    if (!info || !info.url) return false;
    if (this.seenUrls.has(info.url)) return false;
    this.seenUrls.add(info.url);
    this.images.push({ ...info, source, discoveredAt: new Date().toISOString() });
    return true;
  }
  getAll() { return [...this.images]; }
  count() { return this.images.length; }
}

/**
 * 安装网络响应拦截器：拦截 /chat/completion EventStream 和 /im/chain/single，
 * 从 creation.image.image_ori_raw 提取原图 URL（对应油猴脚本的 XHR/fetch 拦截逻辑）。
 */
function setupResponseInterceptor(page, collector) {
  page.on('response', async (response) => {
    const url = response.url();
    if (!isDoubaoGenerationApi(url)) return;
    const status = response.status();
    if (status < 200 || status >= 300) return;
    const contentType = response.headers()['content-type'] || '';
    const isEventStream = contentType.includes('text/event-stream') || url.includes('/chat/completion');
    const isJSON = contentType.includes('application/json');
    if (!isEventStream && !isJSON) return;

    try {
      const text = await response.text();
      if (!text || text.length < 10) return;

      if (url.includes('/im/chain/single')) {
        try {
          const json = JSON.parse(text);
          const imgs = parseChainSingleResponse(json, collector.seenUrls);
          for (const img of imgs) collector.add(img, url);
        } catch (_) {
          const imgs = parseEventStreamText(text, collector.seenUrls);
          for (const img of imgs) collector.add(img, url);
        }
      } else if (isEventStream || url.includes('/chat/completion')) {
        const imgs = parseEventStreamText(text, collector.seenUrls);
        for (const img of imgs) collector.add(img, url);
      }
    } catch (err) {
      console.warn(`[实测] 读取响应体失败 ${url}: ${err.message}`);
    }
  });
  console.log('[实测] 网络响应拦截器已安装（/chat/completion, /im/chain/single）');
}

/**
 * 从页面脚本标签中提取原图（模拟油猴脚本 extractSharePageImages / collectSharePageMedia）。
 * 豆包分享页/对话页的初始数据嵌在 <script data-script-src="modern-run-router-data-fn"> 中。
 */
async function extractFromPageScripts(page, collector) {
  try {
    const count = await page.evaluate((collectorSeen) => {
      const found = [];
      const seen = new Set(collectorSeen);
      const add = (url) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        found.push({ url, width: 0, height: 0 });
      };

      const scripts = document.querySelectorAll(
        'script[data-script-src="modern-run-router-data-fn"], script[data-script-src="modern-run-window-fn"]'
      );
      for (const script of scripts) {
        const rawArgs = script.getAttribute('data-fn-args');
        if (!rawArgs) continue;
        try {
          const data = JSON.parse(rawArgs.replace(/&quot;/g, '"'));
          walkJson(data, add);
        } catch (_) { /* 忽略解析失败 */ }
      }
      if (window._ROUTER_DATA) {
        walkJson(window._ROUTER_DATA, add);
      }
      return found;

      function walkJson(value, cb) {
        if (value == null) return;
        if (typeof value === 'string') {
          const t = value.trim();
          if ((t.startsWith('{') || t.startsWith('['))) {
            try { walkJson(JSON.parse(t), cb); } catch (_) {}
          }
          return;
        }
        if (typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach((v) => walkJson(v, cb)); return; }
        if (value.image && value.image.image_ori_raw) {
          const raw = value.image.image_ori_raw;
          const url = typeof raw === 'string' ? raw : (raw && raw.url);
          if (isHttpUrl(url)) cb(normalizeImageUrl(url));
        }
        for (const k of Object.keys(value)) walkJson(value[k], cb);
      }
    }, [...collector.seenUrls]);

    for (const img of count) collector.add(img, 'page-script');
    console.log(`[实测] 页面脚本标签提取 ${count.length} 张原图`);
  } catch (err) {
    console.warn(`[实测] 页面脚本提取失败: ${err.message}`);
  }
}

async function saveDiagnostics(page, tag) {
  const dir = path.join(__dirname, '..', '.output', 'diagnostics');
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  const base = path.join(dir, `${tag}_${stamp}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    console.log(`[实测] 截图已保存: ${base}.png`);
  } catch (err) { console.warn(`[实测] 截图失败: ${err.message}`); }
  try {
    const html = await page.content();
    fs.writeFileSync(`${base}.html`, html, 'utf-8');
    console.log(`[实测] HTML 已保存: ${base}.html`);
  } catch (err) { console.warn(`[实测] HTML 保存失败: ${err.message}`); }
}

async function downloadAndSave(collector, roundDir, prompt, referenceImages) {
  const images = collector.getAll();
  console.log(`\n[实测] 本轮共捕获 ${images.length} 张原图`);
  if (images.length === 0) {
    console.log('[实测] 未捕获到任何原图。');
    return { successCount: 0, failedCount: 0 };
  }

  console.log('[实测] 捕获到的原图列表：');
  images.forEach((img, i) => {
    console.log(`  ${String(i + 1).padStart(2, '0')}. ${img.url} (${img.width}x${img.height}) 来源: ${img.source}`);
  });

  ensureDir(roundDir);
  console.log(`[实测] 开始下载到 ${roundDir}`);

  const items = images.map((img, i) => ({
    index: i,
    url: img.url,
    name: `image_${String(i + 1).padStart(3, '0')}`,
  }));

  const result = await downloadBatch(items, roundDir, {
    concurrency: 1,
    referer: TARGET_URL,
    onProgress: (entry) => {
      console.log(`[实测] 下载 ${entry.index + 1}/${images.length}: ${entry.ok ? 'OK' : 'FAIL'} ${entry.error || ''} ${entry.path || ''}`);
    },
  });

  // 保存元数据
  const taskMeta = {
    taskId: `phase1-${timestampDirName()}`,
    platform: 'doubao',
    method: 'DOM + network interception (doubao-nomark logic)',
    prompt: prompt || '',
    referenceImages: (referenceImages || []).map((imgPath, i) => ({
      index: i,
      localPath: imgPath,
      exists: fs.existsSync(imgPath),
    })),
    capturedImages: images,
    downloaded: result.results.filter((r) => r.ok).map((r) => ({ path: r.path, size: r.size, sha256: r.sha256, ext: r.ext })),
    failed: result.results.filter((r) => !r.ok).map((r) => ({ url: r.url, error: r.error })),
    submittedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(roundDir, 'task.json'), JSON.stringify(taskMeta, null, 2), 'utf-8');
  if (prompt) fs.writeFileSync(path.join(roundDir, 'prompt.txt'), prompt, 'utf-8');
  if (referenceImages && referenceImages.length) {
    fs.writeFileSync(path.join(roundDir, 'references.json'), JSON.stringify(taskMeta.referenceImages, null, 2), 'utf-8');
  }

  console.log('\n========================================');
  console.log('Phase 1 端到端实测结果');
  console.log('========================================');
  console.log(`输出目录: ${roundDir}`);
  console.log(`成功下载: ${result.successCount} 张`);
  console.log(`下载失败: ${result.failedCount} 张`);
  result.results.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2, '0')}. ${r.ok ? 'OK' : 'FAIL'} ${r.path || r.url} ${r.error || ''}`);
  });
  console.log(`元数据: ${path.join(roundDir, 'task.json')}`);
  console.log('========================================\n');

  return result;
}

async function main() {
  const prompt = process.env.DOUBAO_PROMPT || '';
  const imagesEnv = process.env.DOUBAO_IMAGES || '';
  const referenceImages = imagesEnv.split(',').map(s => s.trim()).filter(Boolean);
  const mode = (process.env.DOUBAO_MODE || 'B').toUpperCase();
  const dialogUrl = process.env.DOUBAO_DIALOG_URL || '';
  const isNewGen = mode === 'A';

  ensureDir(ROOT_OUTPUT);
  ensureDir(USER_DATA_DIR);

  console.log('========================================');
  console.log('豆包批量生图 Phase 1 端到端实测（基于 doubao-nomark 逻辑）');
  console.log('========================================');
  console.log(`用户数据目录: ${USER_DATA_DIR}`);
  console.log(`输出根目录: ${ROOT_OUTPUT}`);
  console.log(`模式: ${isNewGen ? 'A - 新生成' : 'B - 现有对话'}`);
  console.log(`提示词: ${prompt || '(未设置 DOUBAO_PROMPT)'}`);
  console.log(`参考图片: ${referenceImages.length} 张 ${referenceImages.join(', ') || '(未设置 DOUBAO_IMAGES)'}`);
  if (dialogUrl) console.log(`目标对话: ${dialogUrl}`);
  console.log('========================================\n');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  const collector = new ImageCollector();
  setupResponseInterceptor(page, collector);

  if (isNewGen) {
    // 模式 A：等待新生成
    console.log(`\n[实测] 导航至 ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const isLogin = /登录|登入|sign in|login/i.test(bodyText) || /login/i.test(page.url());
    if (isLogin) {
      console.log('[实测] 检测到登录页。请在可见浏览器中手动登录，登录后按回车继续（本环境不支持交互，请设置 CLOSE_ON_EXIT=false 并手动中断后继续）。');
      // 非交互环境下等待一段时间，给用户手动登录的机会
      await new Promise((r) => setTimeout(r, 30000));
    }

    console.log('[实测] 请在豆包网页中上传 5 张参考图片、输入提示词、提交生成。');
    console.log('[实测] 等待生图结果返回（最多 3 分钟）...');
    const deadline = Date.now() + 180000;
    let lastCount = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const c = collector.count();
      if (c !== lastCount) {
        console.log(`[实测] 已捕获 ${c} 张原图`);
        lastCount = c;
      }
      if (c >= 1) break;
    }
  } else {
    // 模式 B：直接导航到旧对话
    if (!dialogUrl) {
      console.error('[实测] 模式 B 需要设置 DOUBAO_DIALOG_URL 环境变量');
      process.exit(1);
    }
    console.log(`[实测] 直接导航至旧对话页面：${dialogUrl}`);
    await page.goto(dialogUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    console.log('[实测] 页面已加载，正在拦截 /im/chain/single 响应提取原图...');
    await extractFromPageScripts(page, collector);
  }

  await saveDiagnostics(page, 'before-download');

  const roundDir = path.join(ROOT_OUTPUT, timestampDirName());
  await downloadAndSave(collector, roundDir, prompt, referenceImages);

  if (process.env.CLOSE_ON_EXIT === 'true') {
    await context.close();
    console.log('[实测] 浏览器已关闭');
  } else {
    console.log('[实测] 浏览器保持打开（CLOSE_ON_EXIT=true 可自动关闭）');
  }
}

main().catch((err) => {
  console.error('[实测] 致命错误:', err);
  process.exit(1);
});
