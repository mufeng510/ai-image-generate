#!/usr/bin/env node
/**
 * sidecar/src/index.js
 *
 * Doubao batch image generate automation sidecar (Node.js + Playwright Chromium).
 *
 * 通信方式：通过 stdin/stdout 与 Tauri Rust 后端交互。
 *   输入（stdin）：JSON 行协议，每行一个命令：
 *     {"cmd":"start_browser","account_id":1,"user_data_dir":"..."}
 *     {"cmd":"open_login","account_id":1,"user_data_dir":"..."}
 *     {"cmd":"scan_images","task_id":1,"root_path":"...","units_file":"..."}
 *     {"cmd":"generate_images","account_id":1,"project_root":"...","refs":[...],"prompt":"..."}
 *     {"cmd":"extract_images","account_id":1,"project_root":"..."}
 *     {"cmd":"download_images","account_id":1,"round_id":1,"round_dir":"...","images":[{"url":"...","index":0}]}
 *     {"cmd":"stop_browser","account_id":1}
 *   输出（stdout）：JSON 行协议，每行一个事件：
 *     {"type":"log","level":"info","message":"..."}
 *     {"type":"result","cmd":"...","ok":true,...}
 *     {"type":"event","event":"images_extracted","images":[...]}
 *     {"type":"event","event":"download_progress","current":1,"total":5}
 *     {"type":"event","event":"download_completed","results":[...]}
 *     {"type":"error","cmd":"...","message":"..."}
 *
 * 安全：不处理密码/令牌；登录状态仅通过 Chromium 持久化 userDataDir 保留；
 * 日志脱敏，不输出 Cookie/授权头。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { scanFolders } = require('./scanner');
const { ImagePool } = require('./pool');
const { downloadImage } = require('./downloader');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** 当前启动的浏览器上下文（按 account_id 索引，串行使用） */
const contexts = new Map(); // account_id -> { context, page, userDataDir }

/** 当前任务抽中的参考图片（内存中保留，供后续上传使用） */
let currentSelection = { round: null, images: [] };

/** 向 stdout 发送一行 JSON 事件 */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 发送日志事件（脱敏，不输出敏感信息） */
function log(level, message) {
  if (LOG_LEVELS.indexOf(level) < 0) level = 'info';
  emit({ type: 'log', level, message, timestamp: new Date().toISOString() });
}

/** 确保目录存在 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 取当前活跃页面：优先复用已打开页面，否则新建 */
async function acquirePage(ctx) {
  const pages = ctx.context.pages();
  const page = pages.find((p) => !p.isClosed()) || (await ctx.context.newPage());
  ctx.page = page;
  return page;
}

