// ─── 钱包模块 ───
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

router.get('/', (req, res) => {
  const file = path.join(DATA_DIR, 'wallets', 'latest.json');
  try {
    if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch(e) {}
  res.json({ updated: Date.now(), wallets: [] });
});

router.get('/history/:id', (req, res) => {
  const file = path.join(DATA_DIR, 'wallets', 'history', req.params.id + '.jsonl');
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-60);
      return res.json(lines.map(l => JSON.parse(l)));
    }
  } catch(e) {}
  res.json([]);
});

module.exports = router;
