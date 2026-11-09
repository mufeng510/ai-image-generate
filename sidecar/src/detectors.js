/**
 * sidecar/src/detectors.js
 *
 * 页面文本检测器（离线可测）。
 * 只对页面可见文本做判断，不执行任何点击——检测到即由调用方暂停等待人工处理，
 * 绝不自动绕过（验证码/人机风控本身必须由人完成）。
 */

'use strict';

/**
 * 验证码 / 人机风控页的特征文本。
 * 设计约束：
 *   - 不能命中登录页的「验证码登录」字样（那是登录页，由 login_required 处理）；
 *   - 宁可漏报（走 prompt/submit 失败兜底 → needs_manual_intervention），不可误报（误暂停正常任务）；
 *   - 「请完成…验证」只允许中间夹中文字符，避免误配英文报错页。
 */
const CAPTCHA_MARKERS = /请完成[一-龥]{0,8}验证|拖动滑块|滑动(拼图|条|验证)|人机验证|安全验证|人脸验证|访问[一-龥]{0,8}频繁|操作[一-龥]{0,8}频繁|not a robot|captcha/i;

/** 正文中是否出现验证码/人机风控特征 */
function isCaptchaText(text) {
    return CAPTCHA_MARKERS.test(text || '');
}

module.exports = { CAPTCHA_MARKERS, isCaptchaText };