/** 启动可见 Chromium 持久化上下文（每账号独立 userDataDir） */
async function startBrowser(accountId, userDataDir) {
  const absoluteDir = path.resolve(userDataDir);
  ensureDir(absoluteDir);

  if (contexts.has(accountId)) {
    const ctx = contexts.get(accountId);
    const alive = ctx && ctx.context.pages().some((p) => !p.isClosed());
    if (alive) {
      log('warn', `账号 ${accountId} 浏览器已启动，跳过`);
      return { ok: true };
    }
    // 页面已关闭：清理旧 context 并重新启动
    log('info', `账号 ${accountId} 旧浏览器已关闭，重新启动…`);
    try { await ctx.context.close(); } catch (_) {}
    contexts.delete(accountId);
  }

  log('info', `启动可见 Chromium，账号 ${accountId}，用户数据目录: ${absoluteDir}`);
  const context = await chromium.launchPersistentContext(absoluteDir, {
    headless: false, // 必须有界面，用户可见
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  contexts.set(accountId, { context, page, userDataDir: absoluteDir });
  log('info', `账号 ${accountId} 浏览器已启动`);
  return { ok: true };
}

/** 尝试关闭营销/推广弹窗（如“每日签到”）——良性操作：ESC 或点关闭按钮，失败则继续并保存诊断 */
async function dismissPromoModal(page) {
  try {
    const promo = page.locator('text=每日签到, text=免费用豆包工作');
    if (await promo.count() === 0) return false;
    log('info', '检测到推广弹窗，尝试关闭（ESC）');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    if (await promo.count() === 0) {
      log('info', '推广弹窗已通过 ESC 关闭');
      return true;
    }
    // 兜底：查找关闭按钮（aria-label 含“关闭/Close”，或弹窗内第一个按钮）
    const closeSelectors = [
      'button[aria-label*="关闭"]:visible',
      'button[aria-label*="Close" i]:visible',
      'div[role="dialog"] button:visible',
      'div[class*="modal"] button:visible',
    ];
    for (const sel of closeSelectors) {
      try {
        const btn = page.locator(sel).last();
        if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(800);
          if (await promo.count() === 0) {
            log('info', `推广弹窗已通过选择器关闭: ${sel}`);
            return true;
          }
        }
      } catch (_) { /* 继续下一个候选 */ }
    }
    log('warn', '推广弹窗未能关闭，继续执行（后续点击可能被遮挡）');
    return false;
  } catch {
    return false;
  }
}

/** 轮询页面，识别登录成功后触发 login_detected 事件（不触碰 Cookie，仅看页面文本） */
function watchLogin(accountId, page, maxAttempts = 300) {
  let attempts = 0;
  let stablePolls = 0;
  const timer = setInterval(async () => {
    attempts += 1;
    if (attempts > maxAttempts || page.isClosed()) {
      clearInterval(timer);
      return;
    }
    try {
      const bodyText = await page.locator('body').innerText();
      // 登录页一定会出现登录入口文案；登录后的豆包页面不会
      const loginMarkers = /扫码登录|手机号登录|验证码登录|立即登录|手机登录|登录抖音/.test(bodyText || '');
      const hasContent = (bodyText || '').length > 200;
      if (!loginMarkers && hasContent) {
        stablePolls += 1;
        if (stablePolls >= 2) {
          clearInterval(timer);
          log('info', `账号 ${accountId} 登录状态已识别`);
          emit({ type: 'event', event: 'login_detected', account_id: accountId });
        }
      } else {
        stablePolls = 0;
      }
    } catch (_) {
      // 取不到页面文本时继续下一轮
    }
  }, 3000);
  timer.unref();
}

/** 打开登录页（供用户手动登录，会话持久化在 userDataDir） */
async function openLogin(accountId, userDataDir) {
  await startBrowser(accountId, userDataDir);
  const ctx = contexts.get(accountId);
  const page = await acquirePage(ctx);
  log('info', '打开豆包登录页，请在可见浏览器中手动登录');
  await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((err) => {
    log('warn', `导航到豆包首页失败: ${err.message}`);
  });
  // 后台轮询登录状态（最长约 15 分钟），识别成功后由 Rust 端更新账号状态
  watchLogin(accountId, page);
  return { ok: true, url: page.url() };
}

/** 关闭指定账号的浏览器上下文 */
async function stopBrowser(accountId) {
  const ctx = contexts.get(accountId);
  if (!ctx) {
    log('warn', `账号 ${accountId} 浏览器未启动`);
    return { ok: true };
  }
  try {
    await ctx.context.close();
    log('info', `账号 ${accountId} 浏览器已关闭`);
  } catch (err) {
    log('warn', `关闭账号 ${accountId} 浏览器失败: ${err.message}`);
  }
  contexts.delete(accountId);
  return { ok: true };
}

/** 扫描参考图片目录并按文件夹抽图（写回进度，供调度器持久化） */
async function scanAndSelect(cmd) {
  const rootPath = path.resolve(cmd.root_path || '.');
  const count = cmd.count || 5;

  const stateDir = path.resolve(cmd.state_dir || path.join(rootPath, '.doubao'));
  ensureDir(stateDir);
  const pool = new ImagePool(path.join(stateDir, 'pool.json'));

  log('info', `扫描参考图片目录: ${rootPath}`);
  const folders = await scanFolders(rootPath);
  const allPaths = [];
  for (const f of folders) for (const img of f.images) allPaths.push(img.path);
  pool.prune(allPaths);

  if (folders.length === 0) {
    log('warn', '参考图片目录中没有找到有效图片（jpg/jpeg/png/webp）');
    return { ok: false, reason: 'no_images', total_images: 0, folders: 0, folders_detail: [] };
  }

  const result = await pool.selectImages(folders, count);
  const selected = result.selected || [];

  log('info', `共 ${folders.length} 个文件夹、${allPaths.length} 张图片；本轮抽取 ${selected.length} 张`);

  // 写回抽取单元文件：{folder, path, sha256}
  if (cmd.units_file) {
    const units = selected.map((img) => ({
      folder: img.dirName || img.dir,
      path: img.path,
      sha256: img.sha256,
    }));
    ensureDir(path.dirname(cmd.units_file));
    fs.writeFileSync(cmd.units_file, JSON.stringify(units, null, 2), 'utf-8');
    log('info', `抽取单元已写入: ${cmd.units_file}`);
  }

  currentSelection = { round: cmd.round_number || 1, images: selected };
  return {
    ok: true,
    total_images: allPaths.length,
    folders: folders.length,
    folders_detail: folders.map((f) => ({ dir: f.dir, dirName: f.dirName, count: f.images.length })),
    selected_count: selected.length,
    selected: selected.map((img, idx) => ({
      index: idx + 1,
      path: img.path,
      name: img.name,
      folder: img.dirName,
      sha256: img.sha256,
      size: img.size,
    })),
  };
}

/**
 * 提取生成结果图片的 URL（不下载）。
 * 状态不明时返回 ok:false + reason，绝不盲目点击或重试。
 */
async function probeAndExtract(cmd) {
  const accountId = cmd.account_id;
  const ctx = contexts.get(accountId);
  if (!ctx) {
    return { ok: false, reason: 'browser_not_started' };
  }
  const page = await acquirePage(ctx);

  const probe = await page.evaluate(() => {
    const q = (sel) => document.querySelectorAll(sel).length;
    const bodyText = (document.body && document.body.innerText) || '';
    const textboxes = document.querySelectorAll('textarea,[contenteditable="true"]').length;
    return {
      url: location.href,
      fileInputs: q('input[type="file"]'),
      textboxes,
      likelyLoggedIn: !/扫码登录|手机号登录|立即登录/.test(bodyText) || /退出|个人中心|设置/.test(bodyText),
    };
  }).catch(() => ({ url: page.url(), fileInputs: 0, textboxes: 0, likelyLoggedIn: false }));

  log('info', `页面探测: url=${probe.url} 文件输入=${probe.fileInputs} 输入框=${probe.textboxes} 疑似已登录=${probe.likelyLoggedIn}`);

  // 1. 优先抽取无水印原图（image_ori_raw，内嵌于页面 JSON 中）
  const { parseImageOriRaws, extractImagesFromDom } = require('./extractor');
  let rawImages = [];
  try {
    const html = await page.content();
    rawImages = parseImageOriRaws(html);
    log('info', `image_ori_raw 解析到 ${rawImages.length} 张无水印原图`);
  } catch (err) {
    log('warn', `image_ori_raw 解析失败: ${err.message}`);
  }

  // 2. 兜底：DOM 扫描 /rc_gen_image/（大图优先），用于无内嵌 JSON 的情况
  if (rawImages.length === 0) {
    try {
      const dom = await extractImagesFromDom(page);
      const gen = dom.filter((img) => img.url.includes('/rc_gen_image/'));
      // 同一文件标识去重，保留 URL（都是同一代图，任取一张即可）
      const seen = new Set();
      rawImages = gen.filter((img) => {
        const key = img.identity.replace(/-[^/]*:[^/]*\.(png|jpeg|jpg|heic|webp).*/i, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      log('info', `DOM 兜底提取到 ${rawImages.length} 张生成图`);
    } catch (err) {
      log('warn', `DOM 兜底提取失败: ${err.message}`);
    }
  }
  log('info', `最终提取 ${rawImages.length} 张生成图片`);

  const roundDir = cmd.round_dir ? path.resolve(cmd.round_dir) : null;

  if (rawImages.length === 0) {
    const projectRoot = path.resolve(cmd.project_root || '.');
    const diagDir = path.join(projectRoot, 'output', 'diagnostics');
    ensureDir(diagDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      await page.screenshot({ path: path.join(diagDir, `extract_${stamp}.png`), fullPage: false });
      fs.writeFileSync(path.join(diagDir, `extract_${stamp}.html`), await page.content(), 'utf-8');
      log('info', `诊断信息已保存: ${diagDir}`);
    } catch (err) {
      log('warn', `保存诊断信息失败: ${err.message}`);
    }

    return {
      ok: false,
      reason: 'no_generated_images',
      probe,
      images: [],
      round_dir: roundDir,
      message: '页面未发现生成图片',
    };
  }

  return {
    ok: true,
    probe,
    images: rawImages.map((img) => ({ url: img.url, identity: img.identity })),
    round_dir: roundDir,
  };
}

/**
 * 生成一张/组图片：打开新对话页 → 上传参考图 → 输入提示词 → 提交 → 等待生成完成。
 *
 * 安全策略（task.md 铁律）：
 *   - 不盲目点击：所有可点击目标先探测存在性与可见性；找不到即停止并保存诊断；
 *   - 状态不明绝不重试提交：本命令只提交一次；
 *   - 登录失效/验证码/网页结构变化 → ok:false + reason，等待人工干预。
 */
async function generateImages(cmd) {
  const accountId = cmd.account_id;
  const ctx = contexts.get(accountId);
  if (!ctx) {
    return { ok: false, reason: 'browser_not_started' };
  }
  const page = await acquirePage(ctx);

  const projectRoot = path.resolve(cmd.project_root || '.');
  const diagDir = path.join(projectRoot, 'output', 'diagnostics');
  const saveDiag = async (tag) => {
    try {
      ensureDir(diagDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await page.screenshot({ path: path.join(diagDir, `${tag}_${stamp}.png`), fullPage: false });
      fs.writeFileSync(path.join(diagDir, `${tag}_${stamp}.html`), await page.content(), 'utf-8');
      log('info', `诊断信息已保存: ${diagDir}\\${tag}_${stamp}.png`);
    } catch (err) {
      log('warn', `保存诊断信息失败: ${err.message}`);
    }
  };

  const refs = (cmd.refs || []).filter((p) => fs.existsSync(p));
  const prompt = (cmd.prompt || '').trim();
  if (refs.length === 0) return { ok: false, reason: 'no_reference_images' };
  if (!prompt) return { ok: false, reason: 'empty_prompt' };

  // 1. 打开新对话页
  log('info', '打开豆包新对话页…');
  try {
    await page.goto('https://www.doubao.com/chat/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    await saveDiag('goto_failed');
    return { ok: false, reason: 'goto_failed', message: err.message };
  }
  await page.waitForTimeout(3000);
  await dismissPromoModal(page);

  // 登录检查：页面若提示登录，交人工处理
  const pageText = await page.locator('body').innerText().catch(() => '');
  if (/扫码登录|手机号登录|验证码登录|立即登录/.test(pageText) && !/退出|个人中心/.test(pageText)) {
    await saveDiag('login_required');
    return { ok: false, reason: 'login_required' };
  }

  // 2. 找上传入口（优先隐藏 input[type=file]；否则点开上传按钮）
  let fileInputs = await page.locator('input[type="file"]').count();
  if (fileInputs === 0) {
    const openers = [
      'button[aria-label*="上传"]',
      'div[aria-label*="上传"]',
      'button:has-text("上传")',
      '[data-testid*="upload"]',
      '[data-testid*="Upload"]',
      'button[aria-label*="Upload"]',
      'button.upload-btn',
      '.semi-upload-trigger button',
    ];
    for (const sel of openers) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
          await el.click();
          await page.waitForTimeout(1000);
          break;
        }
      } catch (_) { /* 继续尝试下一个候选 */ }
    }
    fileInputs = await page.locator('input[type="file"]').count();
  }
  if (fileInputs === 0) {
    await saveDiag('upload_input_not_found');
    return { ok: false, reason: 'upload_input_not_found', message: '未找到上传文件入口。请在可见浏览器中手动上传后继续。' };
  }

  // 3. 上传参考图片（最多 5 张）
  const targets = refs.slice(0, 5);
  log('info', `上传 ${targets.length} 张参考图片…`);
  try {
    await page.locator('input[type="file"]').first().setInputFiles(targets);
  } catch (err) {
    await saveDiag('set_input_files_failed');
    return { ok: false, reason: 'set_input_files_failed', message: err.message };
  }
  await page.waitForTimeout(4000);

  // 4. 输入提示词
  const textboxCount = await page.locator('textarea,[contenteditable="true"]').count();
  if (textboxCount === 0) {
    await saveDiag('textbox_not_found');
    return { ok: false, reason: 'textbox_not_found' };
  }
  const textbox = page.locator('textarea,[contenteditable="true"]').first();
  await textbox.click();
  try {
    await page.keyboard.insertText(prompt);
  } catch (err) {
    await saveDiag('prompt_insert_failed');
    return { ok: false, reason: 'prompt_insert_failed', message: err.message };
  }
  log('info', '提示词已输入');
  await dismissPromoModal(page); // 上传后弹窗可能再次出现

  // 5. 提交（只提交一次；找不到按钮即停止，不盲目点击）
  const submitCandidates = [
    'button[aria-label*="发送"]',
    'div[aria-label*="发送"]',
    '[data-testid="send_button"]',
    '[data-testid*="send_button"]',
    '[data-testid*="send"]',
    'button[aria-label*="Send" i]',
    'div[role="button"][aria-label*="发送"]',
  ];
  let clicked = false;
  for (const sel of submitCandidates) {
    try {
      const el = page.locator(sel).last();
      if (await el.count() > 0 && await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => true)) {
        await el.click();
        clicked = true;
        log('info', `已点击发送按钮: ${sel}`);
        break;
      }
    } catch (_) { /* 继续尝试下一个候选 */ }
  }
  if (!clicked) {
    await saveDiag('submit_button_not_found');
    return { ok: false, reason: 'submit_button_not_found', message: '未找到发送按钮。页面结构可能已变化，请查看诊断截图。' };
  }

  // 6. 等待生成完成：img[src*=tos-cn-i-a9rns2rl98] 出现且数量稳定
  const timeoutMs = cmd.generation_timeout_ms || 180000;
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stablePolls = 0;
  log('info', `等待生图完成（最长 ${Math.round(timeoutMs / 1000)} 秒）…`);
  while (Date.now() < deadline) {
    const count = await page.locator('img[src*="tos-cn-i-a9rns2rl98"]').count().catch(() => 0);
    if (count > 0 && count === lastCount) {
      stablePolls += 1;
      if (stablePolls >= 2) break;
    } else {
      stablePolls = 0;
    }
    lastCount = count;
    await page.waitForTimeout(2000);
  }

  if (lastCount <= 0) {
    await saveDiag('generation_timeout');
    return { ok: false, reason: 'generation_timeout', images_found: 0, message: '等待生图超时，页面未出现生成图片。' };
  }

  log('info', `生图完成，页面上发现 ${lastCount} 张生成图片`);
  return { ok: true, images_found: lastCount };
}

/** 下载给定的图片 URL 列表到 round 目录 */
async function downloadImages(cmd) {
  const accountId = cmd.account_id;
  const ctx = contexts.get(accountId);
  if (!ctx) {
    return { ok: false, reason: 'browser_not_started' };
  }
  const page = await acquirePage(ctx);
  const roundDir = path.resolve(cmd.round_dir || '.');
  ensureDir(roundDir);

  const images = cmd.images || [];
  const results = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < images.length; i++) {
    const item = images[i];
    const index = (item.index != null ? item.index : i) + 1;
    const destPath = path.join(roundDir, `image_${String(index).padStart(3, '0')}.png`);

    emit({ type: 'event', event: 'download_progress', current: index, total: images.length, message: `下载中: ${path.basename(destPath)}` });

    const res = await downloadImage(page, item.url, destPath);
    if (res.ok) success += 1; else failed += 1;

    results.push({
      index,
      url: item.url,
      ok: res.ok,
      skipped: !!res.skipped,
      path: res.path,
      size: res.size,
      sha256: res.sha256,
      ext: res.ext,
      error: res.error,
    });
  }

  emit({ type: 'event', event: 'download_completed', results });
  return { ok: true, success_count: success, failed_count: failed, results };
}

/** 处理一条 stdin 命令 */
async function handleCommand(cmd) {
  switch (cmd.cmd) {
    case 'start_browser':
      return await startBrowser(cmd.account_id, cmd.user_data_dir);
    case 'open_login':
      return await openLogin(cmd.account_id, cmd.user_data_dir);
    case 'stop_browser':
      return await stopBrowser(cmd.account_id);
    case 'scan_images':
      return await scanAndSelect(cmd);
    case 'generate_images':
      return await generateImages(cmd);
    case 'extract_images':
      return await probeAndExtract(cmd);
    case 'download_images':
      return await downloadImages(cmd);
    default:
      throw new Error(`未知命令: ${cmd.cmd}`);
  }
}

/** 读取 stdin 逐行处理（JSON 行协议） */
function setupStdin() {
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const cmd = JSON.parse(line);
        (async () => {
          try {
            const result = await handleCommand(cmd);
            emit({ type: 'result', cmd: cmd.cmd, ...result });
          } catch (err) {
            log('error', `处理命令 ${cmd.cmd} 异常: ${err.message}`);
            emit({ type: 'error', cmd: cmd.cmd, message: err.message });
          }
        })();
      } catch (err) {
        log('error', `解析 stdin 指令失败: ${err.message}`);
      }
    }
  });
  process.stdin.on('end', () => {
    log('info', 'stdin 已关闭，sidecar 退出');
    process.exit(0);
  });
}

/** 入口 */
function main() {
  log('info', 'Doubao batch sidecar 启动');
  setupStdin();
}

main();

module.exports = { scanAndSelect, probeAndExtract, generateImages, downloadImages, startBrowser, stopBrowser, openLogin };
