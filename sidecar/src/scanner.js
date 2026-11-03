/**
 * sidecar/src/scanner.js
 *
 * 参考图片扫描与抽取模块（基于 task.md 第五节规则）。
 *
 * 规则：
 *   - 递归扫描 references 下所有子目录，支持 JPG/JPEG/PNG/WEBP
 *   - 一个文件夹只统计它自己直接包含的图片文件，不包含子文件夹里的图片
 *   - 只要该文件夹直接包含至少一张有效图片，它就独立参与抽取
 *   - 父文件夹和子文件夹可以同时参与
 *   - 每轮固定抽取 5 张：
 *     1. 递归扫描所有有效图片
 *     2. 找出所有直接包含图片的文件夹
 *     3. 每个文件夹作为一个独立抽取单元
 *     4. 如果参与抽取的文件夹超过 5 个，随机选择其中 5 个
 *     5. 如果参与抽取的文件夹少于 5 个，每个文件夹先随机抽取一张
 *     6. 从剩余未选图片中随机补足 5 张
 *     7. 同一轮优先不重复
 *     8. 如果所有不同图片总量不足 5 张，才允许重复抽取
 *   - 图片用 文件路径 + SHA-256 哈希 识别，修改后视为新版本
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** 计算文件的 SHA-256 哈希 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 判断是否为支持的图片格式 */
function isSupportedImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTS.has(ext);
}

/** 递归扫描目录下所有有效图片文件 */
async function scanImages(rootDir) {
  const images = []; // { path, name, dir, sha256, size }

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return; // 无权限或不存在，跳过
    }

    const directImages = [];
    const subdirs = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(fullPath);
      } else if (entry.isFile() && isSupportedImage(fullPath)) {
        directImages.push(fullPath);
      }
    }

    // 只有直接包含图片的文件夹才参与抽取
    if (directImages.length > 0) {
      for (const imgPath of directImages) {
        try {
          const stat = await fs.promises.stat(imgPath);
          const sha256 = await sha256File(imgPath);
          images.push({
            path: imgPath,
            name: path.basename(imgPath),
            dir: dir,
            dirName: path.basename(dir),
            sha256,
            size: stat.size,
          });
        } catch (err) {
          // 单个文件读取失败，跳过，不影响整体
        }
      }
    }

    // 递归处理子目录（子目录也独立参与抽取）
    for (const subdir of subdirs) {
      await walk(subdir);
    }
  }

  await walk(rootDir);
  return images;
}

/** 扫描并按文件夹分组（每个文件夹作为独立抽取单元） */
async function scanFolders(rootDir) {
  const images = await scanImages(rootDir);
  const folders = new Map(); // dirPath -> { dir, dirName, images: [] }

  for (const img of images) {
    if (!folders.has(img.dir)) {
      folders.set(img.dir, { dir: img.dir, dirName: img.dirName, images: [] });
    }
    folders.get(img.dir).images.push(img);
  }

  return Array.from(folders.values()).filter((f) => f.images.length > 0);
}

/** 抽取 5 张图片（基于 task.md 第五节规则） */
async function selectImages(folders, count = 5, usedImagePaths = new Set()) {
  if (folders.length === 0) {
    return { selected: [], reason: 'no_folders' };
  }

  // 过滤掉已用图片，构建每个文件夹的可用图片
  const folderUnits = folders.map((f) => ({
    dir: f.dir,
    dirName: f.dirName,
    images: f.images.filter((img) => !usedImagePaths.has(img.path)),
  }));

  const selected = [];
  const selectedPaths = new Set();

  // 第 1-3 阶段：按文件夹优先抽取
  const folderCount = folderUnits.length;

  if (folderCount > count) {
    // 阶段 4: 文件夹超过 5 个，随机选择其中 5 个
    const selectedFolders = shuffle([...folderUnits]).slice(0, count);
    for (const folder of selectedFolders) {
      if (folder.images.length === 0) continue;
      const img = pickRandom(folder.images, selectedPaths);
      if (img) {
        selected.push(img);
        selectedPaths.add(img.path);
      }
    }
  } else {
    // 阶段 5: 文件夹少于等于 5 个，每个文件夹先随机抽取一张
    for (const folder of folderUnits) {
      if (folder.images.length === 0) continue;
      const img = pickRandom(folder.images, selectedPaths);
      if (img) {
        selected.push(img);
        selectedPaths.add(img.path);
      }
    }

    // 阶段 6: 从剩余未选图片中随机补足 5 张
    if (selected.length < count) {
      const remaining = [];
      for (const folder of folderUnits) {
        for (const img of folder.images) {
          if (!selectedPaths.has(img.path)) {
            remaining.push(img);
          }
        }
      }
      const need = count - selected.length;
      const picked = pickRandomN(remaining, need, selectedPaths);
      for (const img of picked) {
        selected.push(img);
        selectedPaths.add(img.path);
      }
    }
  }

  // 阶段 7-8: 如果所有不同图片总量不足 5 张，允许重复抽取
  if (selected.length < count) {
    const allImages = [];
    for (const f of folders) {
      for (const img of f.images) {
        allImages.push(img);
      }
    }
    if (allImages.length > 0) {
      const need = count - selected.length;
      for (let i = 0; i < need; i++) {
        const img = allImages[Math.floor(Math.random() * allImages.length)];
        selected.push(img);
        selectedPaths.add(img.path);
      }
    }
  }

  return { selected, selectedPaths };
}

/** 从数组中随机选一个，排除已选路径 */
function pickRandom(items, selectedPaths) {
  const available = items.filter((img) => !selectedPaths.has(img.path));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/** 从数组中随机选 N 个，排除已选路径 */
function pickRandomN(items, need, selectedPaths) {
  const available = items.filter((img) => !selectedPaths.has(img.path));
  const result = [];
  const pool = [...available];
  for (let i = 0; i < need && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return result;
}

/** 洗牌数组 */
function shuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

module.exports = {
  SUPPORTED_EXTS,
  sha256File,
  isSupportedImage,
  scanImages,
  scanFolders,
  selectImages,
};
