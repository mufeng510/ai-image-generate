/**
 * sidecar/src/deleter.js
 *
 * 删除「当前正在查看的豆包会话」（打开会话 → 右上角 ⋯ →「删除」→确认框红色「删除」）。
 *
 * 安全铁律（与本项目一致的保守策略）：
 *   - 只删当前页面 /chat/<id> 这一个会话；URL 匹配不到会话详情页即跳过；
 *   - 找不到任何目标元素（按钮/菜单/菜单项/确认框）一律不猜、不盲点，直接返回 ok:false + reason；
 *   - 确认对话框只点「删除」类按钮，绝不点「取消」；
 *   - 删除失败绝不阻断主流程（图片已落盘），由调用方决定记日志后继续。
 *
 * 页面结构会变：选择器做多候选 + 位置打分，任何一步失败都落诊断快照（由调用方 onFail 提供）。
 */

'use strict';

/** 从页面 URL 提取会话 id（/chat/<digits>）；不是会话详情页返回 null */
function chatIdFromUrl(url) {
  const m = /\/chat\/(\d{6,})(?:[/?#]|$)/.exec(url || '');
  return m ? m[1] : null;
}

/** 候选选择器中挑一个可见元素：右侧优先、靠上优先，避免误点侧边栏会话条目的「更多」 */
async function findMoreButton(page) {
  const selectors = [
    'button[aria-label="更多"]',
    '[role="button"][aria-label="更多"]',
    '[aria-label="更多操作"]',
    '[aria-label="更多选项"]',
    'button:has-text("⋯")',
    'button:has-text("…")',
    '[data-testid*="more"]',
    '[data-testid*="More"]',
  ];
  const viewWidth = (page.viewportSize() && page.viewportSize().width) || 1440;
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const selector of selectors) {
    let locator;
    try { locator = page.locator(selector); } catch (_) { continue; }
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box) continue;
      const onRight = box.x + box.width / 2 > viewWidth * 0.5;
      const score = (onRight ? 0 : 1000) + box.y;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
  }
  return best;
}

/** 找到菜单容器（兼容 role=menu / listbox / popover） */
async function findMenu(page) {
  const selectors = ['[role="menu"]', '[role="listbox"]', '[data-testid*="menu"]', '[data-radix-menu-content]'];
  for (const selector of selectors) {
    const loc = page.locator(selector).last();
    if ((await loc.count().catch(() => 0)) > 0 && await loc.isVisible().catch(() => false)) return loc;
  }
  return null;
}

/** 找到确认弹窗（兼容 role=dialog / alertdialog / 常见自定义 modal） */
async function findConfirmDialog(page) {
  const selectors = ['[role="dialog"]', '[role="alertdialog"]', '[data-testid*="modal"]', '.semi-modal'];
  for (const selector of selectors) {
    const locs = page.locator(selector).filter({ hasText: '删除' });
    const n = await locs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const loc = locs.nth(i);
      if (await loc.isVisible().catch(() => false)) return loc;
    }
  }
  return null;
}

/** 在确认弹窗里找「删除」类按钮；绝不返回「取消」 */
async function findConfirmButton(dialog) {
  const buttons = dialog.locator('button');
  const n = await buttons.count().catch(() => 0);
  let fallback = null;
  for (let i = 0; i < n; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const text = ((await btn.innerText().catch(() => '')) || '').trim();
    if (/^(删除|确认删除|确定删除|确定)$/.test(text)) return btn;
    if (/取消|关闭|返回/.test(text)) continue;
    if (/删除/.test(text) && !fallback) fallback = btn;
  }
  return fallback;
}

/**
 * 打开右上角 ⋯ 菜单 → 点「删除」菜单项 → 确认对话框点「删除」。
 * 返回 { ok, verified?, chat_id?, reason?, message? }。
 * options.onFail(reason) 可用于保存诊断快照（截图 + HTML + JSON）。
 */
async function deleteCurrentConversation(page, options = {}) {
  const onFail = typeof options.onFail === 'function' ? options.onFail : async () => {};
  const fail = async (reason, message) => {
    try { await onFail(reason); } catch (_) { /* 诊断失败不影响主流程 */ }
    return { ok: false, reason, ...(message ? { message } : {}) };
  };
  const url = page.url();
  const chatId = chatIdFromUrl(url);
  if (!chatId) {
    return fail('not_chat_detail', `当前页面不是会话详情页，未执行删除：${url}`);
  }

  const more = await findMoreButton(page);
  if (!more) {
    return fail('more_button_not_found', '未找到右上角「更多」按钮，已跳过删除（页面结构可能变化）');
  }
  try {
    await more.click({ timeout: 5000 });
  } catch (err) {
    return fail('more_click_failed', (err && err.message) || String(err));
  }

  const menu = await findMenu(page);
  if (!menu) {
    return fail('menu_not_opened', '点击「更多」后未出现菜单');
  }
  const deleteItem = menu.locator('[role="menuitem"], [role="option"], li, button').filter({ hasText: '删除' }).first();
  if ((await deleteItem.count().catch(() => 0)) === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return fail('delete_menuitem_not_found', '菜单中未找到「删除」，已按 Esc 关闭菜单');
  }
  try {
    await deleteItem.click({ timeout: 5000 });
  } catch (err) {
    return fail('delete_click_failed', (err && err.message) || String(err));
  }

  const dialog = await findConfirmDialog(page);
  if (!dialog) {
    return fail('confirm_dialog_not_found', '未出现删除确认对话框');
  }
  const confirmBtn = await findConfirmButton(dialog);
  if (!confirmBtn) {
    return fail('confirm_button_not_found', '确认对话框中未找到「删除」类按钮');
  }
  try {
    await confirmBtn.click({ timeout: 5000 });
  } catch (err) {
    return fail('confirm_click_failed', (err && err.message) || String(err));
  }
  await page.waitForTimeout(1500);

  // 尽量验证：URL 已离开该会话，或侧边栏条目已消失
  const urlAway = !page.url().includes(chatId);
  const itemGone = (await page.locator(`a#conversation_${chatId}`).count().catch(() => 0)) === 0
    && (await page.locator(`[data-testid*="conversation_${chatId}"]`).count().catch(() => 0)) === 0;
  return { ok: true, chat_id: chatId, verified: urlAway || itemGone };
}

module.exports = { chatIdFromUrl, deleteCurrentConversation };
