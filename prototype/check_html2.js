const fs = require('fs');
const html = fs.readFileSync('.output/diagnostics/before-download_2026-11-03T01-53-19.051Z.html', 'utf-8');

// 提取所有 img src
const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
const urls = [];
let m;
while ((m = imgRegex.exec(html)) !== null) {
  urls.push(m[1]);
}
console.log('HTML 中 img 标签数量:', urls.length);

// 分类统计
const iconCount = urls.filter(u => u.toLowerCase().includes('/icon/') || u.toLowerCase().includes('action_bar_icon')).length;
const faviconCount = urls.filter(u => u.toLowerCase().includes('favicon')).length;
const staticCount = urls.filter(u => u.toLowerCase().includes('/static/')).length;
const imagexCount = urls.filter(u => u.includes('imagex-sign') || u.includes('tos-cn')).length;
console.log('UI 图标 (/icon/ 或 action_bar_icon):', iconCount);
console.log('favicon:', faviconCount);
console.log('/static/:', staticCount);
console.log('imagex-sign/tos-cn:', imagexCount);

// 显示非图标的 imagex 图片
console.log('\n非 UI 图标的 imagex 图片:');
urls.filter(u => u.includes('imagex-sign') || u.includes('tos-cn')).forEach((u, i) => {
  console.log(`  ${i + 1}. ${u.substring(0, 200)}`);
});
