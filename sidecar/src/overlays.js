/**
 * sidecar/src/overlays.js
 *
 * 通用遮罩/弹窗（广告、签到、推广等）自动关闭。独立模块，便于 index.js 复用与离线回归测试。
 *
 * 策略（按优先级，多轮重试直到没有可见遮罩）：
 *   1. 找到可见的弹窗容器（role=dialog / aria-modal / class 含 modal|overlay|mask|popup|advert|backdrop 等），
 *      点击容器内的关闭按钮（aria-label 含“关闭/Close”、class 含 close、.semi-modal-close、Radix
 *      [data-slot=dialog-close|alert-dialog-close]、“关闭”文本按钮）。
 *   2. 按 Escape（多数弹窗支持）。
 *   3. 点击遮罩（mask/backdrop 类、覆盖视口大部分的 fixed/absolute 元素）的左上角空白处——很多半遮罩点击空白即关闭。
 * 每轮操作后重新验证；最多 maxPasses 轮。全部失败返回 false（调用方继续执行并记录诊断）。
 *
 * 背景：豆包 fresh 浏览器档案首次访问 chat/ 页面会弹出「下载电脑版 使用完整功能」推广弹窗（Radix
 * Dialog，role=dialog，全视口固定定位），渲染时机晚于 page load（React hydration 之后）。单次
 * dismissPageOverlays 可能在弹窗出现前执行，导致后续点击输入框被弹窗拦截（pointer events 被遮挡）。
 * 因此提供 waitAndDismissOverlays：持续轮询直到连续 stableMs 内无可见遮罩，覆盖晚出现的弹窗。
 */

'use strict';

let logFn = () => {};
/** 注入日志函数：index.js 用自己的脱敏 log；测试可捕获。 */
function setLogger(fn) {
  logFn = typeof fn === 'function' ? fn : () => {};
}

const OVERLAY_CONTAINER_SELECTOR = [
  'div[role="dialog"]',
  'div[aria-modal="true"]',
  '.semi-modal',
  '[class*="modal" i]',
  '[class*="overlay" i]',
  '[class*="mask" i]',
  '[class*="popup" i]',
  '[class*="advert" i]',
  '[class*="backdrop" i]',
].join(',');

const OVERLAY_CLOSE_SELECTOR = [
  'button[aria-label*="关闭"]',
  '[role="button"][aria-label*="关闭"]',
  'button[aria-label*="close" i]',
  '[role="button"][aria-label*="close" i]',
  // Radix Dialog / AlertDialog 的关闭按钮（豆包推广弹窗属于这类）
  '[data-slot="dialog-close"]',
  '[data-slot="alert-dialog-close"]',
  '.semi-modal-close',
  '[class*="close" i]',
  'button:has-text("关闭")',
  '[role="button"]:has-text("关闭")',
].join(',');

/** 页面上是否仍存在可见且面积足够大的遮罩/弹窗容器 */
async function hasVisibleOverlay(page) {
  return await page.evaluate((sel) => {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const els = Array.from(document.querySelectorAll(sel));
    return els.some((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 80) return false;
      const coverage = (r.width * r.height) / (vw * vh);
      const positioned = style.position === 'fixed' || style.position === 'absolute' || (Number(style.zIndex) || 0) >= 10;
      // 全屏/大面积遮罩，或较大的固定定位弹窗
      return positioned && coverage > 0.12;
    });
  }, OVERLAY_CONTAINER_SELECTOR).catch(() => false);
}

/** 尝试关闭所有可见遮罩/弹窗。返回成功关闭的弹窗数量。 */
async function dismissPageOverlays(page, maxPasses = 4) {
  let dismissed = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (!(await hasVisibleOverlay(page))) break;

    // 1) 容器内的关闭按钮（从后往前的 DOM 顺序，通常后出现的在更上层）
    const containers = page.locator(OVERLAY_CONTAINER_SELECTOR);
    const count = await containers.count().catch(() => 0);
    let closed = false;
    for (let i = count - 1; i >= 0 && !closed; i--) {
      const container = containers.nth(i);
      if (!(await container.isVisible().catch(() => false))) continue;
      const box = await container.boundingBox().catch(() => null);
      if (!box || box.width < 120 || box.height < 80) continue;
      const closeBtns = container.locator(OVERLAY_CLOSE_SELECTOR);
      const btnCount = await closeBtns.count().catch(() => 0);
      for (let j = btnCount - 1; j >= 0; j--) {
        const btn = closeBtns.nth(j);
        if (!(await btn.isVisible().catch(() => false))) continue;
        try {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(600);
          if (!(await hasVisibleOverlay(page))) {
            logFn('info', '遮罩/弹窗已通过关闭按钮关闭');
            closed = true;
            dismissed++;
            break;
          }
        } catch (_) { /* 尝试下一个候选 */ }
      }
    }
    if (closed) continue;

    // 2) Escape
    logFn('info', '检测到遮罩/弹窗，尝试 Escape 关闭');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    if (!(await hasVisibleOverlay(page))) {
      logFn('info', '遮罩/弹窗已通过 Escape 关闭');
      dismissed++;
      continue;
    }

    // 3) 点击遮罩左上角空白处（避开弹窗本体）
    const backdrops = page.locator('[class*="mask" i],[class*="backdrop" i],[class*="overlay" i]');
    const bdCount = await backdrops.count().catch(() => 0);
    let backdropClosed = false;
    for (let i = bdCount - 1; i >= 0; i--) {
      const bd = backdrops.nth(i);
      if (!(await bd.isVisible().catch(() => false))) continue;
      const box = await bd.boundingBox().catch(() => null);
      if (!box || box.width < 200 || box.height < 200) continue;
      try {
        // 左上角 8px 处基本都是遮罩空白区域（弹窗通常居中）
        await bd.click({ position: { x: 8, y: 8 }, timeout: 2000 });
        await page.waitForTimeout(500);
        if (!(await hasVisibleOverlay(page))) {
          logFn('info', '遮罩/弹窗已通过点击遮罩关闭');
          backdropClosed = true;
          dismissed++;
          break;
        }
      } catch (_) { /* 尝试下一个候选 */ }
    }
    if (backdropClosed) continue;

    logFn('warn', '未能自动关闭遮罩/弹窗（可人工关闭后继续）');
    break;
  }
  return dismissed;
}

/**
 * 持续关闭遮罩，直到连续 stableMs 内页面干净（覆盖弹窗晚于 hydration 出现的场景）。
 * 总超时 timeoutMs；返回关闭的弹窗数量。页面干净且稳定后尽快返回。
 */
async function waitAndDismissOverlays(page, { timeoutMs = 8000, stableMs = 1200, intervalMs = 400 } = {}) {
  const start = Date.now();
  let cleanSince = 0;
  let dismissed = 0;
  while (Date.now() - start < timeoutMs) {
    dismissed += await dismissPageOverlays(page);
    if (await hasVisibleOverlay(page)) {
      cleanSince = 0;
      await page.waitForTimeout(intervalMs);
      continue;
    }
    if (!cleanSince) cleanSince = Date.now();
    if (Date.now() - cleanSince >= stableMs) break;
    await page.waitForTimeout(intervalMs);
  }
  if (await hasVisibleOverlay(page)) {
    logFn('warn', 'waitAndDismissOverlays：超时后仍存在可见遮罩/弹窗');
  }
  return dismissed;
}

module.exports = {
  OVERLAY_CONTAINER_SELECTOR,
  OVERLAY_CLOSE_SELECTOR,
  hasVisibleOverlay,
  dismissPageOverlays,
  waitAndDismissOverlays,
  setLogger,
};
