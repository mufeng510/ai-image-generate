#!/usr/bin/env node
/**
 * sidecar/src/index.js
 *
 * Doubao batch image generate automation sidecar (Node.js + Playwright Chromium).
 *
 * 通信方式：通过 stdin/stdout 与 Tauri Rust 后端交互。
 *   输入（stdin）：JSON 行协议，每行一个命令：
 *     {"cmd":"start_browser","account_id":1,"user_data_dir":"..."}
 *     {"cmd":"extract_images","dialog_url":"..."}
 *     {"cmd":"download_images","round_id":1,"images":[{"url":"...","index":0}]}
 *     {"cmd":"scan_images","project_id":1,"root_path":"..."}
 *     {"cmd":"stop_browser","account_id":1}
 *   输出（stdout）：JSON 行协议，每行一个事件：
 *     {"type":"log","level":"info","message":"..."}
 *     {"type":"event","event":"images_extracted","round_id":1,"images":[...]}
 *     {"type":"event","event":"download_progress","round_id":1,"current":1,"total":5}
 *     {"type":"event","event":"download_completed","round_id":1,"results":[...]}
 *     {"type":"error","cmd":"extract_images","message":"..."}
 *
 * 安全：不处理密码/令牌；登录状态仅通过 Chromium 持久化 userDataDir 保留；
 * 日志脱敏，不输出 Cookie/授权头。
 */

'use strict';

const { spawn } = require('child_process');
const { chromium } = require('playwright');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

/** 当前启动的浏览器上下文（按 account_id 索引，串行使用） */
const contexts = new Map(); // account_id -> { context, page, userDataDir }

/** 向 stdout 发送一行 JSON 事件 */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** 发送日志事件（脱敏，不输出敏感信息） */
function log(level, message) {
  if (LOG_LEVELS.indexOf(level) < 0) level = 'info';
  emit({ type: 'log', level, message, timestamp: new Date().toISOString() });
}

/** 启动可见 Chromium 持久化上下文（每账号独立 userDataDir） */
async function startBrowser(accountId, userDataDir) {
  if (contexts.has(accountId)) {
    log('warn', `账号 ${accountId} 浏览器已启动，跳过`);
    return { ok: true };
  }

  log('info', `启动可见 Chromium，账号 ${accountId}，用户数据目录: ${userDataDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // 必须有界面，用户可见
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  contexts.set(accountId, { context, page, userDataDir });
  log('info', `账号 ${accountId} 浏览器已启动`);
  return { ok: true };
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

/** 处理一条 stdin 命令 */
async function handleCommand(cmd) {
  try {
    switch (cmd.cmd) {
      case 'start_browser':
        return await startBrowser(cmd.account_id, cmd.user_data_dir);
      case 'stop_browser':
        return await stopBrowser(cmd.account_id);
      case 'extract_images':
        return await extractImages(cmd);
      case 'download_images':
        return await downloadImages(cmd);
      case 'scan_images':
        return await scanImages(cmd);
      default:
        throw new Error(`未知命令: ${cmd.cmd}`);
    }
  } catch (err) {
    log('error', `命令 ${cmd.cmd} 失败: ${err.message}`);
    return { ok: false, error: err.message };
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
          const result = await handleCommand(cmd);
          emit({ type: 'result', cmd: cmd.cmd, ...result });
        })().catch((err) => {
          log('error', `处理命令 ${cmd.cmd} 异常: ${err.message}`);
          emit({ type: 'error', cmd: cmd.cmd, message: err.message });
        });
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

/** 占位：图片提取（由 extractor.js 实现） */
async function extractImages(cmd) {
  throw new Error('extractor 未实现');
}

/** 占位：图片下载（由 downloader.js 实现） */
async function downloadImages(cmd) {
  throw new Error('downloader 未实现');
}

/** 占位：图片扫描（由 scanner.js 实现） */
async function scanImages(cmd) {
  throw new Error('scanner 未实现');
}

/** 入口 */
function main() {
  log('info', 'Doubao batch sidecar 启动');
  setupStdin();
}

main();
