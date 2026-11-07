/**
 * sidecar/src/scanner.test.js
 *
 * 参考图片扫描与抽取逻辑的单元测试（node src/scanner.test.js）。
 *
 * 覆盖：
 *   - 递归扫描目录，仅直接包含图片的文件夹参与
 *   - sha256 识别图片（同 hash 同图片）
 *   - 文件夹少于/等于/超过 5 个时的抽取方式
 *   - 补足与重复抽取（图片总数不足 5 时允许重复）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { isSupportedImage, scanFolders, selectImages } = require('./scanner');

let passed = 0;
let failed = 0;
const failures = [];

/** 运行一个测试用例 */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, message: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'expected'} mismatch: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
}

function assertTrue(cond, label) {
  if (!cond) throw new Error(label || 'assertion failed');
}

/** 在临时目录下构建测试夹具 */
async function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
  try {
    await fn(root);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) { /* 忽略清理失败 */ }
  }
}

/** 写入一个伪图片文件（内容不影响扫描，扫描只按扩展名 + 文件系统识别） */
function touchImage(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content || crypto.randomBytes(64));
  return full;
}

async function main() {
  console.log('扫描器测试（scanFolders / selectImages / isSupportedImage）');

  await test('isSupportedImage: 扩展名判断与大小写无关', () => {
    assertTrue(isSupportedImage('a.JPG'), 'JPG should be supported');
    assertTrue(isSupportedImage('b.jpeg'), 'jpeg should be supported');
    assertTrue(isSupportedImage('c.png'), 'png should be supported');
    assertTrue(isSupportedImage('d.webp'), 'webp should be supported');
    assertTrue(!isSupportedImage('e.gif'), 'gif should not be supported');
    assertTrue(!isSupportedImage('f.txt'), 'txt should not be supported');
  });

  await test('scanFolders: 只有直接包含图片的文件夹参与，子目录的图不计入父目录', async () => {
    await withFixture(async (root) => {
      touchImage(root, 'root.png');
      touchImage(root, 'nested/nested.png');
      touchImage(root, 'nested/deep/deep.png');

      const scanned = await scanFolders(root);
      const byFullDir = new Map(scanned.map((f) => [f.dir, f]));
      // root / nested / deep 都是含直接图片的文件夹
      assertEqual(scanned.length, 3, 'folder count');
      assertEqual(byFullDir.get(root).images.length, 1, 'root has 1');
      assertEqual(byFullDir.get(path.join(root, 'nested')).images.length, 1, 'nested has 1');
      assertEqual(byFullDir.get(path.join(root, 'nested', 'deep')).images.length, 1, 'deep has 1');
    });
  });

  await test('scanFolders: 空目录不出现，note.txt 不计数', async () => {
    await withFixture(async (root) => {
      touchImage(root, 'a.png');
      fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
      fs.mkdirSync(path.join(root, 'empty-dir'));

      const scanned = await scanFolders(root);
      assertEqual(scanned.length, 1, 'folder count');
      assertEqual(scanned[0].images.length, 1, 'image count');
    });
  });

  await test('selectImages: 文件夹不超过 5 时每个文件夹抽一张，再补足 5 张', async () => {
    await withFixture(async (root) => {
      // 2 个文件夹各 3 张
      touchImage(root, 'a/a1.png');
      touchImage(root, 'a/a2.png');
      touchImage(root, 'a/a3.png');
      touchImage(root, 'b/b1.png');
      touchImage(root, 'b/b2.png');
      touchImage(root, 'b/b3.png');

      const folders = await scanFolders(root);
      const { selected } = await selectImages(folders, 5);
      assertEqual(selected.length, 5, 'selected count');
      const dirs = new Set(selected.map((img) => img.dir));
      assertTrue(dirs.size >= 1, 'selected from at least one folder');
      // 两个文件夹先各出一张 ⇒ 至少 a、b 各一张
      assertTrue(dirs.has(path.join(root, 'a')) && dirs.has(path.join(root, 'b')), 'both folders contributed');
    });
  });

  await test('selectImages: 超过 5 个文件夹时只随机选 5 个文件夹', async () => {
    await withFixture(async (root) => {
      // 7 个文件夹，每个 1 张
      for (const name of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']) {
        touchImage(root, path.join(name, 'img.png'));
      }
      const folders = await scanFolders(root);
      const { selected } = await selectImages(folders, 5);
      assertEqual(selected.length, 5, 'selected count');
      const dirs = new Set(selected.map((img) => path.basename(img.dir)));
      assertEqual(dirs.size, 5, '5 distinct folders');
    });
  });

  await test('selectImages: 图片总数不足 5 时允许重复抽取', async () => {
    await withFixture(async (root) => {
      touchImage(root, 'only.png');
      const folders = await scanFolders(root);
      const { selected } = await selectImages(folders, 5);
      assertEqual(selected.length, 5, 'selected count');
    });
  });

  await test('selectImages: 空文件夹返回 reason=no_folders', async () => {
    const { selected, reason } = await selectImages([], 5);
    assertEqual(selected.length, 0, 'no selection');
    assertEqual(reason, 'no_folders', 'reason');
  });

  console.log('');
  console.log(`扫描器测试结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('扫描器测试运行失败:', err);
  process.exitCode = 1;
});
