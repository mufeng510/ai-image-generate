/**
 * sidecar/src/gen-params.js
 *
 * 在 Doubao「图像生成」模式下设置模型/比例/风格。
 * 仅应用经真实网页验证的枚举值；未匹配到控件时静默跳过（不中断任务，只写日志）。
 */
'use strict';

const GEN_MODEL_VALUES = new Set([
  'Seedream 5.0 Pro',
  'Seedream 5.0 Flash',
  'Seedream 4.5',
  'Seedream 4.0',
]);
const GEN_RATIO_VALUES = new Set([
  '自动', '9:16', '2:3', '3:4', '1:1', '4:3', '3:2', '16:9',
]);
const GEN_STYLE_VALUES = new Set([
  '人像摄影', '电影写真', '中国风', '动漫', '3D渲染', '赛博朋克', 'CG 动画', '水墨画', '油画', '古典', '水彩画', '卡通',
  '平面插画', '风景', '港风动漫', '像素风格', '荧光绘画', '彩铅画', '手办', '儿童绘画', '抽象', '锐笔插画', '二次元',
  '油墨印刷', '版画', '莫奈', '毕加索', '伦勃朗', '马蒂斯', '巴洛克', '复古动漫', '绘本',
]);

/** 确保当前页面处于「图像生成」模式（页面底部出现对应 chip 时无需操作） */
async function ensureImageMode(page, log) {
  // 每次生图调用前都切到图像生成模式；已在该模式下则无操作
  const existing = await page
    .locator('[data-testid="skill_input_exit_button"]')
    .count()
    .catch(() => 0);
  if (existing > 0) return;
  const btn = page.getByRole('button', { name: '图像生成' });
  if ((await btn.count()) === 0) {
    log('warn', '未找到「图像生成」入口，尝试按已有默认模式继续');
    return;
  }
  await btn
    .first()
    .click({ timeout: 5000 })
    .catch((err) => log('warn', `点击「图像生成」失败: ${err.message}`));
  await page.waitForTimeout(800);
}

/**
 * 应用图像生成参数。未匹配的字段会写日志跳过，不会抛出异常。
 * @param {object} page Playwright Page
 * @param {object} params 例：{ model: 'Seedream 4.5', ratio: '1:1', style: '油画' }
 * @param {(level: string, message: string) => void} log 日志函数
 */
async function applyGenParams(page, params, log) {
  if (!params || typeof params !== 'object') return;
  const normalized = {
    model: params.model ? String(params.model).trim() : '',
    ratio: params.ratio ? String(params.ratio).trim() : '',
    style: params.style ? String(params.style).trim() : '',
  };
  if (normalized.model && !GEN_MODEL_VALUES.has(normalized.model)) {
    log('warn', `gen_params.model 不在已验证枚举中，已忽略: ${normalized.model}`);
    normalized.model = '';
  }
  if (normalized.ratio && !GEN_RATIO_VALUES.has(normalized.ratio)) {
    log('warn', `gen_params.ratio 不在已验证枚举中，已忽略: ${normalized.ratio}`);
    normalized.ratio = '';
  }
  if (normalized.style && !GEN_STYLE_VALUES.has(normalized.style)) {
    log('warn', `gen_params.style 不在已验证枚举中，已忽略: ${normalized.style}`);
    normalized.style = '';
  }
  if (!normalized.model && !normalized.ratio && !normalized.style) return;

  await ensureImageMode(page, log);

  const clickOption = async (value) => {
    const option = page.getByText(value, { exact: true });
    if ((await option.count()) === 0) {
      log('warn', `未找到选项「${value}」`);
      return false;
    }
    await option
      .first()
      .click({ timeout: 3000 })
      .catch((err) => log('warn', `点击「${value}」失败: ${err.message}`));
    await page.waitForTimeout(250);
    return true;
  };

  const openMenu = async (selector) => {
    const trigger = page.locator(selector);
    if ((await trigger.count()) === 0) {
      log('warn', `未找到参数控件: ${selector}`);
      return false;
    }
    await trigger.first().click({ timeout: 3000, force: true }).catch((err) => {
      log('warn', `打开 ${selector} 失败: ${err.message}`);
    });
    await page.waitForTimeout(350);
    return true;
  };

  if (normalized.model) {
    const opened = await openMenu('[data-input-engine-actionbar-control-key="model"]');
    if (opened) await clickOption(normalized.model);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
  if (normalized.style) {
    const opened = await openMenu('[data-input-engine-actionbar-control-key="style"]');
    if (opened) await clickOption(normalized.style);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
  if (normalized.ratio) {
    const opened = await openMenu('[data-input-engine-actionbar-render-entry-key="image-generation-params-panel"]');
    if (opened) await clickOption(normalized.ratio);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
}

module.exports = {
  GEN_MODEL_VALUES,
  GEN_RATIO_VALUES,
  GEN_STYLE_VALUES,
  ensureImageMode,
  applyGenParams,
};
