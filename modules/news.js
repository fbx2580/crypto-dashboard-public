// ─── 新闻模块（读 JSON 快缓存，DB 只做持久化） ───
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

router.get('/', (req, res) => {
  let jin10 = [], rss = [];
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'news', 'jin10.json'), 'utf8'));
    jin10 = (d.items || []).slice(0, 200);
  } catch(e) {}
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'news', 'latest.json'), 'utf8'));
    rss = (d.items || []).slice(0, 200);
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
