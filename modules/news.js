// ─── 新闻模块（分页 + 增量轮询）───
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const MAX_LIMIT = 100;

// 金十快讯
router.get('/jin10', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, MAX_LIMIT);
  const after = req.query.after || '';    // 增量：拿比这个 id 更新的
  const before = req.query.before || '';  // 翻页：拿比这个 id 更早的

  try {
    const file = path.join(__dirname, '..', 'public', 'data', 'news', 'jin10.json');
    if (!fs.existsSync(file)) return res.json({ items: [], hasMore: false });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let items = data.items || [];

    if (after) {
      // 增量轮询：找到 after 的位置，返回更新的
      const idx = items.findIndex(i => (i.t + i.s) === after);
      items = idx > 0 ? items.slice(0, idx) : [];
      return res.json({ items: items.slice(0, limit), hasMore: items.length > limit });
    }

    if (before) {
      // 翻页：找到 before 的位置，返回更早的
      const idx = items.findIndex(i => (i.t + i.s) === before);
      items = idx >= 0 ? items.slice(idx + 1) : [];
      const sliced = items.slice(0, limit);
      return res.json({ items: sliced, hasMore: items.length > limit });
    }

    // 首次加载：最新 N 条
    const sliced = items.slice(0, limit);
    res.json({ items: sliced, hasMore: items.length > limit, latestId: sliced.length ? sliced[0].t + sliced[0].s : '' });
  } catch(e) {
    res.json({ items: [], hasMore: false });
  }
});

// RSS 新闻
router.get('/rss', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, MAX_LIMIT);
  const after = req.query.after || '';
  const before = req.query.before || '';

  try {
    const file = path.join(__dirname, '..', 'public', 'data', 'news', 'latest.json');
    if (!fs.existsSync(file)) return res.json({ items: [], hasMore: false });
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let items = (data.items || []).sort((a, b) => new Date(b.t) - new Date(a.t));

    if (after) {
      const idx = items.findIndex(i => (i.s + (i.link || '')) === after);
      items = idx > 0 ? items.slice(0, idx) : [];
      return res.json({ items: items.slice(0, limit), hasMore: items.length > limit });
    }

    if (before) {
      const idx = items.findIndex(i => (i.s + (i.link || '')) === before);
      items = idx >= 0 ? items.slice(idx + 1) : [];
      const sliced = items.slice(0, limit);
      return res.json({ items: sliced, hasMore: items.length > limit });
    }

    const sliced = items.slice(0, limit);
    res.json({ items: sliced, hasMore: items.length > limit, latestId: sliced.length ? sliced[0].s + (sliced[0].link || '') : '' });
  } catch(e) {
    res.json({ items: [], hasMore: false });
  }
});

// 兼容旧接口 /api/news
router.get('/', (req, res) => {
  let jin10 = [], rss = [];
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'news', 'jin10.json'), 'utf8'));
    jin10 = (d.items || []).slice(0, 30);
  } catch(e) {}
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'news', 'latest.json'), 'utf8'));
    rss = (d.items || []).sort((a, b) => new Date(b.t) - new Date(a.t)).slice(0, 30);
  } catch(e) {}
  res.json({ jin10, rss, updated: Date.now() });
});

router.get('/alerts', (req, res) => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'alerts', 'news.json'), 'utf8'));
    return res.json(d);
  } catch(e) {}
  res.json({ updated: Date.now(), alerts: [] });
});

module.exports = router;
