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
 *     {"cmd":"resume_generate","account_id":1,"generation_timeout_ms":180000}
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
const genParams = require(path.join(__dirname, 'gen-params.js'));
const { chromium } = require('playwright');

const { scanFolders } = require('./scanner');
const { ImagePool } = require('./pool');
const { downloadImage } = require('./downloader');
const { dismissPageOverlays, waitAndDismissOverlays, setLogger } = require('./overlays');
const { isCaptchaText } = require('./detectors');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** 当前启动的浏览器上下文（按 account_id 索引，串行使用） */
const contexts = new Map(); // account_id -> { context, page, userDataDir }

/** 当前任务抽中的参考图片（内存中保留，供后续上传使用） */
let currentSelection = { round: null, images: [] };

/**
 * 已请求中止的任务 ID 集合。
 * Rust 端暂停/取消时会发送 {"cmd":"abort","task_id":N}；
 * 正在执行的长任务在检查点退出，不再操作页面（尤其是提交、下载）。
 * 新一次执行（start_browser / resume_generate）开始时清除对应任务的中止标记。
 */
const abortedTasks = new Set();

/** 中止异常：在长任务内部抛出，由命令分发处转换为中止结果 */
class AbortError extends Error {
  constructor(message) {
    super(message || '操作已被用户中止');
    this.name = 'AbortError';
  }
}

/** 指定任务是否已被请求中止 */
function isAborted(taskId) {
  return taskId != null && abortedTasks.has(taskId);
}

/** 检查中止标记：已中止则抛出 AbortError（在关键操作前调用） */
function throwIfAborted(taskId) {
  if (isAborted(taskId)) throw new AbortError();
}

/** 清除任务的中止标记（新一次执行开始时调用） */
function clearAbort(taskId) {
  if (taskId != null) abortedTasks.delete(taskId);
}

/** 向 stdout 发送一行 JSON 事件 */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 发送日志事件（脱敏，不输出敏感信息） */
function log(level, message) {
  if (LOG_LEVELS.indexOf(level) < 0) level = 'info';
  emit({ type: 'log', level, message: redact(String(message)), timestamp: new Date().toISOString() });
}

setLogger(log);

