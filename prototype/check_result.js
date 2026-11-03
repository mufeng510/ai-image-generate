const fs = require('fs');
const d = '.output/rounds/20261103_103200_440';
const task = JSON.parse(fs.readFileSync(d + '/task.json', 'utf-8'));
console.log('=== task.json ===');
console.log('taskId:', task.taskId);
console.log('method:', task.method);
console.log('dialogUrl:', task.dialogUrl);
console.log('successCount:', task.successCount);
console.log('failedCount:', task.failedCount);
console.log('images count:', task.images.length);
task.images.forEach((img, i) => {
  console.log(`  ${i + 1}. ${img.ok ? 'OK' : 'FAIL'} ${img.ext} ${img.size} bytes sha256:${(img.sha256 || '').substring(0, 16)}...`);
});
console.log('=== 图片实际格式验证（基于文件魔数） ===');
const MAGIC = [
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ext: '.png' },
  { sig: [0xff, 0xd8, 0xff], ext: '.jpg' },
  { sig: [0x52, 0x49, 0x46, 0x46], ext: '.webp', check: (b) => b.toString('ascii', 8, 12) === 'WEBP' },
];
function extFromMagic(buf) {
  for (const { sig, ext, check } of MAGIC) {
    if (buf.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) { if (buf[i] !== sig[i]) { match = false; break; } }
    if (!match) continue;
    if (check && !check(buf)) continue;
    return ext;
  }
  return '.unknown';
}
for (let i = 1; i <= 6; i++) {
  const p = d + '/image_' + String(i).padStart(3, '0') + '.png';
  const buf = fs.readFileSync(p);
  const magicExt = extFromMagic(buf);
  console.log(`  image_${String(i).padStart(3, '0')}: ${buf.length} bytes, 实际格式: ${magicExt}, URL扩展名: .png`);
}
