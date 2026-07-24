const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const DEFAULT_CONFIG = {
  tokens: [{ name: 'SOL', address: 'So11111111111111111111111111111111111111112', chain: 'solana', active: true }],
  checkInterval: 5, volumeSurgeThreshold: 5,
};
let config = DEFAULT_CONFIG;
try {
  if (fs.existsSync(CONFIG_FILE)) config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
} catch(e) {}

router.get('/', (req, res) => res.json(config));
router.post('/', (req, res) => {
  if (req.body.tokens) config.tokens = req.body.tokens;
  if (req.body.volumeSurgeThreshold) config.volumeSurgeThreshold = req.body.volumeSurgeThreshold;
  if (req.body.checkInterval) config.checkInterval = req.body.checkInterval;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({ success: true, config });
});
module.exports = router;
module.exports.getConfig = () => config;
