/**
 * sidecar/src/deleter.js
 *
 * 删除「当前正在查看的豆包会话」（打开会话 → 右上角 ⋯ →「删除」→确认框红色「删除」）。
 *
 * 安全铁律（与本项目一致的保守策略）：
 *   - 只删当前页面 /chat/<id> 这一个会话；URL 匹配不到会话详情页即跳过；
 *   - 找不到任何目标元素（按钮/菜单/菜单项/确认框）一律不猜、不盲点，直接返回 ok:false + reason；
 *   - 确认对话框只点红色「删除」按钮；找不到就不点；
 *   - 删除失败绝不阻断主流程（图片已落盘），由调用方决定记日志后继续。
 */

'use strict';

/** 从页面 URL 提取会话 id（/chat/<digits>）；不是会话详情页返回 null */
function chatIdFromUrl(url) {
  const m = /\/chat\/(\d{6,})(?:[/?#]|$)/.exec(url || '');
  return m ? m[1] : null;
}

/**
 * 打开右上角 ⋯ 菜单 → 点「删除」菜单项 → 确认对话框点红色「删除」。
 * 返回 { ok, verified?, chat_id?, reason?, message? }。
 */
async function deleteCurrentConversation(page) {
  const url = page.url();
  const chatId = chatIdFromUrl(url);
  if (!chatId) {
    return { ok: false, reason: 'not_chat_detail', message: '当前页面不是会话详情页，未执行删除' };
  }

  // 右上角 ⋯（最后一个"更多"按钮；侧边栏条目上的「更多」在其之前）
  const more = page.locator('button[aria-label="更多"]').last();
  if ((await more.count()) === 0) {
    return { ok: false, reason: 'more_button_not_found' };
  }
  try {
    await more.click({ timeout: 5000 });
  } catch (err) {
    return { ok: false, reason: 'more_click_failed', message: (err && err.message) || String(err) };
  }

  // 菜单出现后点「删除」
  const menu = page.locator('[role="menu"]').last();
  try {
    await menu.waitFor({ state: 'visible', timeout: 5000 });
  } catch (_) {
    return { ok: false, reason: 'menu_not_opened' };
  }
  const deleteItem = menu.locator('[role="menuitem"]', { hasText: '删除' }).first();
  if ((await deleteItem.count()) === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'delete_menuitem_not_found', message: '菜单中未找到「删除」，已按 Esc 关闭菜单' };
  }
  try {
    await deleteItem.click({ timeout: 5000 });
  } catch (err) {
    return { ok: false, reason: 'delete_click_failed', message: (err && err.message) || String(err) };
  }

  // 确认对话框（含「删除」文案），只点红色「删除」按钮
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: '删除' }).first();
  try {
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
  } catch (_) {
    return { ok: false, reason: 'confirm_dialog_not_found', message: '未出现删除确认对话框' };
  }
  const confirmBtn = dialog.locator('button', { hasText: '删除' }).last();
  if ((await confirmBtn.count()) === 0) {
    return { ok: false, reason: 'confirm_button_not_found', message: '确认对话框中未找到红色「删除」按钮' };
  }
  try {
    await confirmBtn.click({ timeout: 5000 });
  } catch (err) {
    return { ok: false, reason: 'confirm_click_failed', message: (err && err.message) || String(err) };
  }
  await page.waitForTimeout(1500);

  // 尽量验证：URL 已离开该会话，或侧边栏条目已消失
  const urlAway = !page.url().includes(chatId);
  const itemGone = (await page.locator(`a#conversation_${chatId}`).count().catch(() => 0)) === 0;
  return { ok: true, chat_id: chatId, verified: urlAway || itemGone };
}

module.exports = { chatIdFromUrl, deleteCurrentConversation };
