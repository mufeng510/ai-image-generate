'use strict';
/**
 * 本机 sidecar 冒烟测试（无需真实账号）。
 * 通过 stdin/stdout JSON 行协议驱动 sidecar，验证：
 *   - scan_images：递归扫描 + 文件夹独立抽取 5 张
 *   - extract_images：无浏览器时返回结构化错误（不崩溃）
 *   - download_images：无浏览器时返回结构化错误（不崩溃）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SIDECAR = path.join(__dirname, '..', 'src', 'index.js');
const workDir = path.join(os.tmpdir(), 'doubao-sidecar-smoke-' + Date.now());
const refDir = path.join(workDir, 'references');

// 构造参考图片目录：3 个文件夹，共 8 张有效图片 + 1 张非图片
function makeFixture() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const filler = Buffer.alloc(2000, 0x41);
  const folders = { A: 2, B: 3, C: 3 };
  for (const [name, count] of Object.entries(folders)) {
    const dir = path.join(refDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      fs.writeFileSync(path.join(dir, `${name}${i}.png`), Buffer.concat([png, filler]));
    }
  }
  fs.writeFileSync(path.join(refDir, 'notes.txt'), 'not an image');
}

function run() {
  makeFixture();
  const child = spawn(process.execPath, [SIDECAR], { stdio: ['pipe', 'pipe', 'pipe'] });

  const events = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch (_) {}
    }
  });
  child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString()));

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const waitResult = (cmd, ms) => new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const found = events.find((e) => e.type === 'result' && e.cmd === cmd);
      if (found) { clearInterval(timer); resolve(found); }
      else if (Date.now() - start > ms) { clearInterval(timer); resolve(null); }
    }, 100);
  });

  (async () => {
    let passed = 0, failed = 0;
    const check = (cond, msg) => { if (cond) { passed++; console.log('  PASS:', msg); } else { failed++; console.error('  FAIL:', msg); } };

    // 1. scan_images
    send({
      cmd: 'scan_images',
      task_id: 1,
      root_path: refDir,
      round_number: 1,
      state_dir: path.join(workDir, '.doubao'),
      units_file: path.join(workDir, '.doubao', 'round_1.units.json'),
    });
    const scan = await waitResult('scan_images', 15000);
    check(!!scan, 'scan_images 返回结果');
    check(scan && scan.ok === true, 'scan_images ok=true');
    check(scan && scan.total_images === 8, `总图片数=8 (实际 ${scan && scan.total_images})`);
    check(scan && scan.folders === 3, `文件夹数=3 (实际 ${scan && scan.folders})`);
    check(scan && scan.selected_count === 5, `抽出 5 张 (实际 ${scan && scan.selected_count})`);
    const unitsFile = path.join(workDir, '.doubao', 'round_1.units.json');
    check(fs.existsSync(unitsFile), 'units 文件已写入');
    if (fs.existsSync(unitsFile)) {
      const units = JSON.parse(fs.readFileSync(unitsFile, 'utf-8'));
      check(units.length === 5 && units.every((u) => u.folder && u.path), 'units 含 5 条 folder/path');
    }

    // 3b. parseImageOriRaws（无水印原图解析）
    const { parseImageOriRaws } = require('../src/extractor');
    const html = 'x image_ori_raw\\":{\\"url\\":\\"https:\\u002F\\u002Fp11-flow-imagex-sign.byteimg.com\\u002Ftos-cn-i-a9rns2rl98\\u002Frc_gen_image\\u002Fabc123.jpeg~tplv-a9rns2rl98-image_raw_hflow:SEVD.png?lk3s=abc&rcl=20261103&rrcfp=755f3169&x-signature=%2Fde%3D\\" y';
    const raws = parseImageOriRaws(html);
    check(raws.length === 1, 'image_ori_raw 解析出 1 张');
    check(raws[0] && raws[0].url.endsWith('%2Fde%3D'), 'URL 结尾无反斜杠（403 回归）');
    check(raws[0] && !raws[0].url.includes('\\'), 'URL 不含反斜杠');
    check(raws[0] && raws[0].identity.includes('/rc_gen_image/abc123.jpeg'), 'identity 含文件路径');
    // 非 original 模板（cthumb/cgen）应被过滤
    const html2 = 'image_ori_raw\\":{\\"url\\":\\"https:\\u002F\\u002Fp3-flow-imagex-sign.byteimg.com\\u002Ftos-cn-i-a9rns2rl98\\u002Frc_gen_image\\u002Fabc123.jpeg~tplv-a9rns2rl98-cthumb_dwm3:SEVD.png?lk3s=abc\\"';
    check(parseImageOriRaws(html2).length === 0, '非 image_raw 模板被过滤');
    // 优先 PNG 变体
    const html3 = 'a image_ori_raw\\":{\\"url\\":\\"https:\\u002F\\u002Fp11\\u002Ftos\\u002Frc_gen_image\\u002Fx.jpeg~tplv-a9rns2rl98-image_raw_hflow:SEVD.heic?lk3s=1\\" b image_ori_raw\\":{\\"url\\":\\"https:\\u002F\\u002Fp11\\u002Ftos\\u002Frc_gen_image\\u002Fx.jpeg~tplv-a9rns2rl98-image_raw_hflow:SEVD.png?lk3s=2\\"';
    const raws3 = parseImageOriRaws(html3);
    check(raws3.length === 1 && raws3[0].url.includes('.png?'), '同图优先 .png 变体');

    // 3c. resume_generate（未启动浏览器）：返回结构化错误，不崩溃、不盲目提交
    send({ cmd: 'resume_generate', account_id: 99 });
    const resume = await waitResult('resume_generate', 15000);
    check(!!resume, 'resume_generate 返回结果');
    check(resume && resume.ok === false && resume.reason === 'browser_not_started', 'resume_generate 无浏览器时结构化失败');

    // 4. extract_images（未启动浏览器）
    send({ cmd: 'extract_images', task_id: 1, account_id: 99, project_root: workDir });
    const ext = await waitResult('extract_images', 15000);
    check(!!ext, 'extract_images 返回结果');
    check(ext && ext.ok === false && ext.reason === 'browser_not_started', 'extract_images 无浏览器时结构化失败');

    // 3. download_images（未启动浏览器）
    send({ cmd: 'download_images', task_id: 1, account_id: 99, round_id: 1, round_dir: path.join(workDir, 'out'), images: [] });
    const dl = await waitResult('download_images', 15000);
    check(!!dl, 'download_images 返回结果');
    check(dl && dl.ok === false && dl.reason === 'browser_not_started', 'download_images 无浏览器时结构化失败');

    child.stdin.end();
    console.log(`\nSidecar 冒烟测试: ${passed} 通过, ${failed} 失败`);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(failed === 0 ? 0 : 1);
  })();
}

run();
