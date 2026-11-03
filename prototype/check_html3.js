const fs = require('fs');
const html = fs.readFileSync('.output/diagnostics/before-download_2026-11-03T01-53-19.051Z.html', 'utf-8');

// 找出包含 imagex-sign 的 img 标签的上下文
const imgRegex = /<img[^>]+src=["']([^"']*imagex-sign[^"']*)["'][^>]*>/gi;
let m;
let count = 0;
while ((m = imgRegex.exec(html)) !== null && count < 20) {
  count++;
  console.log(`=== 图片 ${count} ===`);
  console.log(`src: ${m[1].substring(0, 150)}`);
  // 显示周围的 HTML 结构
  const start = Math.max(0, m.index - 300);
  const end = Math.min(html.length, m.index + 500);
  const context = html.substring(start, end);
  console.log(`context: ...${context.substring(0, 700)}...`);
  console.log('');
}
