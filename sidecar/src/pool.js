/**
 * sidecar/src/pool.js
 *
 * 持久化随机池模块（基于 task.md 第五节第 5.4 节规则）。
 *
 * 规则：
 *   - 每轮开始时重新扫描参考图片目录
 *   - 新增图片可以加入后续抽取候选池
 *   - 当前批次已经使用过的图片尽量不再抽取
 *   - 图片池耗尽后重新洗牌
 *   - 删除或移动的图片从候选池中移除
 *   - 任务中断后恢复时，不能重新随机抽取本轮图片
 *   - 本轮已经确定的 5 张图片必须持久化
 *   - 可以使用图片文件路径 + SHA-256 哈希识别图片，修改后视为新版本
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { selectImages } = require('./scanner');

/** 持久化随机池 */
class ImagePool {
  constructor(poolFilePath) {
    this.poolFilePath = poolFilePath;
    // 已使用图片路径集合（本轮/批次已使用，尽量不再抽取）
    this.usedImagePaths = new Set();
    // 已确定的本轮图片（持久化，任务中断恢复时不重新随机）
    this.roundImages = []; // { index, url, path, sha256, ... }
    this._load();
  }

  /** 从磁盘加载持久化状态 */
  _load() {
    try {
      if (fs.existsSync(this.poolFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.poolFilePath, 'utf-8'));
        if (data.usedImagePaths && Array.isArray(data.usedImagePaths)) {
          data.usedImagePaths.forEach((p) => this.usedImagePaths.add(p));
        }
        if (data.roundImages && Array.isArray(data.roundImages)) {
          this.roundImages = data.roundImages;
        }
      }
    } catch (err) {
      // 加载失败，从空状态开始
      this.usedImagePaths = new Set();
      this.roundImages = [];
    }
  }

  /** 持久化到磁盘 */
  _save() {
    const dir = path.dirname(this.poolFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = {
      usedImagePaths: Array.from(this.usedImagePaths),
      roundImages: this.roundImages,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.poolFilePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** 标记图片已使用（加入已使用集合，尽量不再抽取） */
  markUsed(imagePaths) {
    for (const p of imagePaths) {
      this.usedImagePaths.add(p);
    }
    this._save();
  }

  /** 标记本轮已确定的图片（持久化，任务中断恢复时不重新随机） */
  setRoundImages(images) {
    this.roundImages = images;
    this._save();
  }

  /** 获取本轮已确定图片 */
  getRoundImages() {
    return this.roundImages;
  }

  /** 清空本轮图片（任务完成或取消后重置） */
  clearRoundImages() {
    this.roundImages = [];
    this._save();
  }

  /** 重置池（重新洗牌，清空已使用记录） */
  reset() {
    this.usedImagePaths = new Set();
    this.roundImages = [];
    this._save();
  }

  /** 移除不存在的图片（删除或移动的图片从候选池中移除） */
  prune(existingPaths) {
    const existingSet = new Set(existingPaths);
    for (const p of this.usedImagePaths) {
      if (!existingSet.has(p)) {
        this.usedImagePaths.delete(p);
      }
    }
    this.roundImages = this.roundImages.filter((img) => existingSet.has(img.path));
    this._save();
  }

  /** 从扫描结果中选择图片（调用 scanner 抽取逻辑，并标记已使用） */
  async selectImages(folders, count = 5) {
    const result = await selectImages(folders, count, this.usedImagePaths);
    const selected = result.selected || [];
    // 标记已选图片为已使用，尽量不再抽取
    const usedPaths = selected.map((img) => img.path);
    this.markUsed(usedPaths);
    // 记录本轮图片
    this.setRoundImages(selected.map((img, idx) => ({
      index: idx + 1,
      path: img.path,
      url: img.url,
      name: img.name,
      sha256: img.sha256,
    })));
    return {
      selected,
      usedPaths: Array.from(this.usedImagePaths),
      roundImages: this.roundImages,
    };
  }
}

module.exports = {
  ImagePool,
};
