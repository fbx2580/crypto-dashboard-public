const express = require('express');
const axios = require('axios');
const router = express.Router();
let llamaCache = { data: null, time: 0 };
router.get('/llama', async (req, res) => {
  const minTvl = parseFloat(req.query.minTvl || '1000000');
  const limit = parseInt(req.query.limit || '50');
  if (llamaCache.data && Date.now() - llamaCache.time < 300000)
    return res.json({ ...llamaCache.data, pools: llamaCache.data.pools.slice(0, limit) });
  try {
    const r = await axios.get('https://yields.llama.fi/pools', { timeout: 10000 });
    const filtered = (r.data.data || []).filter(p => p.tvlUsd >= minTvl);
    llamaCache = { data: { pools: filtered }, time: Date.now() };
    res.json({ pools: filtered.slice(0, limit) });
  } catch(e) { res.json({ pools: [] }); }
});
module.exports = router;