/** 日志脱敏：去掉 Cookie/Authorization/Token/CSRF/会话类字段的值，保留键名与结构 */
function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  // JSON 场景："key":"value"，key 为敏感名时抹掉 value
  out = out.replace(
    /(["']?(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-csrf-token|csrf[-_]token|access_token|refresh_token|id_token|token|session_id|sessionid|sid|jsessionid|api[-_]?key|secret|password|pwd)["']?\s*:\s*)("[^"]*"|'[^']*'|[^,"}\s]*)/gi,
    (_m, prefix, _q, val) => {
      const quote = val.startsWith('"') ? '"' : val.startsWith("'") ? "'" : '';
      return `${prefix}${quote}[REDACTED]${quote}`;
    }
  );
  // 键=值 场景：cookie=...; token=...;
  out = out.replace(
    /\b(cookie|set-cookie|authorization|proxy-authorization|x-api-key|csrf[-_]token|access_token|refresh_token|id_token|token|session_id|sessionid|sid|api[-_]?key|secret|password|pwd)\s*=\s*[^;\s,]*/gi,
    (_m, key) => `${key}=[REDACTED]`
  );
  return out;
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

/* 遮罩/弹窗关闭逻辑已抽取至 ./overlays.js（hasVisibleOverlay / dismissPageOverlays / waitAndDismissOverlays） */

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
  await page.waitForTimeout(1500);
  await waitAndDismissOverlays(page, { timeoutMs: 6000, stableMs: 1200 });
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
  const { parseImageOriRaws, extractImagesFromDom, dedupeGeneratedImages } = require('./extractor');
  let rawImages = [];
  try {
    const html = await page.content();
    rawImages = parseImageOriRaws(html);
    log('info', `image_ori_raw 解析到 ${rawImages.length} 张无水印原图`);
  } catch (err) {
    log('warn', `image_ori_raw 解析失败: ${err.message}`);
  }

  // 2. 兜底：DOM 扫描 /rc_gen_image/（去重 + 高清优先），用于无内嵌 JSON 的情况
  if (rawImages.length === 0) {
    try {
      const dom = await extractImagesFromDom(page);
      const gen = dom.filter((img) => img.url.includes('/rc_gen_image/'));
      // 同一底图有缩略图（cthumb）与高清图（cgen）两种 rendition：按文件标识去重，高清优先
      rawImages = dedupeGeneratedImages(gen);
      log('info', `DOM 兜底提取到 ${rawImages.length} 张生成图（已按文件标识去重，高清优先）`);
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
      // 保存页面 URL 与标签，便于事后定位失败页（例如被跳到登录页/风控页）
      fs.writeFileSync(
        path.join(diagDir, `extract_${stamp}.json`),
        JSON.stringify({ tag: 'extract', url: page.url(), timestamp: new Date().toISOString() }, null, 2),
        'utf-8'
      );
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

/** 发送按钮候选选择器（按优先级） */
const SUBMIT_CANDIDATES = [
  'button[aria-label*="发送"]',
  'div[aria-label*="发送"]',
  '[data-testid="send_button"]',
  '[data-testid*="send_button"]',
  '[data-testid*="send"]',
  'button[aria-label*="Send" i]',
  'div[role="button"][aria-label*="发送"]',
];

/** 找到可见且可用的发送按钮；找不到返回 null（绝不盲点） */
async function findSubmitButton(page) {
  for (const sel of SUBMIT_CANDIDATES) {
    try {
      const el = page.locator(sel).last();
      if (await el.count() > 0 && await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => true)) {
        return { el, sel };
      }
    } catch (_) { /* 继续尝试下一个候选 */ }
  }
  return null;
}

/** 统计页面上已生成图片的数量（按底图标识去重，避免缩略图/高清图双 <img> 重复计数）。
 *  只统计 rc_gen_image 生成产物，避免把参考图缩略图算成生成图 */
async function countGeneratedImages(page) {
  return await page.evaluate(() => {
    const keyOf = (src) => {
      try {
        const u = new URL(src, location.href);
        return u.pathname.replace(/~tplv[^/]*/g, '');
      } catch (_) {
        return String(src).replace(/~tplv[^/]*/g, '').split('?')[0];
      }
    };
    const keys = new Set();
    document.querySelectorAll('img[src*="rc_gen_image"]').forEach((img) => {
      const src = img.getAttribute('src') || img.currentSrc || '';
      if (src) keys.add(keyOf(src));
    });
    return keys.size;
  }).catch(() => 0);
}

/** 解析预期生成张数：正整数且 1..20 合法，否则返回 0（表示未知） */
function normalizeExpectedCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(20, Math.floor(n));
}

/** 等待生成图片出现且数量稳定（或达到预期张数）；返回最终数量（0 = 超时未出现）；任务被中止时抛出 AbortError
 *  预期张数已知时：达到 expectedCount 即视为完成；未达标但数量长时间不增长（避免豆包只出部分图时空等）也会收手。
 *  预期张数未知时：按"数量不再增长"判断（比旧版固定 2 次轮询更保守，等待更久一些）。 */
async function waitForGeneration(page, timeoutMs, taskId, expectedCount) {
  const expected = normalizeExpectedCount(expectedCount);
  // 未达预期时允许的"不再增长"次数（2 秒一次）：已知预期 10 次（约 20 秒），未知预期 5 次（约 10 秒）
  const maxStablePolls = expected > 0 ? 10 : 5;
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stablePolls = 0;
  log('info', expected > 0
    ? `等待生图完成（预期 ${expected} 张，最长 ${Math.round(timeoutMs / 1000)} 秒）…`
    : `等待生图完成（最长 ${Math.round(timeoutMs / 1000)} 秒）…`);
  while (Date.now() < deadline) {
    throwIfAborted(taskId);
    const count = await countGeneratedImages(page);
    if (count !== lastCount) {
      log('info', expected > 0 ? `已发现 ${count}/${expected} 张生成图片` : `已发现 ${count} 张生成图片`);
    }
    if (count > 0) {
      if (expected > 0 && count >= expected) {
        log('info', `已达到预期数量（${count}/${expected}），等待 2 秒让页面稳定…`);
        await page.waitForTimeout(2000);
        return count;
      }
      if (count === lastCount) {
        stablePolls += 1;
        if (stablePolls >= maxStablePolls) {
          if (expected > 0) {
            log('warn', `生成图片数量长时间未再增长（${count}/${expected}），按已出张数继续`);
          }
          break;
        }
      } else {
        stablePolls = 0;
      }
    } else {
      stablePolls = 0;
    }
    lastCount = count;
    await page.waitForTimeout(2000);
  }
  return lastCount <= 0 ? 0 : lastCount;
}

/** URL 是否为豆包对话详情页（/chat/<id>），说明已经提交过 */
function isChatDetailUrl(url) {
  return /\/chat\/[A-Za-z0-9_-]{8,}/.test(url || '');
}

/**
 * 人工干预后继续执行：只检测页面、等待已提交的生成完成，绝不替用户点击发送。
 *
 * 返回：
 *   { ok: true, state: 'already_generated', images_found }  — 页面已有生成图（或等待后出现），可直接提取
 *   { ok: true, state: 'fresh' }                            — 页面是全新对话、什么都没提交，调用方可重新执行完整流程
 *   { ok: false, reason: 'prompt_pending_submit', ... }     — 输入框有提示词但未发送：请用户在浏览器点发送后再点“继续执行”
 *   { ok: false, reason: 'generation_timeout', ... }        — 已提交但超时未出图
 *   { ok: false, reason: 'browser_not_started', ... }       — 浏览器/页面已关闭
 */
async function resumeGenerate(cmd) {
  const accountId = cmd.account_id;
  // 新一次「继续执行」：清除该任务此前的中止标记
  clearAbort(cmd.task_id);
  const ctx = contexts.get(accountId);
  if (!ctx) {
    return { ok: false, reason: 'browser_not_started', message: '浏览器未启动或页面已关闭，无法继续。请先在「账号管理」中打开登录页，或重新运行任务。' };
  }
  const page = await acquirePage(ctx);
  if (page.isClosed()) {
    return { ok: false, reason: 'browser_not_started', message: '页面已关闭，无法继续。请重新运行任务。' };
  }

  await dismissPageOverlays(page);

  // 与主流程保持一致：恢复时也保证处于「图像生成」模式（对话模式没有文件上传入口）
  try {
    await genParams.ensureImageMode(page, (level, msg) => log(level, msg));
  } catch (err) {
    log('warn', `切换图像生成模式失败: ${err && err.message ? err.message : String(err)}`);
  }

  const url = page.url();
  const existing = await countGeneratedImages(page);
  if (existing > 0) {
    log('info', `页面已有 ${existing} 张生成图片，跳过提交，直接提取`);
    return { ok: true, state: 'already_generated', images_found: existing };
  }

  if (isChatDetailUrl(url)) {
    // 已提交过：只等待生成完成，不再提交
    const timeoutMs = cmd.generation_timeout_ms || 180000;
    const lastCount = await waitForGeneration(page, timeoutMs, cmd.task_id, cmd.expected_images);
    if (lastCount > 0) {
      return { ok: true, state: 'already_generated', images_found: lastCount };
    }
    return { ok: false, reason: 'generation_timeout', images_found: 0, message: '等待生图超时，页面未出现生成图片。' };
  }

  const onDoubao = /doubao\.com/.test(url);
  if (onDoubao) {
    const textboxState = await page.evaluate(() => {
      const el = document.querySelector('textarea,[contenteditable="true"]');
      if (!el) return 'missing';
      const text = (el.innerText || el.value || '').trim();
      return text.length > 0 ? 'filled' : 'empty';
    }).catch(() => 'missing');
    if (textboxState === 'filled') {
      // 人工确认模式：用户已确认，替用户点击发送（仅一次）
      if (cmd.submit_pending) {
        const submitBtn = await findSubmitButton(page);
        if (!submitBtn) {
          return { ok: false, reason: 'submit_button_not_found', message: '未找到发送按钮，请手动发送后再点「继续执行」。' };
        }
        try {
          await submitBtn.el.click({ timeout: 5000 });
          log('info', `人工确认后已点击发送按钮: ${submitBtn.sel}`);
        } catch (err) {
          await dismissPageOverlays(page);
          try {
            await submitBtn.el.click({ timeout: 5000 });
          } catch (err2) {
            return { ok: false, reason: 'submit_click_failed', message: `点击发送按钮失败: ${err2.message}` };
          }
        }
        const timeoutMs = cmd.generation_timeout_ms || 180000;
        const lastCount = await waitForGeneration(page, timeoutMs, cmd.task_id, cmd.expected_images);
        if (lastCount > 0) {
          return { ok: true, state: 'already_generated', images_found: lastCount };
        }
        return { ok: false, reason: 'generation_timeout', images_found: 0, message: '等待生图超时，页面未出现生成图片。' };
      }
      // 不盲目点击发送：请用户确认
      return {
        ok: false,
        reason: 'prompt_pending_submit',
        message: '检测到输入框里有未发送的提示词。为避免误提交，请在可见浏览器中确认后点击「发送」，然后再次点击「继续执行」。',
      };
    }
    // 全新对话页且输入框为空：什么都没提交，可以重新执行完整流程
    return { ok: true, state: 'fresh' };
  }

  // 页面不在豆包（about:blank / 网络错误页等）：视为未提交，可重新执行
  return { ok: true, state: 'fresh' };
}

/**
 * 生成一张/组图片：打开新对话页 → 上传参考图 → 输入提示词 → 提交 → 等待生成完成。
 *
 * 安全策略（task.md 铁律）：
 *   - 不盲目点击：所有可点击目标先探测存在性与可见性；找不到即停止并保存诊断；
 *   - 状态不明绝不重试提交：本命令只提交一次；
 *   - 登录失效/验证码/网页结构变化 → ok:false + reason，等待人工干预。
 */
/** generate_images：可选 Playwright Trace（每轮结束后保存 trace.zip，仅调试用途） */
async function generateImages(cmd) {
  const projectRoot = path.resolve(cmd.project_root || '.');
  const roundDir = cmd.round_dir ? path.resolve(cmd.round_dir) : null;
  const destDir = roundDir || path.join(projectRoot, 'output');
  const traceOn = !!cmd.trace;
  const accountId = cmd.account_id;
  const ctx = contexts.get(accountId);
  let traceStarted = false;
  if (traceOn && ctx) {
    try {
      ensureDir(destDir);
      await ctx.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      traceStarted = true;
      log('info', 'Playwright Trace 已开始记录（本轮结束后保存 trace.zip）');
    } catch (err) {
      log('warn', `Trace 启动失败: ${err.message}`);
    }
  }
  try {
    return await generateImagesInner(cmd);
  } finally {
    if (traceStarted && ctx) {
      try {
        const tracePath = path.join(destDir, 'trace.zip');
        await ctx.context.tracing.stop({ path: tracePath });
        log('info', `Playwright Trace 已保存: ${tracePath}`);
      } catch (err) {
        log('warn', `Trace 保存失败: ${err.message}`);
      }
    }
  }
}

async function generateImagesInner(cmd) {
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
      fs.writeFileSync(
        path.join(diagDir, `${tag}_${stamp}.json`),
        JSON.stringify({ tag, url: page.url(), timestamp: new Date().toISOString() }, null, 2),
        'utf-8'
      );
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
  // 推广弹窗可能晚于 hydration 出现：持续关闭直到页面稳定干净
  await waitAndDismissOverlays(page, { timeoutMs: 8000, stableMs: 1200 });

  // 生图流程必须处于「图像生成」模式，否则页面没有文件上传入口（切换到图像生成 tab）
  try {
    await genParams.ensureImageMode(page, (level, msg) => log(level, msg));
  } catch (err) {
    log('warn', `切换图像生成模式失败: ${err && err.message ? err.message : String(err)}`);
  }

  // 进入页面后应用图像生成参数（设置模型/比例/风格）
  if (cmd.apply_gen_params && cmd.gen_params) {
    try {
      await genParams.applyGenParams(page, cmd.gen_params, (level, msg) => log(level, msg));
    } catch (err) {
      log('warn', `应用图像生成参数失败: ${err && err.message ? err.message : String(err)}`);
    }
  }

  // 登录检查：页面若提示登录，交人工处理
  const pageText = await page.locator('body').innerText().catch(() => '');
  if (/扫码登录|手机号登录|验证码登录|立即登录/.test(pageText) && !/退出|个人中心/.test(pageText)) {
    await saveDiag('login_required');
    return { ok: false, reason: 'login_required' };
  }

  // 验证码/人机风控检查：暂停等待人工处理（绝不自动绕过），落诊断信息
  if (isCaptchaText(pageText)) {
    log('warn', '检测到验证码/人机风控页，暂停等待人工处理');
    await saveDiag('captcha_required');
    return { ok: false, reason: 'captcha_required' };
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
  throwIfAborted(cmd.task_id);
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
  throwIfAborted(cmd.task_id);
  const textboxCount = await page.locator('textarea,[contenteditable="true"]').count();
  if (textboxCount === 0) {
    await saveDiag('textbox_not_found');
    return { ok: false, reason: 'textbox_not_found' };
  }
  const textbox = page.locator('textarea,[contenteditable="true"]').first();
  await waitAndDismissOverlays(page, { timeoutMs: 5000, stableMs: 600 }); // 输入前最后关闭遮罩
  try {
    await textbox.click({ timeout: 5000 });
  } catch (err) {
    // 输入框点击被遮罩拦截：再次关闭遮罩后重试一次（与发送按钮相同的兜底）
    log('warn', `点击提示词输入框失败（${err.message}），尝试关闭遮罩后重试…`);
    await waitAndDismissOverlays(page, { timeoutMs: 5000, stableMs: 800 });
    try {
      await textbox.click({ timeout: 5000 });
    } catch (err2) {
      await saveDiag('prompt_click_failed');
      return { ok: false, reason: 'prompt_click_failed', message: err2.message };
    }
  }
  try {
    await page.keyboard.insertText(prompt);
  } catch (err) {
    await saveDiag('prompt_insert_failed');
    return { ok: false, reason: 'prompt_insert_failed', message: err.message };
  }
  log('info', '提示词已输入');
  await waitAndDismissOverlays(page, { timeoutMs: 5000, stableMs: 800 }); // 上传后弹窗可能再次出现

  // 人工确认模式：上传完成、提示词已填，暂停等待用户确认后再提交
  if (cmd.pause_before_submit) {
    log('info', '人工确认模式：已上传参考图并填写提示词，等待用户确认后提交');
    return { ok: true, state: 'awaiting_confirmation', reason: 'confirmation_required' };
  }

  // 5. 提交（只提交一次；找不到按钮即停止，不盲目点击）
  // 提交前最后检查一次中止标记：用户已暂停/取消时绝不提交
  throwIfAborted(cmd.task_id);
  const submitBtn = await findSubmitButton(page);
  if (!submitBtn) {
    await saveDiag('submit_button_not_found');
    return { ok: false, reason: 'submit_button_not_found', message: '未找到发送按钮。页面结构可能已变化，请查看诊断截图。' };
  }
  try {
    await submitBtn.el.click({ timeout: 5000 });
    log('info', `已点击发送按钮: ${submitBtn.sel}`);
  } catch (err) {
    // 点击可能被再次弹出的广告遮罩拦截：尝试关闭后重试一次
    log('warn', `点击发送按钮失败（${err.message}），尝试关闭遮罩后重试…`);
    await dismissPageOverlays(page);
    try {
      await submitBtn.el.click({ timeout: 5000 });
      log('info', `已点击发送按钮（重试）: ${submitBtn.sel}`);
    } catch (err2) {
      await saveDiag('submit_click_failed');
      return { ok: false, reason: 'submit_click_failed', message: `点击发送按钮失败: ${err2.message}` };
    }
  }

  // 6. 等待生成完成：img[src*=rc_gen_image] 出现且数量稳定
  const genTimeoutMs = cmd.generation_timeout_ms || 180000;
  const lastCount = await waitForGeneration(page, genTimeoutMs, cmd.task_id, cmd.expected_images);
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
    // 暂停/取消：停止继续下载；已下载完成的文件保留
    if (isAborted(cmd.task_id)) {
      log('warn', `收到中止请求，停止后续下载（已完成 ${results.length}/${images.length}）`);
      break;
    }
    const item = images[i];
    const index = (item.index != null ? item.index : i) + 1;
    const destPath = path.join(roundDir, `${String(index).padStart(3, '0')}.png`);

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
  // 暂停/取消：只设置中止标记，不打断其他命令的处理流程
  if (cmd.cmd === 'abort') {
    if (cmd.task_id != null) abortedTasks.add(cmd.task_id);
    log('warn', `收到中止请求（任务 ${cmd.task_id}，原因：${cmd.reason || 'unknown'}）`);
    return { ok: true, aborted: true };
  }
  switch (cmd.cmd) {
    case 'start_browser':
      // 新一次执行：清除该任务此前的中止标记
      clearAbort(cmd.task_id);
      return await startBrowser(cmd.account_id, cmd.user_data_dir);
    case 'open_login':
      return await openLogin(cmd.account_id, cmd.user_data_dir);
    case 'stop_browser':
      return await stopBrowser(cmd.account_id);
    case 'scan_images':
      return await scanAndSelect(cmd);
    case 'generate_images':
      return await generateImages(cmd);
    case 'resume_generate':
      return await resumeGenerate(cmd);
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
            emit({ type: 'result', cmd: cmd.cmd, request_id: cmd.request_id, ...result });
          } catch (err) {
            if (err instanceof AbortError) {
              log('warn', `命令 ${cmd.cmd} 已中止: ${err.message}`);
              emit({ type: 'result', cmd: cmd.cmd, request_id: cmd.request_id, ok: false, reason: 'aborted', message: err.message });
              return;
            }
            log('error', `处理命令 ${cmd.cmd} 异常: ${err.message}`);
            emit({ type: 'error', cmd: cmd.cmd, request_id: cmd.request_id, message: err.message });
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

module.exports = { scanAndSelect, probeAndExtract, generateImages, resumeGenerate, downloadImages, startBrowser, stopBrowser, openLogin };
