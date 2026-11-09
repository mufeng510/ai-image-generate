/**
 * sidecar/src/detectors.test.js
 *
 * 验证码/人机风控检测器的离线文本用例（node src/detectors.test.js）。
 * 不访问真实豆包页面；页面级构造成真实风控页无法可靠复现，按 B8 记录跳过原因。
 */

'use strict';

const assert = require('assert');
const { isCaptchaText } = require('./detectors');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed += 1;
        console.log(`  ✗ ${name}: ${err.message}`);
    }
}

console.log('验证码/人机风控检测用例：');

const CAPTCHA_CASES = [
    '请完成下列验证后继续访问',
    '请完成以下验证',
    '请完成验证',
    '拖动滑块至虚线位置',
    '滑动拼图完成上方拼图',
    '滑动条验证',
    '滑动验证',
    '人机验证中，请稍候',
    '安全验证：为确认是您本人操作',
    '人脸验证失败，请重试',
    '访问过于频繁，请稍后再试',
    '访问频繁，请稍后再试',
    '操作过于频繁，请稍后再试',
    '操作频繁',
    'not a robot',
    'Please complete the CAPTCHA to continue',
];

for (const sample of CAPTCHA_CASES) {
    test(`命中验证码：「${sample}」`, () => {
        assert.strictEqual(isCaptchaText(sample), true);
    });
}

const NORMAL_CASES = [
    '有什么我能帮你的吗？',
    '扫码登录 手机号登录 验证码登录 立即登录', // 登录页：由 login_required 处理，不应判为验证码
    '验证码登录',
    '手机验证码登录',
    '奶瓶清洗收纳盒小红书配图设计',
    '这段文案里没有出现风控特征：春天到了',
    '',
    'valid: 页面加载完成的正常聊天记录',
];

for (const sample of NORMAL_CASES) {
    test(`不误判：「${sample}」`, () => {
        assert.strictEqual(isCaptchaText(sample), false);
    });
}

console.log(`\n通过 ${passed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
