// ─── State ───
const State = {
  currentSymbol: 'BTCUSDT',
  interval: '1h',
  timeRange: 2880,
  chartType: 'candle',
  charts: { price: null },
};

// ─── Formatting ───
const fmt = {
  price(v) {
    if (!v && v !== 0) return '—';
    if (v >= 1000) return v.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v < 0.00001) return v.toExponential(4);
    if (v < 0.001) return v.toFixed(8);
    if (v < 1) return v.toFixed(6);
    return v.toFixed(4);
  },
  vol(v) {
    if (!v) return '—';
    if (v >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v/1e3).toFixed(1)}K`;
    return `$${v.toFixed(0)}`;
  },
};

// ─── API ───
const API = {
  async binanceMajors() { return (await fetch('/api/binance/majors')).json(); },
  async binanceAnomalies() { return (await fetch('/api/binance/anomalies')).json(); },
  async marketOverview() { return (await fetch('/api/market/overview')).json(); },
  async binanceKlines(symbol, interval) { return (await fetch(`/api/binance/klines/${symbol}/${interval}`)).json(); },
};

// ─── Market Overview ───
// ─── DefiLlama 全链收益 ───
async function refreshLlama() {
  const el = document.getElementById('llamaList');
  const cnt = document.getElementById('llamaCount');
  const projSel = document.getElementById('llamaProject');
  if (!el || !cnt) return;
  try {
    const project = projSel ? projSel.value : '';
    const pflt = project || 'uniswap-v3,uniswap-v4,pancakeswap-amm,pancakeswap-amm-v3';
    const url = '/api/defi/llama?minTvl=1000000&limit=50' + '&project=' + pflt;
    const r = await fetch(url);
    const d = await r.json();
    
    if (!d.pools || !d.pools.length) { el.innerHTML = '<span style="color:var(--text-dim);">无数据</span>'; cnt.textContent = '0'; return; }
    cnt.textContent = d.pools.length + '/' + d.total + ' 池';
    const tab = document.querySelector('.tab.active');
    if (tab && tab.dataset.tab !== 'trade') return;
    const chainColors = { ethereum:'#627eea', solana:'#9945ff', base:'#0052ff', bsc:'#f0b90b', arbitrum:'#2d374b', polygon:'#8247e5', avalanche:'#e84142', fantom:'#1969ff' };
    let html = '';
    d.pools.forEach((p, i) => {
      const col = chainColors[(p.chain||'').toLowerCase()] || '#888';
      const tvl = p.tvl >= 1e9 ? (p.tvl/1e9).toFixed(1) + 'B' : p.tvl >= 1e6 ? (p.tvl/1e6).toFixed(1) + 'M' : (p.tvl/1e3).toFixed(0) + 'K';
      const apyCol = p.apy > 100 ? '#ff4444' : p.apy > 50 ? '#ff8800' : p.apy > 20 ? 'var(--green)' : 'var(--text)';
      html += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);font-size:10px;align-items:center">' +
        '<span style="display:flex;align-items:center;gap:3px;">' +
          '<span style="color:' + col + ';font-weight:600;width:14px;">' + (i+1) + '</span>' +
          '<span style="font-weight:600;">' + p.symbol + '</span>' +
          '<span style="color:var(--text-dim);font-size:9px;">' + p.chain.slice(0,4) + '/' + p.project.slice(0,15) + '</span>' +
        '</span>' +
        '<span>' +
          '<span style="color:var(--text-dim);font-size:9px;">' + tvl + '</span> ' +
          '<span style="color:' + apyCol + ';font-weight:700;">' + p.apy.toFixed(1) + '%</span>' +
        '</span>' +
      '</div>';
    });
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<span style="color:var(--text-dim);">加载失败</span>'; }
}

async function refreshIndicators() {
  try {
    const d = await (await fetch("/api/market/indicators")).json();
    const f = d.fear || {};
    const a = d.altSeason || {};
    const ls = d.longShort || {};
    const vix = d.vix || {};
    const dxy = d.dxy || {};
    const cvd = d.cvd || {};

    // 辅助：BTC方向标签
    const B = (score) => { // score: 2=强多 1=偏多 0=中性 -1=偏空 -2=强空
      if (score >= 2) return { t: '🟢 利多BTC', c: 'up' };
      if (score >= 1) return { t: '🟢 偏多BTC', c: 'up' };
      if (score <= -2) return { t: '🔴 利空BTC', c: 'down' };
      if (score <= -1) return { t: '🔴 偏空BTC', c: 'down' };
      return { t: '⚪ 中性', c: '' };
    };

    // 恐惧贪婪 → 别人恐惧我贪婪（越低越利多）
    if (f.value != null) {
      document.getElementById("fngVal").textContent = f.value;
      let score = 0;
      if (f.value <= 20) score = 2;
      else if (f.value <= 40) score = 1;
      else if (f.value <= 55) score = 0;
      else if (f.value <= 75) score = -1;
      else score = -2;
      const s = B(score);
      const fngEl = document.getElementById("fngSub");
      fngEl.textContent = (f.label || '') + ' | ' + s.t;
      fngEl.className = 'ind-card-sub ' + s.c;
    }
    // 山寨季 → 越低越利多BTC（比特季=BTC吸血山寨）
    if (a.value != null) {
      document.getElementById("altVal").textContent = a.value;
      const aLabel = a.label || (a.value >= 75 ? '山寨季' : a.value < 25 ? '比特季' : '中性');
      let score = 0;
      if (a.value <= 20) score = 2;
      else if (a.value <= 40) score = 1;
      else if (a.value <= 60) score = 0;
      else if (a.value <= 80) score = -1;
      else score = -2;
      const s = B(score);
      const altEl = document.getElementById("altSub");
      altEl.textContent = aLabel + ' | ' + s.t;
      altEl.className = 'ind-card-sub ' + s.c;
    }
    // 多空比 → 散户越多多=越利空（反向指标）
    if (ls.longPct != null) {
      document.getElementById("lsVal").textContent = ls.longPct.toFixed(0) + '%多';
      const pct = ls.longPct;
      let score = 0;
      if (pct <= 35) score = 2;
      else if (pct <= 45) score = 1;
      else if (pct <= 55) score = 0;
      else if (pct <= 70) score = -1;
      else score = -2;
      const s = B(score);
      const lsEl = document.getElementById("lsSub");
      lsEl.textContent = '比' + ls.ratio.toFixed(2) + ' | ' + s.t;
      lsEl.className = 'ind-card-sub ' + s.c;
    }
    // VIX → 越低越利多（低波动=风险偏好）
    if (vix.value != null) {
      document.getElementById("vixVal").textContent = vix.value.toFixed(1);
      const v = vix.value;
      let score = 0;
      if (v <= 13) score = 2;
      else if (v <= 20) score = 1;
      else if (v <= 28) score = 0;
      else if (v <= 35) score = -1;
      else score = -2;
      const s = B(score);
      const vixEl = document.getElementById("vixSub");
      const chgSign = vix.change >= 0 ? '+' : '';
      vixEl.textContent = chgSign + vix.change + '% | ' + s.t;
      vixEl.className = 'ind-card-sub ' + s.c;
    }
    // DXY → 越低越利多（弱美元=BTC涨）
    if (dxy.value != null) {
      document.getElementById("dxyVal").textContent = dxy.value.toFixed(1);
      const v = dxy.value;
      let score = 0;
      if (v <= 98) score = 2;
      else if (v <= 102) score = 1;
      else if (v <= 106) score = 0;
      else score = -1;
      const s = B(score);
      const dxyEl = document.getElementById("dxySub");
      const chgSign = dxy.change >= 0 ? '+' : '';
      dxyEl.textContent = chgSign + dxy.change + '% | ' + s.t;
      dxyEl.className = 'ind-card-sub ' + s.c;
    }
    // CVD → 正=主动买利多，负=主动卖利空
    if (cvd.value != null) {
      document.getElementById("cvdVal").textContent = (cvd.value >= 0 ? '+' : '') + cvd.value.toFixed(0);
      const v = cvd.value;
      let score = 0;
      if (v >= 2000) score = 2;
      else if (v >= 300) score = 1;
      else if (v > -300) score = 0;
      else if (v > -2000) score = -1;
      else score = -2;
      const s = B(score);
      const cvdEl = document.getElementById("cvdSub");
      cvdEl.textContent = cvd.netPct + '% ' + cvd.period + ' | ' + s.t;
      cvdEl.className = 'ind-card-sub ' + s.c;
    }

    // ─── 综合总结 ───
    const scores = [];
    if (f.value != null) {
      scores.push(f.value <= 20 ? 2 : f.value <= 40 ? 1 : f.value <= 55 ? 0 : f.value <= 75 ? -1 : -2);
    }
    if (a.value != null) {
      scores.push(a.value <= 20 ? 2 : a.value <= 40 ? 1 : a.value <= 60 ? 0 : a.value <= 80 ? -1 : -2);
    }
    if (ls.longPct != null) {
      const p = ls.longPct;
      scores.push(p <= 35 ? 2 : p <= 45 ? 1 : p <= 55 ? 0 : p <= 70 ? -1 : -2);
    }
    if (vix.value != null) {
      const v = vix.value;
      scores.push(v <= 13 ? 2 : v <= 20 ? 1 : v <= 28 ? 0 : v <= 35 ? -1 : -2);
    }
    if (dxy.value != null) {
      const d = dxy.value;
      scores.push(d <= 98 ? 2 : d <= 102 ? 1 : d <= 106 ? 0 : -1);
    }
    if (cvd.value != null) {
      const cv = cvd.value;
      scores.push(cv >= 2000 ? 2 : cv >= 300 ? 1 : cv > -300 ? 0 : cv > -2000 ? -1 : -2);
    }
    const total = scores.reduce((a,b) => a+b, 0);
    const bulls = scores.filter(s => s > 0).length;
    const bears = scores.filter(s => s < 0).length;
    const neuts = scores.filter(s => s === 0).length;

    let conclusion, sumCls;
    if (total >= 4) { conclusion = '🔴 市场过热'; sumCls = 'down'; }
    else if (total >= 2) { conclusion = '🟡 偏贪婪'; sumCls = 'down'; }
    else if (total >= -1) { conclusion = '⚪ 分歧中'; sumCls = ''; }
    else if (total >= -4) { conclusion = '🟡 偏恐慌'; sumCls = 'up'; }
    else { conclusion = '🟢 极度恐慌'; sumCls = 'up'; }

    document.getElementById("sumVal").textContent = conclusion;
    document.getElementById("sumVal").style.color = sumCls === 'up' ? 'var(--green)' : sumCls === 'down' ? 'var(--red)' : 'var(--yellow)';
    document.getElementById("sumSub").textContent = bulls + '看多 ' + bears + '看空 ' + neuts + '中性';
    document.getElementById("sumSub").className = 'ind-card-sub ' + sumCls;
  } catch(e) { console.error('indicators', e); }
}

async function refreshMarket() {
  try {
    const data = await API.marketOverview();
    const setItem = (id, priceText, chg) => {
      const valEl = document.getElementById(id + 'Val');
      const chgEl = document.getElementById(id + 'Chg');
      if (!valEl) return;
      valEl.textContent = priceText;
      if (chg !== null && chg !== undefined) {
        const cls = chg >= 0 ? 'up' : 'down';
        const sign = chg >= 0 ? '+' : '';
        chgEl.textContent = `${sign}${chg.toFixed(2)}%`;
        chgEl.className = `mo-change ${cls}`;
      } else { chgEl.textContent = '—'; }
    };
    // BTC 由 tickBtcPrice 每秒实时更新，这里不覆盖
    const c = data.crypto || {};
    const sh = data.aShares?.['000001'];
    if (sh) setItem('moA01', sh.price.toFixed(0), sh.changePercent);
    if (data.nasdaq) setItem('moNasdaq', `$${data.nasdaq.price.toLocaleString('en', {minimumFractionDigits:0})}`, data.nasdaq.changePercent);
    if (data.sp500) setItem('moSp500', `$${data.sp500.price.toLocaleString('en', {minimumFractionDigits:0})}`, data.sp500.changePercent);
    if (data.oil) setItem('moOil', `$${data.oil.price.toFixed(2)}`, data.oil.changePercent);
    if (data.gold) setItem('moGold', `$${data.gold.price.toFixed(1)}`, data.gold.changePercent);
    if (data.dxy) setItem('moDxy', data.dxy.price.toFixed(2), data.dxy.changePercent);
  } catch(e) {}
}

// ─── 主流币排行（谁更硬谁更软）───
async function refreshTickers() {
  try {
    const [resp, analysisResp, abResp] = await Promise.all([
      fetch('/api/binance/signals'),
      fetch('/api/market/coin-analysis'),
      fetch('/api/alpha-beta')
    ]);
    if (!resp.ok) return;
    const data = await resp.json();
    const analysis = analysisResp.ok ? await analysisResp.json() : { coins: [] };
    const abData = abResp.ok ? await abResp.json() : { results: [] };
    const analysisMap = {};
    const abMap = {};
    for (const c of (analysis.coins || [])) analysisMap[c.symbol] = c;
    for (const r of (abData.results || [])) abMap[r.symbol] = r;
    
    // 固定27主流币 → 固定顺序全量渲染，永不跳变
    const MAJORS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','TRXUSDT','LTCUSDT','BCHUSDT','XLMUSDT','HBARUSDT','SHIBUSDT','NEARUSDT','ATOMUSDT','UNIUSDT','FILUSDT','APTUSDT','SUIUSDT','INJUSDT','OPUSDT','ARBUSDT','TIAUSDT','ETCUSDT'];
    const symMap = {};
    for (const t of (data.majors || [])) symMap[t.symbol] = t;
    // 固定顺序：按 MAJORS 数组顺序，有数据就显示，没数据显示 —
    const majors = MAJORS.map(sym => symMap[sym] || { symbol: sym, price: 0, change24h: 0 });
    const bar = document.getElementById('tickerBar');
    // 全量渲染，不搞增量更新
    bar.innerHTML = majors.map(t => {
      const chg = parseFloat(t.change24h) || 0;
      const cls = chg >= 0 ? 'up' : 'down';
      const sign = chg >= 0 ? '+' : '';
      const abData = abMap[t.symbol.replace('USDT','')];
      const ab = abData ? abData.signal : '';
      const badge = ab ? ' <span style="font-size:9px;color:var(--text-dim);">' + ab + '</span>' : '';
      return '<div class="ticker-item" data-sym="' + t.symbol + '">' +
        '<span class="ticker-symbol">' + t.symbol.replace('USDT','') + badge + '</span>' +
        '<span class="ticker-change ' + cls + '">' + sign + chg.toFixed(2) + '%</span>' +
        '<span class="ticker-price" style="color:var(--text-dim);font-size:10px">' + (t.price ? '$' + fmt.price(t.price) : '—') + '</span></div>';
    }).join('');
  } catch(e) {}
}

// 美股存储类（币安 TradFi 永续合约代码）
const STORAGE_STOCKS = ['NVDAUSDT','AMDUSDT','INTCUSDT','MUUSDT','WDCUSDT','SKHYNIXUSDT','SKHYUSDT','SNDKUSDT','DRAMUSDT'];

// ─── 秒级 BTC 价格刷新（无缓存，带跳动指示）───
async function tickBtcPrice() {
  // BTC 大盘价格（无缓存实时拉）
  const valEl = document.getElementById('moCryptoVal');
  const chgEl = document.getElementById('moCryptoChg');
  if (valEl) {
    try {
      const resp = await fetch('/api/binance/price/btc');
      if (resp.ok) {
        const data = await resp.json();
        if (data.price != null) {
          const chg = parseFloat(data.change24h) || 0;
          const cls = chg >= 0 ? 'up' : 'down';
          const sign = chg >= 0 ? '+' : '';
          valEl.textContent = `$${Math.round(data.price).toLocaleString('en')}`;
          valEl.className = `mo-value ${cls}`;
          chgEl.textContent = `${sign}${chg.toFixed(2)}%`;
          chgEl.className = `mo-change ${cls}`;
          const box = document.getElementById('moCrypto');
          if (box) {
            box.style.transition = 'box-shadow 0.1s';
            box.style.boxShadow = 'inset 0 0 6px rgba(0,255,68,0.15)';
            setTimeout(() => { box.style.boxShadow = 'none'; }, 200);
          }
        }
      }
    } catch(e) {}
  }

  // 当前 K 线币种实时价格（图表上方）
  const priceEl = document.getElementById('chartLivePrice');
  if (!priceEl || !State.currentSymbol) return;
  try {
    const sym = State.currentSymbol;
    const resp = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${sym}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const price = parseFloat(data.lastPrice);
    const chg = parseFloat(data.priceChangePercent) || 0;
    const cls = chg >= 0 ? 'up' : 'down';
    const sign = chg >= 0 ? '+' : '';
    const label = sym.replace('USDT', '');
    priceEl.textContent = `${label} $${fmt.price(price)}  ${sign}${chg.toFixed(2)}%`;
    priceEl.className = `chart-live-price ${cls}`;
  } catch(e) {}
}

// ─── 秒级 K 线最新蜡烛更新（不跳过期蜡烛，但更新收盘价）───
async function tickChart() {
  if (!State.charts.priceSeries || !State.currentSymbol) return;
  try {
    const resp = await fetch(`/api/binance/klines/${State.currentSymbol}/${State.interval}?limit=1`);
    if (!resp.ok) return;
    const data = await resp.json();
    const candles = data.candles || [];
    if (!candles.length) return;
    const last = candles[candles.length - 1];
    // 同一根蜡烛的收盘价可能变（未完成蜡烛实时更新），所以这里不跳 time 重复
    if (State.chartType === 'area') {
      State.charts.priceSeries.update({ time: last.time, value: last.close });
    } else {
      State.charts.priceSeries.update(last);
    }
  } catch(e) {}
}

// ─── 美股存储类排行（从币安拉）───
async function refreshAnomalies() {
  try {
    const [resp, analysisResp, abResp, sharesResp] = await Promise.all([
      fetch('/api/binance/signals'),
      fetch('/api/market/coin-analysis'),
      fetch('/api/alpha-beta'),
      fetch('/api/storage/shares').catch(() => ({ json: () => ({}) }))
    ]);
    if (!resp.ok) return;
    const data = await resp.json();
    const analysis = analysisResp.ok ? await analysisResp.json() : { coins: [] };
    const abData = abResp.ok ? await abResp.json() : { results: [] };
    const shares = sharesResp.ok ? await sharesResp.json() : {};
    const analysisMap = {};
    const abMap = {};
    for (const c of (analysis.coins || [])) analysisMap[c.symbol] = c;
    for (const r of (abData.results || [])) abMap[r.symbol] = r;
    
    const all = data.altcoins || [];
    const fmtMktCap = v => v >= 1e12 ? '$' + (v/1e12).toFixed(1) + 'T' : v >= 1e9 ? '$' + (v/1e9).toFixed(1) + 'B' : '$' + (v/1e6).toFixed(0) + 'M';
    const stocks = (all || []).filter(t => STORAGE_STOCKS.includes(t.symbol))
      .map(t => { t._mktCap = (parseFloat(t.price) || 0) * (shares[t.symbol] || 0) * 1e9; return t; })
      .sort((a, b) => b._mktCap - a._mktCap);
    const scroll = document.getElementById('anomaliesScroll');
    if (!stocks?.length) {
      if (!scroll.querySelector('.ticker-item')) scroll.innerHTML = '<span class="ticker-loading">等待数据...</span>';
      return;
    }
    
    // 如果币种数量变了，全量重建
    const items = scroll.querySelectorAll('.ticker-item');
    if (items.length !== stocks.length) {
      scroll.innerHTML = '';
    }
    
    // 首次加载或重建
    if (!scroll.querySelector('.ticker-item')) {
      scroll.innerHTML = stocks.map(t => {
        const chg = parseFloat(t.change24h) || 0;
        const cls = chg >= 0 ? 'up' : 'down';
        const sign = chg >= 0 ? '+' : '';
        const a = analysisMap[t.symbol.replace('USDT','')] || {};
        const badge = a.level ? ' <span style="font-size:9px;color:var(--' + (a.cl||'text-dim') + ');">' + (a.color||'') + ' ' + (a.level||'') + '</span>' : '';
        const mc = fmtMktCap(t._mktCap);
        return '<div class="ticker-item" data-sym="' + t.symbol + '">' +
          '<span class="ticker-symbol">' + t.symbol.replace('USDT','') + badge + '</span>' +
          '<span class="ticker-change ' + cls + '">' + sign + chg.toFixed(2) + '%</span>' +
          '<span class="ticker-mktcap" style="color:var(--cyan);font-size:9px">' + mc + '</span>' +
          '<span class="ticker-price" style="color:var(--text-dim);font-size:10px">$' + fmt.price(t.price) + '</span></div>';
      }).join('');
      return;
    }
    
    const symMap = {};
    for (const t of stocks) symMap[t.symbol] = t;
    for (const item of items) {
      const sym = item.dataset.sym;
      const t = symMap[sym];
      if (!t) continue;
      const chg = parseFloat(t.change24h) || 0;
      const cls = chg >= 0 ? 'up' : 'down';
      const sign = chg >= 0 ? '+' : '';
      const a = analysisMap[sym.replace('USDT','')] || {};
      const badge = a.level ? ' <span style="font-size:9px;color:var(--' + (a.cl||'text-dim') + ');">' + (a.color||'') + ' ' + (a.level||'') + '</span>' : '';
      const mc = fmtMktCap(t._mktCap);
      item.querySelector('.ticker-symbol').innerHTML = sym.replace('USDT','') + badge;
      item.querySelector('.ticker-change').textContent = sign + chg.toFixed(2) + '%';
      item.querySelector('.ticker-change').className = 'ticker-change ' + cls;
      const mcEl = item.querySelector('.ticker-mktcap');
      if (mcEl) mcEl.textContent = mc; else { const el = item.querySelector('.ticker-price'); if (el) { const span = document.createElement('span'); span.className = 'ticker-mktcap'; span.style.cssText = 'color:var(--cyan);font-size:9px'; span.textContent = mc; el.before(span); } }
      item.querySelector('.ticker-price').textContent = '$' + fmt.price(t.price);
    }
  } catch(e) {}
}

// ─── Chart ───
function initChart() {
  const el = document.getElementById('priceChart');
  if (!el) return;
  State.charts.price = LightweightCharts.createChart(el, {
    layout: { background:{color:'#0a0a0a'}, textColor:'#006622' },
    grid: { vertLines:{color:'#001a00'}, horzLines:{color:'#001a00'} },
    timeScale: { borderColor:'#003300', timeVisible:true, secondsVisible:false },
    rightPriceScale: { borderColor:'#003300' },
    width: Math.max(el.clientWidth || 400, 300),
    height: Math.max(300, Math.min(500, window.innerHeight - 280)),
  });
  State.charts.priceSeries = null;
  // 延迟重绘确保容器渲染完毕
  setTimeout(() => {
    if (State.charts.price && el.clientWidth > 0) {
      State.charts.price.applyOptions({ width: el.clientWidth });
    }
  }, 100);
  window.addEventListener('resize', () => {
    if (State.charts.price) State.charts.price.applyOptions({ width: Math.max(el.clientWidth, 300), height: Math.max(300, Math.min(500, window.innerHeight - 280)) });
  });
}

async function loadChart(symbol, interval) {
  const s = symbol || State.currentSymbol;
  const i = interval || State.interval;
  const input = document.getElementById('chartSearch');
  try {
    const data = await API.binanceKlines(s, i);
    const candles = data.candles || [];
    if (!candles.length) return;
    let cutoff = 0;
    if (State.timeRange !== 'all') cutoff = Date.now()/1000 - State.timeRange*60;
    let shown = candles.filter(c => c.time >= cutoff);
    if (shown.length < 2) return;
    // 取所有可见K线的最高最低作为范围
    const allHigh = Math.max(...shown.map(c => c.high));
    const allLow = Math.min(...shown.map(c => c.low));
    const padding = (allHigh - allLow) * 0.08; // 上下各8%边距
    const topPrice = allHigh + padding;
    const bottomPrice = allLow - padding;
    if (State.charts.priceSeries) { try { State.charts.price.removeSeries(State.charts.priceSeries); } catch(e) {} }
    if (State.chartType === 'area') {
      State.charts.priceSeries = State.charts.price.addAreaSeries({
        lineColor: '#00cc44', topColor: 'rgba(0,204,68,0.25)', bottomColor: 'rgba(0,204,68,0.01)',
        lineWidth: 2, priceFormat: { type:'custom', minMove: 0.00000001, formatter: p => p >= 1000 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p >= 0.001 ? p.toFixed(6) : p.toFixed(8) },
      });
      State.charts.priceSeries.setData(shown.map(c => ({ time: c.time, value: c.close })));
    } else {
      State.charts.priceSeries = State.charts.price.addCandlestickSeries({
        upColor: getCS('--green','#00ff00'), downColor: getCS('--red','#ff3333'), borderDownColor: getCS('--red','#ff3333'), borderUpColor: getCS('--green','#00ff00'),
        wickDownColor: getCS('--red','#ff3333'), wickUpColor: getCS('--green','#00ff00'),
        priceFormat: { type:'custom', minMove: 0.00000001, formatter: p => p >= 1000 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p >= 0.001 ? p.toFixed(6) : p.toFixed(8) },
      });
      State.charts.priceSeries.setData(shown);
    }
    // Set visible range to center current price
    State.charts.price.priceScale('right').applyOptions({
      mode: LightweightCharts.PriceScaleMode.Normal,
      autoScale: false,
    });
    // 设置价格范围：显示所有K线的最高最低+边距
    State.charts.price.priceScale('right').setVisibleRange({
      from: bottomPrice,
      to: topPrice,
    });
    State._isFirstLoad = false;
    // Store candles for lazy load
    State._candles = candles;
    State._allShown = shown;
    State._high = high;
    State._low = low;
    // Subscribe to scroll for lazy loading
    setupScrollLoad();
  } catch(e) {}
}

// ─── Scroll-triggered lazy load ───
function setupScrollLoad() {
  if (State._scrollSubscribed) return;
  try {
    State.charts.price.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (!range || !State._candles || State._candles.length < 10) return;
      const earliestVisible = range.from;
      const earliestLoaded = State._candles[0].time;
      // If scrolled near the earliest candle, load more
      if (earliestVisible <= earliestLoaded + 5) {
        const btn = document.getElementById('loadMoreChart');
        if (btn && btn.style.pointerEvents !== 'none') {
          btn.click();
        }
      }
    });
    State._scrollSubscribed = true;
  } catch(e) {}
}

// ─── Chart Load More ───
function setupChartMore() {
  const btn = document.getElementById('loadMoreChart');
  if (!btn) return;
  btn.addEventListener('click', async function() {
    const candles = State._candles || [];
    if (candles.length === 0) return;
    const earliest = candles[0];
    const sym = State.currentSymbol;
    const intv = State.interval;
    this.textContent = '加载中...';
    fetch('/api/binance/klines/history/'+sym+'/'+intv+'/'+(earliest.time*1000-1)).then(r=>r.json()).then(data => {
      const older = data.candles || [];
      if (older.length === 0) { this.textContent = '— 已加载全部 —'; this.style.pointerEvents='none'; this.style.color='#6b7199'; return; }
      // Merge older + existing
      const merged = older.concat(candles);
      const cutoff = State.timeRange === 'all' ? 0 : Date.now()/1000 - State.timeRange*60;
      const shown = merged.filter(c => c.time >= cutoff);
      if (shown.length < 2) return;
      if (State.charts.priceSeries) { try { State.charts.price.removeSeries(State.charts.priceSeries); } catch(e) {} }
      if (State.chartType === 'area') {
        State.charts.priceSeries = State.charts.price.addAreaSeries({ lineColor:'#5b8def', topColor:'rgba(91,141,239,0.3)', bottomColor:'rgba(91,141,239,0.01)', lineWidth:2, priceFormat:{type:'custom',minMove:0.00000001,formatter:p=>p>=1000?p.toFixed(2):p>=1?p.toFixed(4):p>=0.001?p.toFixed(6):p.toFixed(8)} });
        State.charts.priceSeries.setData(shown.map(c=>({time:c.time,value:c.close})));
      } else {
        State.charts.priceSeries = State.charts.price.addCandlestickSeries({ upColor:'#2ecc71', downColor:'#e74c5e', borderDownColor:'#e74c5e', borderUpColor:'#2ecc71', wickDownColor:'#e74c5e', wickUpColor:'#2ecc71' });
        State.charts.priceSeries.setData(shown);
      }
      State.charts.price.timeScale().fitContent();
      State.charts.price.priceScale('right').applyOptions({ autoScale: true });
      State._candles = merged;
      State._allShown = shown;
      this.textContent = '加载更多K线 ▼';
    }).catch(() => { this.textContent = '加载更多K线 ▼'; });
  });
}

// ─── 分页状态（替代无限 Set，上限 200 条 DOM）───
const MAX_DOM = 200;
let _whaleState = { items: [], hasMore: true, latestTs: 0, oldestTs: 0, filter: 'all', loading: false };
let _jin10State = { items: [], hasMore: true, latestId: '', oldestId: '', loading: false };
let _rssState = { items: [], hasMore: true, latestId: '', oldestId: '', loading: false };

let _newsVersion = 0;

// ─── 币圈强信号 ───
function dirLabel(t) {
  const fEx = t.exFrom || '';
  const tEx = t.exTo || '';
  if (fEx && tEx) return fEx + ' → ' + tEx;
  if (fEx) return fEx + ' → 钱包';
  if (tEx) return '钱包 → ' + tEx;
  return '钱包 → 钱包';
}
function renderWhaleItem(t, isNew) {
  const newClass = isNew ? ' class="whale-new"' : '';
  const colors = {USDC:'#22c55e', BTC:'#f7931a', USDT:'#16a34a', ETH:'#627eea'};
  const col = colors[t.c] || 'var(--accent)';
  const vs = t.c === 'BTC' ? t.val.toFixed(2) + ' BTC' : t.c === 'ETH' ? t.val.toFixed(0) + ' ETH' : t.c === 'SOL' ? t.val.toFixed(0) + ' SOL' : '$' + Number(t.val).toLocaleString();
  const fAddr = (t.from||'').slice(0,8)+'...';
  const tAddr = (t.to||'').slice(0,8)+'...';
  const fEx = t.exFrom ? '['+t.exFrom+']' : '';
  const tEx = t.exTo ? '['+t.exTo+']' : '';
  const dir = dirLabel(t);
  const tm = t.ts ? new Date(t.ts*1000).toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
  const explorer = t.c === 'BTC' ? 'https://blockchain.info/tx/' : 'https://etherscan.io/tx/';
  const div = document.createElement('div');
  div.innerHTML = '<div style="font-size:12px;padding:6px 0;border-bottom:1px solid var(--border);font-family:monospace;">' +
    '<div style="display:flex;justify-content:space-between;">' +
      '<span style="color:' + col + ';font-weight:700;">' + t.c + '</span>' +
      '<span style="font-weight:700;">' + vs + '</span>' +
      '<span style="color:var(--text-dim);font-size:10px;">' + tm + '</span>' +
      '<a href="' + explorer + t.hash + '" target="_blank" style="color:var(--accent);font-size:10px;text-decoration:none;">🔗</a>' +
    '</div>' +
    '<div style="color:var(--text-dim);font-size:10px;margin-top:2px;">' +
      fEx + fAddr + ' → ' + tEx + tAddr + ' <span style="color:var(--text-dim);font-size:9px;">' + dir + '</span>' +
    '</div>' +
  '</div>';
  if (newClass) div.firstChild.className += newClass;
  return div.firstChild;
}

function applyWhaleFilter() {
  const sel = document.getElementById('whaleFilter');
  const f = sel ? sel.value : _whaleState.filter;
  _whaleState.filter = f;
  const items = _whaleState.items;
  const filtered = f === 'all' ? items : f === 'USDT/C' ? items.filter(t => t.c === 'USDT' || t.c === 'USDC') : items.filter(t => t.c === f);
  const el = document.getElementById('whaleTransfers');
  if (!el) return;

  // 全量重建（filter 切换时）
  el.innerHTML = '';
  if (!filtered.length) {
    el.innerHTML = '<div style="color:var(--text-dim);padding:10px;">暂无数据</div>';
    return;
  }
  const show = filtered.slice(0, MAX_DOM);
  show.forEach(t => el.appendChild(renderWhaleItem(t, false)));

  // 翻页提示
  if (_whaleState.hasMore && filtered.length >= MAX_DOM) {
    const hint = document.createElement('div');
    hint.id = 'whaleLoadMore';
    hint.style.cssText = 'text-align:center;padding:8px;color:var(--text-dim);cursor:pointer;font-size:11px;';
    hint.textContent = '▼ 下拉加载更多';
    hint.onclick = () => loadMoreWhales();
    el.appendChild(hint);
  }
}

let _altcoinData = null;

async function loadMoreWhales() {
  if (_whaleState.loading || !_whaleState.hasMore) return;
  _whaleState.loading = true;
  const hint = document.getElementById('whaleLoadMore');
  if (hint) hint.textContent = '加载中...';
  try {
    const url = `/api/whale/transfers?limit=50&before=${_whaleState.oldestTs}`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();
    const newItems = data.transfers || [];
    if (newItems.length) {
      _whaleState.items = _whaleState.items.concat(newItems);
      _whaleState.oldestTs = newItems[newItems.length - 1].ts;
      _whaleState.hasMore = data.hasMore !== false;
      if (_whaleState.items.length > MAX_DOM * 2) {
        _whaleState.items = _whaleState.items.slice(-MAX_DOM * 2);
      }
      applyWhaleFilter();
    } else {
      _whaleState.hasMore = false;
      if (hint) hint.textContent = '— 已加载全部 —';
    }
  } catch(e) {}
  _whaleState.loading = false;
}

async function refreshAltcoinSignals() {
  try {
    // 钱包数据不变
    const walletRes = await fetch('/api/wallets');
    const walletData = walletRes.ok ? await walletRes.json() : { wallets: [] };
    try { if (typeof renderWallets === 'function') renderWallets(walletData); } catch(e) {}

    // 巨鲸：首次全量 or 增量轮询
    let url;
    if (_whaleState.latestTs) {
      url = `/api/whale/transfers?limit=20&after=${_whaleState.latestTs}`;
    } else {
      url = '/api/whale/transfers?limit=50';
    }
    const whaleRes = await fetch(url);
    if (!whaleRes.ok) return;
    const whaleData = await whaleRes.json();
    const newItems = whaleData.transfers || [];

    if (newItems.length) {
      if (_whaleState.latestTs) {
        // 增量：新数据插到前面
        _whaleState.items = newItems.concat(_whaleState.items);
        _whaleState.latestTs = newItems[0].ts;
        // 只在当前 filter 匹配时插 DOM，避免全量重建
        const f = _whaleState.filter;
        const el = document.getElementById('whaleTransfers');
        if (el && el.firstChild && el.firstChild.className !== '') {
          const matched = f === 'all' ? newItems : f === 'USDT/C' ? newItems.filter(t => t.c === 'USDT' || t.c === 'USDC') : newItems.filter(t => t.c === f);
          matched.slice(0, 10).reverse().forEach(t => {
            el.insertBefore(renderWhaleItem(t, true), el.firstChild);
          });
        }
        // DOM 上限裁剪
        while (el && el.children.length > MAX_DOM) {
          const loadMore = document.getElementById('whaleLoadMore');
          const last = loadMore ? loadMore.previousSibling : el.lastChild;
          if (last && last !== loadMore) last.remove();
          else break;
        }
      } else {
        // 首次加载
        _whaleState.items = newItems;
        _whaleState.latestTs = newItems[0]?.ts || 0;
        _whaleState.oldestTs = newItems[newItems.length - 1]?.ts || 0;
        _whaleState.hasMore = whaleData.hasMore !== false;
        applyWhaleFilter();
      }
    }
  } catch(e) {}
}

// ─── Auto Refresh ───
async function refreshAll() {
  document.getElementById('headerStatus').textContent = '⟳ 更新中...';
  try {
    await Promise.all([
      refreshMarket().catch(e => console.error('market', e)),
      refreshTickers().catch(e => console.error('tickers', e)),
      refreshAnomalies().catch(e => console.error('anomalies', e)),
      refreshIndicators().catch(e => console.error('indicators', e)),
      refreshLlama().catch(e => console.error('llama', e)),
      refreshAltcoinSignals().catch(e => console.error('altcoin', e)),
    ]);
  } catch(e) {}
  await loadChart().catch(e => console.error('loadChart', e));
  document.getElementById('headerStatus').textContent = '已连接';
}

// ─── 市场情绪子Tab切换 ───
function switchSentimentTab(btn, tabId) {
  document.querySelectorAll('.sub-tab').forEach(b => { b.style.background = 'var(--surface2)'; b.style.color = 'var(--text)'; });
  btn.style.background = 'var(--accent)'; btn.style.color = '#fff';
  document.querySelectorAll('.sub-tab-content').forEach(c => c.style.display = 'none');
  document.getElementById(tabId).style.display = '';
}

// ─── Tab Switching ───
function setupTabs() {
  document.querySelectorAll('.tab:not(.disabled)').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById('tab' + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1));
      if (target) target.classList.add('active');
      // 币圈强信号tab（预留）
      if (tab.dataset.tab === 'altcoin') {
        refreshAltcoinSignals();
      }
    });
  });
}

// ─── Search ───
function setupSearch() {
  const input = document.getElementById('chartSearch');
  const btn = document.getElementById('searchBtn');
  const dd = document.getElementById('searchDropdown');
  if (!input || !btn || !dd) return;
  let allSymbols = [], filtered = [], highlightIdx = -1;
  const go = (sym) => {
    const s = sym || input.value.trim().toUpperCase();
    if (!s) return;
    const fullSym = s.endsWith('USDT') ? s : s + 'USDT';
    State.currentSymbol = fullSym;
    dd.classList.remove('show');
    loadChart().catch(() => {});
  };
  const render = (list) => {
    dd.innerHTML = (!list || list.length === 0) ? '<div class="opt empty">无匹配</div>' :
      list.map((s, i) => `<div class="opt ${i === highlightIdx ? 'highlight' : ''}" data-sym="${s}">${s}</div>`).join('');
    dd.classList.add('show');
  };
  const filter = (val) => {
    const q = val.toUpperCase();
    filtered = q ? allSymbols.filter(s => s.includes(q)).slice(0, 30) : allSymbols.slice(0, 30);
    highlightIdx = -1; render(filtered);
  };
  const hide = () => { dd.classList.remove('show'); highlightIdx = -1; };
  fetch('/api/symbols/all').then(r => r.json()).then(syms => { allSymbols = syms || []; }).catch(() => {});
  input.addEventListener('focus', () => filter(input.value));
  input.addEventListener('input', () => filter(input.value));
  input.addEventListener('blur', () => setTimeout(hide, 200));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { go(); hide(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); highlightIdx = Math.min(highlightIdx + 1, filtered.length - 1); render(filtered); }
    if (e.key === 'ArrowUp') { e.preventDefault(); highlightIdx = Math.max(highlightIdx - 1, -1); render(filtered); }
  });
  btn.addEventListener('click', () => go());
  dd.addEventListener('mousedown', (e) => { const opt = e.target.closest('.opt'); if (opt && opt.dataset.sym) { input.value = opt.dataset.sym; go(opt.dataset.sym); }});
  dd.addEventListener('touchstart', (e) => { const opt = e.target.closest('.opt'); if (opt && opt.dataset.sym) { input.value = opt.dataset.sym; go(opt.dataset.sym); }}, { passive: true });
}

// ─── DeFi 质押收益率 ───
async function refreshDeFiYields() {
  const el = document.getElementById('defiYieldList');
  const countEl = document.getElementById('defiCount');
  if (!el || !countEl) return;
  try {
    const r = await fetch('/api/defi/yields?minTvl=1000000&limit=30');
    const d = await r.json();
    if (!d.pools || !d.pools.length) return;
    
    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.dataset.tab !== 'trade') return;
    
    countEl.textContent = d.pools.length + '/' + d.total + ' 池';
    
    // 用增量更新
    const keySet = new Set();
    el.querySelectorAll('.defi-row').forEach(row => {
      const hash = row.dataset.hash;
      if (hash) keySet.add(hash);
    });
    
    let html = '';
    const chainColors = { Ethereum:'#627eea', Solana:'#9945ff', Base:'#0052ff', BSC:'#f0b90b', Arbitrum:'#2d374b', Polygon:'#8247e5', Avalanche:'#e84142', Fantom:'#1969ff', Hyperliquid_L1:'#000' };
    for (let i = 0; i < d.pools.length; i++) {
      const p = d.pools[i];
      const hash = p.pool || p.symbol + p.project + p.chain;
      const isNew = !keySet.has(hash);
      const cls = 'defi-row' + (isNew ? ' whale-new' : '');
      const col = chainColors[p.chain] || '#888';
      const tvl = p.tvl >= 1e9 ? (p.tvl/1e9).toFixed(1) + 'B' : p.tvl >= 1e6 ? (p.tvl/1e6).toFixed(1) + 'M' : p.tvl >= 1e3 ? (p.tvl/1e3).toFixed(0) + 'K' : p.tvl.toFixed(0);
      const apyColor = p.apy > 100 ? '#ff4444' : p.apy > 50 ? '#ff8800' : p.apy > 20 ? 'var(--green)' : 'var(--text)';
      html += '<div class="' + cls + '" data-hash="' + hash + '" style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:11px;">' +
        '<span style="display:flex;align-items:center;gap:4px;">' +
          '<span style="color:' + col + ';font-weight:600;">' + (i+1) + '</span>' +
          '<span style="font-weight:600;">' + p.symbol + '</span>' +
          '<span style="color:var(--text-dim);font-size:10px;">' + p.chain.slice(0,4) + '</span>' +
        '</span>' +
        '<span style="display:flex;align-items:center;gap:8px;">' +
          '<span style="color:var(--text-dim);font-size:10px;">' + tvl + '</span>' +
          '<span style="color:' + apyColor + ';font-weight:700;">' + p.apy.toFixed(1) + '%</span>' +
        '</span>' +
      '</div>';
    }
    el.innerHTML = html;
  } catch(e) {}
}
function setupViews() {
  document.querySelectorAll('#viewGroup .btn-sm').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#viewGroup .btn-sm').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      State.interval = btn.dataset.int;
      State.timeRange = btn.dataset.range === 'all' ? 'all' : parseInt(btn.dataset.range);
      loadChart();
    });
  });
}

// ─── News: 分类页面导航 + 下拉刷新 ───
// ─── 消息面：分页 + 增量轮询 ───
function renderJin10Item(i) {
  const hasBody = i.body && i.body.length > 5;
  const imp = i.imp ? ' imp' : '';
  const div = document.createElement('div');
  div.className = 'jin10-item' + imp + ' whale-new';
  if (hasBody) div.onclick = function(){this.classList.toggle('expanded');};
  div.innerHTML = '<div class="jin10-head"><span class="jin10-time">' + i.t + '</span><span class="jin10-text">' + i.s + '</span>' + (hasBody ? '<span class="jin10-arrow">▾</span>' : '') + '</div>' + (hasBody ? '<div class="jin10-body">' + i.body + '</div>' : '');
  return div;
}

function renderRssItem(i, now) {
  const pad2 = n => String(n).padStart(2, '0');
  const pub = new Date(i.t);
  let ts;
  if (pub.toDateString() === now.toDateString()) ts = pad2(pub.getHours()) + ':' + pad2(pub.getMinutes());
  else {
    const y = new Date(now); y.setDate(y.getDate()-1);
    ts = pub.toDateString() === y.toDateString() ? '昨天 ' + pad2(pub.getHours()) + ':' + pad2(pub.getMinutes()) : pad2(pub.getMonth()+1) + '-' + pad2(pub.getDate()) + ' ' + pad2(pub.getHours()) + ':' + pad2(pub.getMinutes());
  }
  const title = i.s_cn || i.s;
  const link = i.link || '';
  const hasLink = link.length > 5;
  const div = document.createElement('div');
  div.className = 'jin10-item whale-new';
  if (hasLink) div.onclick = function(){this.classList.toggle('expanded');};
  div.innerHTML = '<div class="jin10-head"><span class="jin10-time">' + ts + '</span><span class="jin10-text">' + title + '</span>' + (hasLink ? '<span class="jin10-arrow">▾</span>' : '') + '</div>' + (hasLink ? '<div class="jin10-body"><a href="' + link + '" target="_blank" style="color:var(--accent);text-decoration:underline;font-size:12px;">查看原文 ↗</a></div>' : '');
  return div;
}

function setupNews() {
  // 首次加载：拉最新 30 条
  Promise.all([
    fetch('/api/news/jin10?limit=30').then(r => r.json()),
    fetch('/api/news/rss?limit=30').then(r => r.json()),
  ]).then(([jin10Data, rssData]) => {
    const jin10 = jin10Data.items || [];
    const rss = rssData.items || [];

    if (jin10.length) {
      _jin10State.items = jin10;
      _jin10State.latestId = jin10[0].t + jin10[0].s;
      _jin10State.oldestId = jin10[jin10.length - 1].t + jin10[jin10.length - 1].s;
      _jin10State.hasMore = jin10Data.hasMore !== false;
    }
    if (rss.length) {
      _rssState.items = rss;
      _rssState.latestId = rss[0].s + (rss[0].link || '');
      _rssState.oldestId = rss[rss.length - 1].s + (rss[rss.length - 1].link || '');
      _rssState.hasMore = rssData.hasMore !== false;
    }

    // 渲染
    renderNewsLists();
  }).catch(() => {});
}

function renderNewsLists() {
  const now = new Date();

  // 金十
  const jin10Body = document.getElementById('jin10Body');
  const jin10Count = document.getElementById('jin10Count');
  if (jin10Count) jin10Count.textContent = '(' + _jin10State.items.length + ')';
  if (jin10Body) {
    if (!_jin10State.items.length) {
      jin10Body.innerHTML = '<div class="sig-loading">暂无快讯</div>';
    } else {
      jin10Body.innerHTML = '';
      _jin10State.items.slice(0, MAX_DOM).forEach(i => {
        jin10Body.appendChild(renderJin10Item(i));
      });
      if (_jin10State.hasMore) {
        const hint = document.createElement('div');
        hint.id = 'jin10LoadMore';
        hint.style.cssText = 'text-align:center;padding:6px;color:var(--text-dim);cursor:pointer;font-size:10px;';
        hint.textContent = '▼ 加载更多';
        hint.onclick = loadMoreJin10;
        jin10Body.appendChild(hint);
      }
    }
  }

  // RSS
  const rssBody = document.getElementById('rssBody');
  const rssCount = document.getElementById('rssCount');
  if (rssCount) rssCount.textContent = '(' + _rssState.items.length + ')';
  if (rssBody) {
    if (!_rssState.items.length) {
      rssBody.innerHTML = '<div class="sig-loading">暂无新闻</div>';
    } else {
      rssBody.innerHTML = '';
      _rssState.items.slice(0, MAX_DOM).forEach(i => {
        rssBody.appendChild(renderRssItem(i, now));
      });
      if (_rssState.hasMore) {
        const hint = document.createElement('div');
        hint.id = 'rssLoadMore';
        hint.style.cssText = 'text-align:center;padding:6px;color:var(--text-dim);cursor:pointer;font-size:10px;';
        hint.textContent = '▼ 加载更多';
        hint.onclick = loadMoreRss;
        rssBody.appendChild(hint);
      }
    }
  }
}

async function checkNewsIncremental() {
  // 增量轮询：只拿新数据
  const fetches = [];
  if (_jin10State.latestId) {
    fetches.push(fetch('/api/news/jin10?limit=5&after=' + encodeURIComponent(_jin10State.latestId)).then(r => r.json()).then(d => ({ type:'jin10', data:d })));
  }
  if (_rssState.latestId) {
    fetches.push(fetch('/api/news/rss?limit=5&after=' + encodeURIComponent(_rssState.latestId)).then(r => r.json()).then(d => ({ type:'rss', data:d })));
  }
  if (!fetches.length) return;

  const results = await Promise.all(fetches).catch(() => []);
  for (const r of results) {
    if (!r) continue;
    const items = r.data.items || [];
    if (!items.length) continue;

    if (r.type === 'jin10') {
      _jin10State.items = items.concat(_jin10State.items);
      _jin10State.latestId = items[0].t + items[0].s;
      if (_jin10State.items.length > MAX_DOM * 2) _jin10State.items = _jin10State.items.slice(0, MAX_DOM * 2);
      const body = document.getElementById('jin10Body');
      if (body && body.firstChild) {
        const countEl = document.getElementById('jin10Count');
        if (countEl) countEl.textContent = '(' + _jin10State.items.length + ')';
        items.slice(0, 10).reverse().forEach(i => {
          body.insertBefore(renderJin10Item(i), body.firstChild);
        });
        while (body.children.length > MAX_DOM) {
          const loadMore = document.getElementById('jin10LoadMore');
          const last = loadMore ? loadMore.previousSibling : body.lastChild;
          if (last && last !== loadMore) last.remove();
          else break;
        }
      }
    } else {
      _rssState.items = items.concat(_rssState.items);
      _rssState.latestId = items[0].s + (items[0].link || '');
      if (_rssState.items.length > MAX_DOM * 2) _rssState.items = _rssState.items.slice(0, MAX_DOM * 2);
      const body = document.getElementById('rssBody');
      if (body && body.firstChild) {
        const countEl = document.getElementById('rssCount');
        if (countEl) countEl.textContent = '(' + _rssState.items.length + ')';
        const now = new Date();
        items.slice(0, 10).reverse().forEach(i => {
          body.insertBefore(renderRssItem(i, now), body.firstChild);
        });
        while (body.children.length > MAX_DOM) {
          const loadMore = document.getElementById('rssLoadMore');
          const last = loadMore ? loadMore.previousSibling : body.lastChild;
          if (last && last !== loadMore) last.remove();
          else break;
        }
      }
    }
  }
}

async function loadMoreJin10() {
  if (_jin10State.loading || !_jin10State.hasMore) return;
  _jin10State.loading = true;
  const hint = document.getElementById('jin10LoadMore');
  if (hint) hint.textContent = '加载中...';
  try {
    const resp = await fetch('/api/news/jin10?limit=30&before=' + encodeURIComponent(_jin10State.oldestId));
    const data = await resp.json();
    const items = data.items || [];
    if (items.length) {
      _jin10State.items = _jin10State.items.concat(items);
      _jin10State.oldestId = items[items.length - 1].t + items[items.length - 1].s;
      _jin10State.hasMore = data.hasMore !== false;
      const body = document.getElementById('jin10Body');
      if (body) {
        if (hint) hint.remove();
        items.forEach(i => body.appendChild(renderJin10Item(i)));
        if (_jin10State.hasMore) body.appendChild(hint);
      }
    } else {
      _jin10State.hasMore = false;
      if (hint) hint.textContent = '— 已加载全部 —';
    }
  } catch(e) {}
  _jin10State.loading = false;
}

async function loadMoreRss() {
  if (_rssState.loading || !_rssState.hasMore) return;
  _rssState.loading = true;
  const hint = document.getElementById('rssLoadMore');
  if (hint) hint.textContent = '加载中...';
  try {
    const resp = await fetch('/api/news/rss?limit=30&before=' + encodeURIComponent(_rssState.oldestId));
    const data = await resp.json();
    const items = data.items || [];
    if (items.length) {
      _rssState.items = _rssState.items.concat(items);
      _rssState.oldestId = items[items.length - 1].s + (items[items.length - 1].link || '');
      _rssState.hasMore = data.hasMore !== false;
      const now = new Date();
      const body = document.getElementById('rssBody');
      if (body) {
        if (hint) hint.remove();
        items.forEach(i => body.appendChild(renderRssItem(i, now)));
        if (_rssState.hasMore) body.appendChild(hint);
      }
    } else {
      _rssState.hasMore = false;
      if (hint) hint.textContent = '— 已加载全部 —';
    }
  } catch(e) {}
  _rssState.loading = false;
}

// ─── Init ───
function init() {
  initTheme();
  initChart();
  setupTabs();
  setupSearch();
  setupViews();
  setupNews();
  initBackdoor();

  // Chart type
  const areaBtn = document.getElementById('chartTypeArea');
  const candleBtn = document.getElementById('chartTypeCandle');
  if (areaBtn) areaBtn.addEventListener('click', () => { areaBtn.classList.add('active'); candleBtn.classList.remove('active'); State.chartType = 'area'; loadChart(); });
  if (candleBtn) candleBtn.addEventListener('click', () => { candleBtn.classList.add('active'); areaBtn.classList.remove('active'); State.chartType = 'candle'; loadChart(); });

  // —— 分级别刷新 ——
  // Tier 0: BTC大盘 + K线最新蜡烛 —— 3秒（隧道高延迟，1秒太频）
  setInterval(() => { tickBtcPrice(); tickChart(); }, 3000);

  // Tier 1: 大盘（纳指/标普/上证 + 主流排行）—— 5秒
  setInterval(() => { refreshMarket(); refreshTickers(); }, 5000);

  // Tier 2: 存储股 + 巨鲸强信号 —— 3秒
  setInterval(() => { refreshAnomalies(); refreshAltcoinSignals(); }, 3000);

  // Tier 3: 低频（恐惧指数 + 山寨季指数）—— 3分钟
  setInterval(() => { refreshIndicators(); refreshLlama(); }, 180000);

  // 消息面 —— 增量轮询（3秒一次，只拉新数据）
  setInterval(() => {
    checkNewsIncremental();
  }, 3000);

  // 聪明地址分析：30秒刷新
  refreshAddressAnalysis();
  setInterval(refreshAddressAnalysis, 30000);

  // loading动画播完就关页面，不等数据返回
  bootTerminal().then(() => {
    setTimeout(() => {
      const loader = document.getElementById('fullLoader');
      if (loader) {
        loader.classList.add('hidden');
        setTimeout(() => { if (loader.parentNode) loader.remove(); }, 500);
      }
    }, 500);
  });
  // 数据异步加载，不阻塞页面渲染
  refreshAll();
}

// ─── 终端启动动画（返回 Promise，完成后 resolve）───
function bootTerminal() {
  const body = document.getElementById('termBootBody');
  if (!body) return Promise.resolve();

  const speed = 2.5 + Math.random() * 1.5;
  const baseChar = Math.round(2 * speed);
  const jitter = () => Math.random() * 2 * speed;

  const lines = [
    { pre: '> ',        text: 'connecting to data sources...',        then: ' ✓', wait: 40 },
    { pre: '> ',        text: 'fetching BTC price...',                then: ' ✓', wait: 30 },
    { pre: '> ',        text: 'fetching ETH price...',                then: ' ✓', wait: 30 },
    { pre: '> ',        text: 'scanning altcoin markets...',          then: ' ✓', wait: 40 },
    { pre: '> ',        text: 'loading K-line data...',               then: ' ✓', wait: 30 },
    { pre: '> ',        text: 'syncing news feeds...',                then: ' ✓', wait: 30 },
    { pre: '> ',        text: 'initializing dashboard...',            then: ' ✓', wait: 30 },
    { pre: '',           text: 'system ready',                         then: '',  wait: 0, cls: 'ok' },
  ];

  return new Promise(resolve => {
    let lineIdx = 0;
    let charIdx = 0;
    let currentEl = null;

    function typeNext() {
      if (lineIdx >= lines.length) {
        // 所有命令行输出完毕 → resolve
        resolve();
        return;
      }

      const line = lines[lineIdx];

      if (!currentEl) {
        const div = document.createElement('div');
        div.className = 'term-boot-line';
        div.innerHTML = `<span class="prompt">${line.pre}</span><span class="text${line.cls ? ' '+line.cls : ''}"></span>`;
        body.appendChild(div);
        currentEl = div.querySelector('.text');
        charIdx = 0;
      }

      if (charIdx < line.text.length) {
        currentEl.textContent += line.text[charIdx];
        charIdx++;
        setTimeout(typeNext, baseChar + jitter());
      } else {
        if (line.then) {
          const ok = document.createElement('span');
          ok.className = 'ok';
          ok.textContent = line.then;
          currentEl.after(ok);
        }
        currentEl = null;
        lineIdx++;
        setTimeout(typeNext, Math.round(line.wait * speed));
      }
    }

    typeNext();
  });
}

document.addEventListener('DOMContentLoaded', init);

// ─── 隐藏后门：logo点5次激活 ───
// ─── 主题切换 ───
function getCS(v, fallback) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fallback; } catch(e) { return fallback; }
}

function initTheme() {
  const saved = localStorage.getItem("tuhasen_theme") || "green";
  document.documentElement.setAttribute("data-theme", saved);
  document.querySelectorAll(".theme-dot").forEach(dot => {
    const t = dot.dataset.theme;
    if (t === saved) dot.classList.add("active");
    dot.addEventListener("click", () => {
      document.querySelectorAll(".theme-dot").forEach(d => d.classList.remove("active"));
      dot.classList.add("active");
      document.documentElement.setAttribute("data-theme", t);
      localStorage.setItem("tuhasen_theme", t);
      // 更新 K 线颜色
      setTimeout(updateChartTheme, 50);
    });
  });
}

// ─── 主题切换时更新 K 线颜色 ───
function updateChartTheme() {
  const style = getComputedStyle(document.documentElement);
  const green = style.getPropertyValue('--green').trim() || '#00ff00';
  const red = style.getPropertyValue('--red').trim() || '#ff3333';
  if (State.charts.price) {
    try { State.charts.price.removeSeries(State.charts.priceSeries); } catch(e) {}
    loadChart();
  }
}

function initBackdoor() {
  // 用户ID（从 localStorage 读取，每个设备唯一）
  let uid = localStorage.getItem('bd_uid');
  if (!uid) {
    uid = 'user_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
    localStorage.setItem('bd_uid', uid);
  }

  let clickCount = 0, clickTimer = null;
  const logo = document.getElementById('mainLogo');
  const bd = document.getElementById('backdoor');
  const input = document.getElementById('backdoorInput');
  const msgs = document.getElementById('bdMsgs');
  const close = document.getElementById('backdoorClose');
  const expand = document.getElementById('backdoorExpand');
  const sendBtn = document.getElementById('backdoorSend');
  const uidEl = document.getElementById('bdUid');

  if (!logo || !bd) return;
  if (uidEl) uidEl.textContent = uid.slice(0, 10) + '...';

  // 快捷键 Ctrl+Shift+B
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault(); toggle();
    }
  });

  // 点 logo 5 次
  logo.addEventListener('click', () => {
    clickCount++;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { clickCount = 0; }, 1500);
    if (clickCount >= 5) { clickCount = 0; toggle(); }
  });

  function toggle() {
    bd.classList.toggle('active');
    if (bd.classList.contains('active')) {
      loadMsgs();
      setTimeout(() => { if (input) input.focus(); }, 200);
    }
  }

  if (close) close.addEventListener('click', () => bd.classList.remove('active'));

  // 展开/还原
  if (expand) expand.addEventListener('click', () => {
    bd.classList.toggle('expanded');
    if (bd.classList.contains('expanded')) {
      loadMsgs();
      setTimeout(() => { if (input) input.focus(); }, 200);
    }
  });

  // 发消息
  function sendMsg() {
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    // 本地显示
    addMsg('user', msg);
    // 发到后端
    fetch('/api/bd/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, msg }),
    }).catch(() => {});
  }

  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
  if (sendBtn) sendBtn.addEventListener('click', sendMsg);

  // 添加消息气泡
  function addMsg(role, text) {
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'bd-msg ' + role;
    const t = new Date();
    const pad = n => String(n).padStart(2,'0');
    div.innerHTML = text + `<span class="bd-time">${pad(t.getHours())}:${pad(t.getMinutes())}</span>`;
    // 去掉旧的思考气泡
    const think = msgs.querySelector('.bd-thinking');
    if (think) think.remove();
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  // 载入历史
  function loadMsgs() {
    fetch('/api/bd/messages?uid=' + uid).then(r => r.json()).then(data => {
      if (!msgs) return;
      msgs.innerHTML = '';
      (data.messages || []).forEach(m => addMsg(m.role, m.text));
    }).catch(() => {});
  }

  // 轮询
  let thinkingShown = false;
  setInterval(() => {
    if (!bd.classList.contains('active')) return;
    fetch('/api/bd/status?uid=' + uid).then(r => r.json()).then(data => {
      if (data.thinking && !thinkingShown && msgs) {
        thinkingShown = true;
        const div = document.createElement('div');
        div.className = 'bd-thinking';
        div.innerHTML = '<span></span><span></span><span></span>';
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
      }
      if (!data.thinking) thinkingShown = false;
      if (data.reply) {
        addMsg('assistant', data.reply);
      }
    }).catch(() => {});
  }, 2000);
}

// ─── 聪明地址分析（纯展示，不碰巨鲸） ───
function renderAddressAnalysis(data) {
  const el = document.getElementById('addressAnalysis');
  if (!el) return;
  if (!data || (!data.btc?.length && !data.eth?.length)) {
    el.innerHTML = '<div style="color:var(--text-dim);padding:8px;font-size:11px;">暂无数据，正在积累中...</div>';
    return;
  }
  let html = '';
  if (data.btc?.length) {
    html += '<div style="font-weight:700;color:var(--accent);font-size:12px;margin:6px 0 4px;">🐋 BTC (' + data.btc.length + ')</div>';
    for (const a of data.btc) {
      const addr = (a.address||'').slice(0, 16) + '...';
      const c = a.behavior?.includes('🔴') ? 'var(--red)' : a.behavior?.includes('🔵') ? 'var(--green)' : 'var(--text)';
      html += '<div style="font-size:10px;padding:3px 0;border-bottom:1px solid var(--border);">' + 
        '<span style="color:' + c + '">' + (a.behavior||'') + '</span> ' +
        '<span style="font-weight:700;">' + (a.balance||0).toFixed(1) + ' BTC</span> | ' +
        '7天: ' + (a.recentNet >= 0 ? '+' : '') + (a.recentNet||0).toFixed(4) +
        '<span style="color:var(--text-dim);float:right;font-size:9px;">' + addr + '</span></div>';
    }
  }
  if (data.eth?.length) {
    html += '<div style="font-weight:700;color:var(--accent);font-size:12px;margin:8px 0 4px;">🐋 ETH (' + data.eth.length + ')</div>';
    const top = data.eth.filter(a => a.behavior !== '中性').concat(data.eth.filter(a => a.behavior === '中性').slice(0,5));
    for (const a of top) {
      const addr = (a.address||'').slice(0, 16) + '...';
      const c = a.behavior?.includes('🔴') ? 'var(--red)' : a.behavior?.includes('🔵') ? 'var(--green)' : 'var(--text)';
      html += '<div style="font-size:10px;padding:3px 0;border-bottom:1px solid var(--border);">' + 
        '<span style="color:' + c + '">' + (a.behavior||'') + '</span> ' +
        '<span>' + (a.totalVal||0).toFixed(0) + ' ETH</span> | 交易所: ' + (a.netExchangeFlow >= 0 ? '+' : '') + (a.netExchangeFlow||0).toFixed(0) +
        '<span style="color:var(--text-dim);float:right;font-size:9px;">' + addr + '</span></div>';
    }
  }
  el.innerHTML = html || '<div style="color:var(--text-dim);padding:8px;font-size:11px;">暂无数据</div>';
}

async function refreshAddressAnalysis() {
  try {
    const res = await fetch('/api/whale/addresses');
    if (res.ok) {
      const data = await res.json();
      renderAddressAnalysis(data);
    }
  } catch(e) {}
}

// ─── BTC 行情告警显示（实例） ───
async function refreshBtcAlert() {
  const el = document.getElementById('btcAlertBar');
  if (!el) return;
  try {
    const res = await fetch('/api/alerts/price');
    if (!res.ok) return;
    const data = await res.json();
    const alerts = (data.alerts || []).filter(a => a.name === 'BTC' || a.symbol === 'BTCUSDT');
    if (alerts.length === 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const latest = alerts[0];
    el.innerHTML = '<span style="color:var(--accent);font-weight:700;">BTC</span> ' +
      (latest.msg || '') +
      '<span style="color:var(--text-dim);float:right;font-size:10px;">' +
      (latest.ts ? new Date(latest.ts*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : '') +
      '</span>';
  } catch(e) {}
}

// 添加到刷新循环
setInterval(refreshBtcAlert, 5000);
setTimeout(refreshBtcAlert, 1000);















// ─── 聪明钱地址追踪 ───
let _smBuilt = false;
const _smCats = ['超短线交易员 ⚡', '短线交易员 🔹', '中线交易员', '钻石手 💎'];
const _acCats = ['15分钟内活跃 🔥', '1小时内活跃 ⚡', '一天内活跃 🔹', '7天内活跃 💤'];

function getCatIdx(w) {
  const tx = w.txCount || 0;
  const bal = parseFloat(w.balance || 0);
  if (tx > 1000) return 0;
  if (tx > 100) return 1;
  if (bal > 1000 && tx < 5) return 3;
  return 2;
}

// 从交易记录时间戳判断活跃度
function getActivityIdx(w) {
  const txs = w.recentTxs || [];
  if (txs.length === 0) return 3;
  // 取第一条交易的时间
  const first = txs[0];
  const m = first.match(/\[(\d{2}:\d{2})\]/);
  if (!m) return 3;
  const [h, min] = m[1].split(':').map(Number);
  const now = new Date();
  const txMin = h * 60 + min;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const diff = Math.abs(nowMin - txMin);
  if (diff <= 15) return 0;
  if (diff <= 60) return 1;
  if (diff <= 1440) return 2;
  return 3;
}

async function refreshSmartMoney() {
  const el = document.getElementById('smartMoneyBody');
  if (!el) return;
  try {
    const res = await fetch('/api/whale/smart-money');
    if (!res.ok) return;
    const d = await res.json();
    const whales = d.whales || [];const cntEl=document.getElementById("ethNewCount");if(cntEl){cntEl.textContent="+"+d.new24h+" 今日新增"};
    
    if (!_smBuilt) {
      // 交易员分类
      const tGroups = [[],[],[],[]];
      for (const w of whales) tGroups[getCatIdx(w)].push(w);
      
      // 活跃度分类
      const aGroups = [[],[],[],[]];
      for (const w of whales) aGroups[getActivityIdx(w)].push(w);
      
      let html = '';
      
      // ═══ 一级分类2：活跃度分类 ═══
      html += '<div style="margin:4px 0;border:1px solid var(--border);border-radius:4px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 6px;cursor:pointer;background:var(--surface2);font-size:11px;font-weight:700;" onclick="var b=document.getElementById(\'sm_active\');b.style.display=b.style.display===\'none\'?\'\':\'none\';this.querySelector(\'.sm_t2\').textContent=b.style.display===\'none\'?\'▶\':\'▼\';">';
      html += '<span>⚡ 活跃度分类 <span style="color:var(--text-dim);font-weight:400;font-size:10px;">' + whales.length + '个</span></span>';
      html += '<span class="sm_t2" style="font-size:10px;">▼</span>';
      html += '</div>';
      html += '<div id="sm_active" style="padding:2px 0;">';
      for (let ci = 0; ci < _acCats.length; ci++) {
        const list = aGroups[ci];
        
        html += '<div style="margin:1px 4px;border:1px solid var(--border);border-radius:3px;">';
        html += '<div style="display:flex;justify-content:space-between;padding:3px 6px;cursor:pointer;font-size:10px;background:var(--surface);" onclick="var b=document.getElementById(\'al_'+ci+'\');b.style.display=b.style.display===\'none\'?\'\':\'none\';this.querySelector(\'.ac_'+ci+'\').textContent=b.style.display===\'none\'?\'▶\':\'▼\';">';
        html += '<span><b>' + _acCats[ci] + '</b> <span style="color:var(--text-dim);">' + list.length + '</span></span>';
        html += '<span class="ac_'+ci+'" style="font-size:9px;">▶</span>';
        html += '</div>';
        html += '<div id="al_'+ci+'" style="display:none;padding:1px 0;">';
        for (let wi = 0; wi < list.length; wi++) {
          const w = list[wi];
          html += walletRow(ci, wi, 'a', w);
        }
        html += '</div></div>';
      }
      html += '</div></div>';
      
// ═══ 一级分类1：交易员分类 ═══
      html += '<div style="margin:2px 0;border:1px solid var(--border);border-radius:4px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 6px;cursor:pointer;background:var(--surface2);font-size:11px;font-weight:700;" onclick="var b=document.getElementById(\'sm_trader\');b.style.display=b.style.display===\'none\'?\'\':\'none\';this.querySelector(\'.sm_t1\').textContent=b.style.display===\'none\'?\'▶\':\'▼\';">';
      html += '<span>📊 交易员分类 <span style="color:var(--text-dim);font-weight:400;font-size:10px;">' + whales.length + '个</span></span>';
      html += '<span class="sm_t1" style="font-size:10px;">▼</span>';
      html += '</div>';
      html += '<div id="sm_trader" style="display:none;padding:2px 0;">';
      for (let ci = 0; ci < _smCats.length; ci++) {
        const list = tGroups[ci];
        
        html += '<div style="margin:1px 4px;border:1px solid var(--border);border-radius:3px;">';
        html += '<div style="display:flex;justify-content:space-between;padding:3px 6px;cursor:pointer;font-size:10px;background:var(--surface);" onclick="var b=document.getElementById(\'tl_'+ci+'\');b.style.display=b.style.display===\'none\'?\'\':\'none\';this.querySelector(\'.tc_'+ci+'\').textContent=b.style.display===\'none\'?\'▶\':\'▼\';">';
        html += '<span><b>' + _smCats[ci] + '</b> <span style="color:var(--text-dim);">' + list.length + '</span></span>';
        html += '<span class="tc_'+ci+'" style="font-size:9px;">▶</span>';
        html += '</div>';
        html += '<div id="tl_'+ci+'" style="display:none;padding:1px 0;">';
        for (let wi = 0; wi < list.length; wi++) {
          const w = list[wi];
          html += walletRow(ci, wi, 't', w);
        }
        html += '</div></div>';
      }
      html += '</div></div>';
      
            el.innerHTML = html || '<div style="color:var(--text-dim);font-size:10px;padding:4px 0;">正在积累数据...</div>';
      _smBuilt = true;
    } else {
      // 增量更新
      for (let ci = 0; ci < 4; ci++) {
        const tList = whales.filter(w => getCatIdx(w) === ci);
        for (let wi = 0; wi < tList.length; wi++) {
          for (const p of ['t','a']) {
            const bid = document.getElementById('sb_'+p+'_'+ci+'_'+wi);
            const tid = document.getElementById('st_'+p+'_'+ci+'_'+wi);
            if (bid) bid.textContent = parseFloat(tList[wi].balance).toFixed(0) + ' ETH';
            if (tid) tid.textContent = tList[wi].behavior || '';
          }
        }
      }
    }
  } catch(e) {}
}

function walletRow(ci, wi, prefix, w) {
  const addr = (w.fullAddr||'').slice(0,6)+'..'+(w.fullAddr||'').slice(-4);
  let r = '<div style="padding:2px 6px;cursor:pointer;border-bottom:1px dotted var(--surface3);" onclick="var b=document.getElementById(\'sd_'+prefix+'_'+ci+'_'+wi+'\');b.style.display=b.style.display===\'none\'?\'\':\'none\';this.querySelector(\'.sw_'+prefix+'_'+ci+'_'+wi+'\').textContent=b.style.display===\'none\'?\'▸\':\'▾\';">';
  r += '<div style="display:flex;justify-content:space-between;font-size:10px;">';
  r += '<span><span class="sw_'+prefix+'_'+ci+'_'+wi+'" style="font-size:9px;">▸</span><b>' + addr + '</b></span>';
  r += '<span id="sb_'+prefix+'_'+ci+'_'+wi+'" style="font-weight:700;">' + parseFloat(w.balance).toFixed(0) + ' ETH</span>';
  r += '</div>';
  r += '<div id="st_'+prefix+'_'+ci+'_'+wi+'" style="color:var(--text-dim);font-size:9px;margin:1px 0 0 14px;">' + (w.behavior||'') + '</div>';
  r += '</div>';
  r += '<div id="sd_'+prefix+'_'+ci+'_'+wi+'" style="display:none;padding:2px 6px 4px 16px;font-size:9px;background:var(--surface);color:var(--text-dim);">';
  const txs = w.recentTxs || [];
  if (txs.length) for (const tx of txs) r += '<div>' + tx + '</div>';
  else r += '<div>无近期交易</div>';
  r += '</div>';
  return r;
}

setInterval(refreshSmartMoney, 30000);
setTimeout(refreshSmartMoney, 2000);
