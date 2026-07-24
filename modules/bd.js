// ─── 后门聊天模块 ───
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const BD_DIR = path.join(__dirname, '..', 'public', 'data', 'bd');

router.post('/send', express.json(), (req, res) => {
  const { uid, msg } = req.body || {};
  if (!uid || !msg) return res.json({ ok: false });
  const file = path.join(BD_DIR, `${uid}.json`);
  let data = { messages: [] };
  try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
  data.messages.push({ role: 'user', text: msg, time: Date.now() });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(BD_DIR, `${uid}_thinking.flag`), '1');
  res.json({ ok: true });
});

router.get('/messages', (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json({ messages: [] });
  const file = path.join(BD_DIR, `${uid}.json`);
  try { if (fs.existsSync(file)) return res.json(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch(e) {}
  res.json({ messages: [] });
});

router.get('/status', (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json({ thinking: false, reply: null });
  const flagFile = path.join(BD_DIR, `${uid}_reply.json`);
  const thinkingFile = path.join(BD_DIR, `${uid}_thinking.flag`);
  const thinking = fs.existsSync(thinkingFile);
  let reply = null;
  try {
    if (fs.existsSync(flagFile)) {
      const d = JSON.parse(fs.readFileSync(flagFile, 'utf8'));
      if (d.reply) { reply = d.reply; fs.unlinkSync(flagFile); }
    }
  } catch(e) {}
  res.json({ thinking, reply });
});

module.exports = router;
