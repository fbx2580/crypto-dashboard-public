#!/usr/bin/env node
/**
 * P2: 归档管理器 — 不可删除
 * 每次写入 live 文件后调用，自动追加到按日归档文件
 * 
 * 用法: archive(type, records)
 *   type: 'news'|'whale'|'alerts'|'eth'
 *   records: [{...}] 新记录数组
 * 
 * 自动去重 / 按日分文件 / 限制大小 / 午夜自动切文件
 */
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, 'public', 'data', 'archive');
const MAX_PER_DAY = 50000; // 单日归档上限

function getArchiveFile(type) {
  const now = new Date();
  const ds = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(BASE, type);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${ds}.json`);
}

/**
 * 追加记录到按日归档
 * @param {string} type - 数据类型: news|whale|alerts|eth
 * @param {Array} records - 新记录 [{...}]
 * @param {string} idField - 去重字段 (默认 'id')
 * @returns {number} 实际新增条数
 */
function archive(type, records, idField) {
  if (!records || !records.length) return 0;

  const f = getArchiveFile(type);
  let existing = [];

  // 读现有归档
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    existing = d.records || [];
  } catch (e) {}

  // 去重
  const existingIds = new Set();
  for (const r of existing) {
    // 用标题/哈希/ID去重
    const key = idField ? r[idField] : (r.s || r.title || r.hash || JSON.stringify(r).slice(0, 80));
    if (key) existingIds.add(key);
  }

  let added = 0;
  for (const r of records) {
    const key = idField ? r[idField] : (r.s || r.title || r.hash || JSON.stringify(r).slice(0, 80));
    if (!key || existingIds.has(key)) continue;
    existing.unshift(r);
    existingIds.add(key);
    added++;
  }

  if (added > 0) {
    // 限制大小
    if (existing.length > MAX_PER_DAY) existing = existing.slice(0, MAX_PER_DAY);
    fs.writeFileSync(f, JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      type,
      updated: Date.now(),
      total: existing.length,
      records: existing,
    }, null, 2));
  }

  return added;
}

/**
 * 获取归档统计
 */
function stats() {
  const stats = {};
  if (!fs.existsSync(BASE)) return stats;

  const types = fs.readdirSync(BASE);
  for (const type of types) {
    const dir = path.join(BASE, type);
    if (!fs.statSync(dir).isDirectory()) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    stats[type] = {
      files: files.length,
      total: files.reduce((s, f) => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return s + (d.total || d.records?.length || 0);
        } catch (e) { return s; }
      }, 0),
      dates: files.map(f => f.replace('.json', '')),
    };
  }
  return stats;
}

/**
 * 清理旧归档（保留最近 N 天）
 */
function cleanup(keepDays) {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  let removed = 0;
  const base = BASE;
  if (!fs.existsSync(base)) return 0;
  const dirs = fs.readdirSync(base);
  for (const dir of dirs) {
    const dp = path.join(base, dir);
    if (!fs.statSync(dp).isDirectory()) continue;
    const files = fs.readdirSync(dp);
    for (const f of files) {
      const date = f.replace('.json', '');
      if (date < cutoff) {
        fs.unlinkSync(path.join(dp, f));
        removed++;
      }
    }
  }
  return removed;
}

module.exports = { archive, stats, cleanup };

// 直接运行 = 打印统计
if (require.main === module) {
  const s = stats();
  console.log('存档统计:');
  if (Object.keys(s).length === 0) console.log('  (空)');
  for (const [type, info] of Object.entries(s)) {
    console.log(`  ${type}: ${info.total}条 | ${info.files}天 | ${info.dates.join(', ')}`);
  }
}
