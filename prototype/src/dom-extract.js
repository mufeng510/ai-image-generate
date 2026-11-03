/**
 * dom-extract.js
 *
 * 基于 ihmily/doubao-nomark 油猴脚本的核心提取逻辑，改用 DOM 扫描方案。
 * 豆包是单页应用，切换对话不触发 /im/chain/single 网络请求，因此直接
 * 从页面渲染的 <img> 标签中提取原图 URL。
 *
 * 筛选规则（对应油猴脚本的图片捕获逻辑）：
 *   - 只保留 imagex-sign / tos-cn 的图片资源URL
 *   - 排除 /icon/、action_bar_icon、/static/、favicon 等 UI 资源
 *   - 按 URL 身份（去掉查询参数）去重，避免同一张图片重复下载
 *
 * 运行：node src/dom-extract.js
 * 环境变量：
 *   DOUBAO_DIALOG_URL   旧对话页面 URL
 *   CLOSE_ON_EXIT       true 则运行结束后关闭浏览器
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_DATA_DIR = path.join(__dirname, '..', '.userdata', 'doubao-default');
const ROOT_OUTPUT = path.join(__dirname, '..', '.output', 'rounds');
const DIALOG_URL = process.env.DOUBAO_DIALOG_URL || 'https://www.doubao.com/chat/38450507953227522';

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function pad(n) { return String(n).padStart(2, '0'); }
function timestampDirName() {
  const now = new Date();
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${String(now.getMilliseconds()).padStart(3, '0')}`;
}

/** 判断是否为 UI 图标/资源，应被过滤 */
function isUiAsset(url) {
  const low = url.toLowerCase();
  // 生成图片的路径模式：tos-cn-i-a9rns2rl98（豆包图片生成服务）
  // 只有命中此路径的才保留，其余均视为 UI 资源过滤
  if (!low.includes('tos-cn-i-a9rns2rl98')) return true;
  if (low.includes('/icon/') || low.includes('action_bar_icon')) return true;
  if (low.endsWith('.svg')) return true;
  return false;
}

/** URL 身份（去掉查询参数和片段，用于去重） */
function urlIdentity(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (_) {
    return url;
  }
}

/** 根据 URL 路径/Content-Type 风格判断扩展名 */
function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{1,5})(?:\?|$)/i);
    if (m) return '.' + m[1].toLowerCase();
  } catch (_) {}
  return '.png';
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function downloadImage(url, destPath) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, (res) => {
      if (res.statusCode !== 200) { resolve({ ok: false, error: `HTTP ${res.statusCode}` }); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        try {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, buf);
          resolve({ ok: true, size: buf.length, path: destPath });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

/** 在页面中提取所有生成图片的 URL（DOM 扫描） */
async function extractImagesFromDom(page) {
  return await page.evaluate(() => {
    const seen = new Set();
    const results = [];
    const add = (url) => {
      if (!url || !isHttpUrl(url)) return;
      if (isUiAsset(url)) return;
      const id = urlIdentity(url);
      if (seen.has(id)) return;
      seen.add(id);
      results.push({ url, identity: id });
    };

    document.querySelectorAll('img').forEach((img) => {
      const src = img.src || img.getAttribute('src');
      if (src) add(src);
      const curSrc = img.currentSrc;
      if (curSrc) add(curSrc);
    });

    return results;

    function isHttpUrl(v) { return typeof v === 'string' && /^https?:\/\//i.test(v); }
    function isUiAsset(u) {
      const low = u.toLowerCase();
      // 生成图片的路径模式：tos-cn-i-a9rns2rl98（豆包图片生成服务）
      if (!low.includes('tos-cn-i-a9rns2rl98')) return true;
      // 同路径下的 UI 图标需进一步过滤
      if (low.includes('/icon/') || low.endsWith('.svg')) return true;
      return false;
    }
    function urlIdentity(u) {
      try { const x = new URL(u); return x.origin + x.pathname; } catch (_) { return u; }
    }
  });
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

(async () => {
  ensureDir(USER_DATA_DIR);
  ensureDir(ROOT_OUTPUT);

  console.log('========================================');
  console.log('豆包 Phase 1 DOM 提取（基于 doubao-nomark 逻辑）');
  console.log('========================================');
  console.log(`用户数据目录: ${USER_DATA_DIR}`);
  console.log(`目标对话: ${DIALOG_URL}`);
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

  console.log(`[实测] 导航至旧对话: ${DIALOG_URL}`);
  await page.goto(DIALOG_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等待右侧聊天内容加载（生成的图片在右侧内容区域，可能是懒加载）
  await page.waitForTimeout(10000);
  // 滚动页面到中间位置，触发图片懒加载
  await page.evaluate(() => window.scrollTo(0, window.innerHeight / 2));
  await page.waitForTimeout(3000);
  console.log('[实测] 页面已加载并滚动，开始提取原图...');

  // 提取图片
  const rawImages = await extractImagesFromDom(page);
  console.log(`[实测] 页面中发现 ${rawImages.length} 张生成图片（已去重，排除 UI 图标）`);
  rawImages.forEach((img, i) => {
    console.log(`  ${String(i + 1).padStart(2, '0')}. ${img.url.substring(0, 160)}`);
  });

  if (rawImages.length === 0) {
    console.log('[实测] 未发现任何生成图片。');
    await saveDiagnostics(page, 'no-images');
    if (process.env.CLOSE_ON_EXIT === 'true') await context.close();
    return;
  }

  // 下载
  const roundDir = path.join(ROOT_OUTPUT, timestampDirName());
  ensureDir(roundDir);

  let success = 0, failed = 0;
  const results = [];

  for (let i = 0; i < rawImages.length; i++) {
    const imgUrl = rawImages[i].url;
    const fileExt = extFromUrl(imgUrl);
    const destPath = path.join(roundDir, `image_${String(i + 1).padStart(3, '0')}${fileExt}`);
    const res = await downloadImage(imgUrl, destPath);
    if (res.ok) {
      try { res.sha256 = await sha256File(destPath); } catch (_) {}
      success++;
    } else {
      failed++;
    }
    results.push({
      index: i + 1,
      url: imgUrl,
      ok: res.ok,
      path: res.path,
      size: res.size,
      sha256: res.sha256,
      ext: fileExt,
      error: res.error,
    });
    console.log(`  ${String(i + 1).padStart(2, '0')}. ${res.ok ? 'OK' : 'FAIL'} ${res.error || ''} ${res.path || ''}`);
  }

  // 保存元数据
  const taskMeta = {
    taskId: `phase1-dom-${timestampDirName()}`,
    platform: 'doubao',
    method: 'DOM extraction (doubao-nomark logic)',
    dialogUrl: DIALOG_URL,
    images: results,
    successCount: success,
    failedCount: failed,
    completedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(roundDir, 'task.json'), JSON.stringify(taskMeta, null, 2), 'utf-8');

  console.log('\n========================================');
  console.log('Phase 1 DOM 提取结果');
  console.log('========================================');
  console.log(`输出目录: ${roundDir}`);
  console.log(`成功下载: ${success} 张`);
  console.log(`下载失败: ${failed} 张`);
  console.log(`元数据: ${path.join(roundDir, 'task.json')}`);
  console.log('========================================\n');

  if (process.env.CLOSE_ON_EXIT === 'true') {
    await context.close();
    console.log('[实测] 浏览器已关闭');
  } else {
    console.log('[实测] 浏览器保持打开。');
  }
})().catch((err) => {
  console.error('[实测] 致命错误:', err);
  process.exit(1);
});
