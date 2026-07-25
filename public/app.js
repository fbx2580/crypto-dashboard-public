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
    if (f.value != null) {
      document.getElementById("fngRing").setAttribute("stroke-dasharray", f.value + ", " + (100-f.value));
      document.getElementById("fngValue").textContent = f.value;
      document.getElementById("fngLabel").textContent = (f.value >= 50 ? "😊" : "😨") + " 恐惧";
      document.getElementById("fngValue").textContent = f.value + " - " + (f.label || "");
    }
    if (a.value != null) {
      document.getElementById("altRing").setAttribute("stroke-dasharray", a.value + ", " + (100-a.value));
      document.getElementById("altValue").textContent = a.value;
      document.getElementById("altRing").style.stroke = a.value >= 50 ? "var(--green)" : "var(--accent)";
      document.getElementById("altLabel").textContent = a.value >= 50 ? "🟢 山寨季" : "🔵 比特季";
      document.getElementById("altValue").textContent = a.value + "/100";
    }
  } catch(e) {}
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
    setMoFlow('moBtcFlow', c.btcPrice);
    // 市场状态
    if (data.marketRegime) {
      const mr = document.getElementById('marketRegime');
      if (mr) {
        const regimeLabels = {strong_bull:'🟢强牛',bull:'🟢牛',neutral:'⚪',bear:'🔴熊',panic:'🛑恐慌'};
        mr.textContent = regimeLabels[data.marketRegime] || '?';
      }
    }
    if (sh) { setItem('moA01', sh.price.toFixed(0), sh.changePercent); setMoFlow('moShFlow', sh.price); }
    if (data.nasdaq) { setItem('moNasdaq', '$' + data.nasdaq.price.toLocaleString('en', {minimumFractionDigits:0}), data.nasdaq.changePercent); setMoFlow('moNasdaqFlow', data.nasdaq.price); }
    if (data.sp500) { setItem('moSp500', '$' + data.sp500.price.toLocaleString('en', {minimumFractionDigits:0}), data.sp500.changePercent); setMoFlow('moSp500Flow', data.sp500.price); }
    if (data.gold) { setItem('moGold', '$' + data.gold.price.toFixed(1), data.gold.changePercent); setMoFlow('moGoldFlow', data.gold.price); }
    if (data.oil) { setItem('moOil', '$' + data.oil.price.toFixed(2), data.oil.changePercent); setMoFlow('moOilFlow', data.oil.price); }
  } catch(e) {}
}

// 资金流向：基于价格短期动量（对比~15秒前）
const _flowTracker = {};
function isMarketOpen(marketId) {
  const now = new Date();
  const d = now.getUTCDay(), h = now.getUTCHours(), m = now.getUTCMinutes();
  const t = h * 60 + m;
  switch(marketId) {
    case 'moBtcFlow': return true;
    case 'moShFlow': // A股 周一~五 9:30-11:30/13:00-15:00 北京时间 → UTC+8
      if (d === 0 || d === 6) return false;
      return (t >= 90 && t <= 210) || (t >= 300 && t <= 420);
    case 'moNasdaqFlow': case 'moSp500Flow': // 美股 周一~五 9:30-16:00 ET → UTC-4(夏)
      if (d === 0 || d === 6) return false;
      return t >= 810 && t <= 1200;
    case 'moGoldFlow': case 'moOilFlow': // 期货 周日22:00~周五21:00 UTC，每日21-22维护
      if (d === 6) return false;
      if (d === 0 && t < 1320) return false;
      if (d === 5 && t >= 1260) return false;
      if (t >= 1260 && t < 1320) return false;
      return true;
    default: return true;
  }
}
function getFlowHTML(id, price) {
  if (!price || price <= 0) return 'neutral';
  if (!_flowTracker[id]) _flowTracker[id] = [];
  const t = _flowTracker[id];
  t.push(price);
  if (t.length > 10) t.shift();
  // 数据不够先按开盘/休盘区分
  if (t.length < 3) return isMarketOpen(id) ? 'neutral' : 'closed';
  const prev = t[t.length - 4] || t[0];
  const pct = (price - prev) / prev;
  // 有波动就报方向，不管开没开盘
  if (pct > 0.0005) return 'in_strong';
  if (pct > 0.0002) return 'in_weak';
  if (pct < -0.0005) return 'out_strong';
  if (pct < -0.0002) return 'out_weak';
  // 价格完全没动 + 休盘 → 休盘；开盘但没动 → 观望
  if (Math.abs(pct) < 0.00001 && !isMarketOpen(id)) return 'closed';
  return 'neutral';
}
function setMoFlow(elId, price) {
  const el = document.getElementById(elId);
  if (!el) return;
  const signal = getFlowHTML(elId, price);
  const map = { in_strong:['⤴ 流入','#22c55e'], in_weak:['↗ 微入','#86efac'], out_strong:['⤵ 流出','#ef4444'], out_weak:['↘ 微出','#fbbf24'], neutral:['—','var(--text-dim)'], closed:['休盘','var(--text-dim)'] };
  const v = map[signal] || ['—','var(--text-dim)'];
  el.textContent = v[0];
  el.style.color = v[1];
}

// ─── 主流币排行（谁更硬谁更软）───
async function refreshTickers() {
  try {
    const [resp, analysisResp] = await Promise.all([
      fetch('/api/binance/signals'),
      fetch('/api/market/coin-analysis')
    ]);
    if (!resp.ok) return;
    const data = await resp.json();
    const analysis = analysisResp.ok ? await analysisResp.json() : { coins: [] };
    const analysisMap = {};
    for (const c of (analysis.coins || [])) analysisMap[c.symbol] = c;
    
    const majors = (data.majors || []).filter(t => ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOTUSDT'].includes(t.symbol)).sort((a, b) => b.change24h - a.change24h);
    const bar = document.getElementById('tickerBar');
    if (!majors?.length) {
      if (!bar.querySelector('.ticker-item')) bar.innerHTML = '<span class="ticker-loading">等待数据...</span>';
      return;
    }
    
    // 首次加载：创建 DOM
    if (!bar.querySelector('.ticker-item')) {
      bar.innerHTML = majors.map(t => {
        const chg = parseFloat(t.change24h) || 0;
        const cls = chg >= 0 ? 'up' : 'down';
        const sign = chg >= 0 ? '+' : '';
        const a = analysisMap[t.symbol.replace('USDT','')] || {};
        const badge = a.level ? '<span style="font-size:9px;color:var(--' + (a.cl||'text-dim') + ');margin-left:4px;">' + (a.color||'') + ' ' + (a.level||'') + (a.depthRatio ? (a.depthRatio >= 1 ? ' · 挂买 ' + Math.round(a.depthRatio/(1+a.depthRatio)*100) + '%' : ' · 挂卖 ' + Math.round(1/(1+a.depthRatio)*100) + '%') : '') + '</span>' : '';
        return '<div class="ticker-item" data-sym="' + t.symbol + '">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span class="ticker-symbol">' + t.symbol.replace('USDT','') + '</span>' +
          '<span class="ticker-price">$' + fmt.price(t.price) + '</span>' +
          '<span class="ticker-change ' + cls + '">' + sign + chg.toFixed(2) + '%</span></div>' +
          (a.level ? '<div style="font-size:9px;margin-top:2px;">' + '<span style="color:var(--' + (a.cl||'text-dim') + ');">' + (a.color||'') + ' ' + (a.level||'') + '</span>' + (a.depthRatio ? '<span style="color:var(--green);"> · ' + (a.depthRatio >= 1 ? '多军 ' + Math.round(a.depthRatio/(1+a.depthRatio)*100) + '%' : '') + '</span>' : '') + (a.depthRatio && a.depthRatio < 1 ? '<span style="color:var(--red);"> · 空军 ' + Math.round(1/(1+a.depthRatio)*100) + '%</span>' : '') + '</div>' : '') +
          '</div>';
      }).join('');
      return;
    }
    
    // 后续更新：只改 textContent，不动 DOM
    const items = bar.querySelectorAll('.ticker-item');
    const len = Math.min(items.length, majors.length);
    for (let i = 0; i < len; i++) {
      const t = majors[i];
      const item = items[i];
      item.querySelector('.ticker-price').textContent = '$' + fmt.price(t.price);
      const chg = parseFloat(t.change24h) || 0;
      const cls = chg >= 0 ? 'up' : 'down';
      const sign = chg >= 0 ? '+' : '';
      const chgEl = item.querySelector('.ticker-change');
      chgEl.textContent = sign + chg.toFixed(2) + '%';
      chgEl.className = 'ticker-change ' + cls;
    }
  } catch(e) {}
}

// 美股存储类（币安 TradFi 永续合约代码）
const STORAGE_STOCKS = ['NVDABUSDT','AMDBUSDT','INTCBUSDT','MUBUSDT','WDCBUSDT','DRAMBUSDT','SKHYBUSDT','SNDKBUSDT','STXUSDT','SKHYNIXUSDT'];

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
          setMoFlow('moBtcFlow', data.price);
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
    const resp = await fetch('/api/binance/signals');
    if (!resp.ok) return;
    const data = await resp.json();
    const all = data.altcoins || [];
    const stocks = (all || []).filter(t => STORAGE_STOCKS.includes(t.symbol))
      .sort((a, b) => b.change24h - a.change24h);
    const scroll = document.getElementById('anomaliesScroll');
    if (!stocks?.length) {
      if (!scroll.querySelector('.anomaly-item')) scroll.innerHTML = '<span class="anomalies-loading">等待数据...</span>';
      return;
    }
    
    // 首次加载
    if (!scroll.querySelector('.anomaly-item')) {
      scroll.innerHTML = stocks.map(t => {
        const chg = parseFloat(t.change24h) || 0;
        const cls = chg >= 0 ? 'up' : 'down';
        const sign = chg >= 0 ? '+' : '';
        return '<div class="anomaly-item" data-sym="' + t.symbol + '">' +
          '<span class="anomaly-symbol">' + t.symbol.replace('USDT','') + '</span>' +
          '<span class="anomaly-chg ' + cls + '">' + sign + chg.toFixed(2) + '%</span>' +
          '<span class="anomaly-price" style="color:var(--text-dim);font-size:10px">$' + fmt.price(t.price) + '</span></div>';
      }).join('');
      return;
    }
    
    // 后续：只改 textContent
    const items = scroll.querySelectorAll('.anomaly-item');
    const len = Math.min(items.length, stocks.length);
    for (let i = 0; i < len; i++) {
      const t = stocks[i];
      const item = items[i];
      const chg = parseFloat(t.change24h) || 0;
      const cls = chg >= 0 ? 'up' : 'down';
      const sign = chg >= 0 ? '+' : '';
      item.querySelector('.anomaly-chg').textContent = sign + chg.toFixed(2) + '%';
      item.querySelector('.anomaly-chg').className = 'anomaly-chg ' + cls;
      item.querySelector('.anomaly-price').textContent = '$' + fmt.price(t.price);
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

let _newsVersion = 0;

// ─── 山寨币吸筹监控（基于扫描引擎）───
let _accumSignals = null;
function applyAccumFilter() {
  const q = (document.getElementById('accumSearch')?.value || '').toUpperCase();
  const rows = document.querySelectorAll('.accum-row');
  const groups = document.querySelectorAll('.accum-group');
  
  if (!q) {
    // 清空搜索：恢复原分组
    rows.forEach(row => { row.style.display = ''; });
    groups.forEach(g => { g.style.display = ''; });
    // 清理之前注入的搜索结果行
    document.querySelectorAll('.accum-row-search').forEach(r => r.remove());
    return;
  }

  // 搜索模式：隐藏所有分组，创建搜索结果区
  groups.forEach(g => { g.style.display = 'none'; });
  
  // 先从现有DOM找
  let found = false;
  rows.forEach(row => {
    const sym = (row.dataset.sym || '').toUpperCase();
    if (sym.includes(q)) { row.style.display = ''; found = true; }
    else row.style.display = 'none';
  });

  // 如果没找到，从全量数据里匹配（包括被截断的弱信号）
  if (!found && _accumSignals) {
    const matches = _accumSignals.filter(s => (s.symbol||'').toUpperCase().includes(q));
    if (matches.length) {
      document.querySelectorAll('.accum-row-search').forEach(r => r.remove());
      const el = document.getElementById('accumulationBody');
      if (el) {
        let inject = '<div class="accum-row-search" style="margin-top:8px;">';
        for (const s of matches) {
          const chgCls = s.change24h >= 0 ? 'up' : 'down';
          const chgSign = s.change24h >= 0 ? '+' : '';
          const estVal = s.estAccumulation >= 1e9 ? (s.estAccumulation/1e9).toFixed(1)+'B' : s.estAccumulation >= 1e6 ? (s.estAccumulation/1e6).toFixed(1)+'M' : (s.estAccumulation/1e3).toFixed(0)+'K';
          const sc = s.score||0;
          const scClr = sc >= 60 ? '#22c55e' : sc >= 40 ? '#fbbf24' : 'var(--text-dim)';
          const btns = (s.conditions||[]).map(c => '<span class="accum-cond ' + (c.met?'met':'') + '">' + (c.met?'✅':'❌') + ' ' + c.label + '</span>').join('');
          const dur = s.accumDays ? s.accumDays + '天' : '';
          inject += '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:10px;">' +
            '<div class="accum-top"><span class="accum-sym">' + s.symbol + (s.accType==='band'?' 📡':'') + '</span>' +
            '<span class="accum-score-badge" style="color:' + scClr + '">' + sc + '分</span>' +
            '<span class="accum-price">$' + fmt.price(s.price) + '</span>' +
            '<span class="accum-chg ' + chgCls + '">' + chgSign + s.change24h.toFixed(2) + '%</span></div>' +
            '<div class="accum-conds">' + btns + '</div>' +
            '<div class="accum-info"><span>VWAP ' + fmt.price(s.vwap) + '</span><span>吸筹 ~$' + estVal + '</span>' + (dur ? '<span>' + dur + '</span>' : '') + '<span>费率 ' + ((s.fundingRate||0)*100).toFixed(4) + '%</span>' + (s.marketCap ? '<span>市值 ' + (s.marketCap>=1e9?'$'+(s.marketCap/1e9).toFixed(1)+'B':s.marketCap>=1e6?'$'+(s.marketCap/1e6).toFixed(0)+'M':'$'+(s.marketCap/1e3).toFixed(0)+'K') + '</span>' : '') + '</div>' +
            (s.entryLabel ? '<div class="accum-entry"><span style="color:' + (s.entryStatus==='in_zone'?'#22c55e':'var(--text-dim)') + ';">' + s.entryLabel + '</span></div>' : '') +
          '</div>';
        }
        inject += '</div>';
        el.insertAdjacentHTML('beforeend', inject);
      }
    }
  }
}
async function refreshAccumulationMonitor() {
  const el = document.getElementById('accumulationBody');
  if (!el) return;
  try {
    const resp = await fetch('/api/accumulation/scan');
    if (!resp.ok) return;
    const data = await resp.json();
    const signals = data.signals || [];
    _accumSignals = signals;

    document.getElementById('accumUpdateTime').textContent =
      (data.scannedAt ? new Date(data.scannedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : '—');

    if (!signals.length) {
      el.innerHTML = '<div style="color:var(--text-dim);padding:10px;">暂无信号 · 扫描' + (data.totalScanned||0) + '个币</div>';
      return;
    }

    const m5 = signals.filter(s => s.metCount >= 5);
    const m4 = signals.filter(s => s.metCount === 4);
    const m3 = signals.filter(s => s.metCount === 3);
    const m2 = signals.filter(s => s.metCount === 2);
    const brk = signals.filter(s => s.breakout?.ready);
    const rest = signals.filter(s => !s.breakout?.ready);
    const rm5 = rest.filter(s => s.metCount >= 5);
    const rm4 = rest.filter(s => s.metCount === 4);
    const rm3 = rest.filter(s => s.metCount === 3);
    const rm2 = rest.filter(s => s.metCount === 2);
    const groups = [
      { label: '🔥 突破预备 (' + brk.length + ')', signals: brk, cls: '' },
      { label: '🔴 强吸筹 (' + (rm5.length+rm4.length) + ')', signals: [...rm5, ...rm4], cls: 'accum-strong' },
      { label: '🟡 中等 (' + rm3.length + ')', signals: rm3, cls: 'accum-mid' },
      { label: '⚪ 弱信号 (' + rm2.length + ')', signals: rm2.slice(0, 20), cls: 'accum-weak' },
    ];

    if (true) { // 全量重建
      let html = '<div style="font-size:10px;color:var(--text-dim);margin-bottom:4px;" id="accumSummary">扫描' + (data.totalScanned||'?') + '币 → 信号' + signals.length + ' · 权重:震仓30+底背离25+地量15+长下影10~20+独立15</div>';
      for (const g of groups) {
        if (!g.signals.length) continue;
        html += '<div class="accum-group"><div class="accum-group-hd">' + g.label + '</div>';
        for (let i = 0; i < g.signals.length; i++) {
          const s = g.signals[i];
          const btns = s.conditions.map(c => {
            const ico = c.met ? '✅' : '❌';
            const wt = c.met ? c.weight : 0;
            const tip = '<b>' + c.label + (c.met ? ' (+' + c.weight + '分)</b><br>' : ' (0分)</b><br>') +
              '<span style="color:var(--text-dim);font-size:11px;">' + c.desc + '</span><br>' +
              '<span style="font-size:10px;">' + c.detail + '</span>';
            return '<span class="accum-cond ' + (c.met ? 'met' : '') + '">' + ico + ' ' + c.label +
              '<span class="accum-tooltip">' + tip + '</span></span>';
          }).join('');
          const chgCls = s.change24h >= 0 ? 'up' : 'down';
          const chgSign = s.change24h >= 0 ? '+' : '';
          const estVal = s.estAccumulation >= 1e9 ? (s.estAccumulation/1e9).toFixed(1)+'B' : s.estAccumulation >= 1e6 ? (s.estAccumulation/1e6).toFixed(1)+'M' : (s.estAccumulation/1e3).toFixed(0)+'K';
          const sc = s.score || 0;
          const scClr = sc >= 60 ? '#22c55e' : sc >= 40 ? '#fbbf24' : 'var(--text-dim)';
          const durTxt = s.accumDays ? s.accumDays + '天' : '';
          html += '<div class="accum-row" data-sym="' + s.symbol + '">' +
            '<div class="accum-top">' +
              '<span class="accum-sym">' + s.symbol + (s.accType === 'band' ? ' 📡' : '') + '</span>' +
              '<span class="accum-score-badge" style="color:' + scClr + '">' + sc + '分</span>' +
              '<span class="accum-price">$' + fmt.price(s.price) + '</span>' +
              '<span class="accum-chg ' + chgCls + '">' + chgSign + s.change24h.toFixed(2) + '%</span>' +
            '</div>' +
            '<div class="accum-conds">' + btns + '</div>' +
            '<div class="accum-info"><span>VWAP ' + fmt.price(s.vwap) + '</span><span>吸筹 ~$' + estVal + '</span>' + (s.accumDays ? '<span>' + s.accumDays + '天</span>' : '') + '<span>费率 ' + ((s.fundingRate||0)*100).toFixed(4) + '%</span>' + (s.marketCap ? '<span>市值 ' + (s.marketCap>=1e9?'$'+(s.marketCap/1e9).toFixed(1)+'B':s.marketCap>=1e6?'$'+(s.marketCap/1e6).toFixed(0)+'M':'$'+(s.marketCap/1e3).toFixed(0)+'K') + '</span>' : '') + '</div>' +
            (s.breakout && s.breakout.ready ? '<div class="accum-entry" style="color:#f0b90b;">🔥 突破预备 · 确认度' + (s.breakout.confidence||0) + '%</div>' : '') +
            '<div class="accum-entry">' +
              (s.entryStatus === 'in_zone' ? '<span style="color:#22c55e;">' + (s.entryLabel||'✓ 成本区内') + '</span>' :
               s.entryStatus === 'sub_zone' ? '<span style="color:#fbbf24;">' + (s.entryLabel||'⚠ 吸筹区下方') + '</span>' :
               s.entryStatus === 'avalanche' ? '<span style="color:#ef4444;">' + (s.entryLabel||'⚠ 深跌中') + '</span>' :
               s.entryStatus === 'above_cost' ? '<span style="color:#86efac;">' + (s.entryLabel||'庄家已获利') + '</span>' :
               '<span style="color:#fbbf24;">' + (s.entryLabel||'已脱离吸筹区') + '</span>') +
              '<span style="color:var(--text-dim);font-size:9px;">区间 ' + fmt.price(s.entryZone.low) + '~' + fmt.price(s.entryZone.high) + ' 庄成本' + fmt.price(s.entryZone.whaleCost) + '</span>' +
            '</div>' +
          '</div>';
        }
        html += '</div>';
      }
      el.innerHTML = html;
      // DOM rebuilt
    } else {
      // 增量更新
      document.getElementById('accumSummary').textContent = '形态识别 · 扫' + (data.totalScanned||'?') + '币 · 信号' + signals.length;
      const rows = el.querySelectorAll('.accum-row');
      const allFlat = [...m5, ...m4, ...m3, ...m2.slice(0,20)];
      const len = Math.min(rows.length, allFlat.length);
      for (let i = 0; i < len; i++) {
        const s = allFlat[i];
        const row = rows[i];
        const chgCls = s.change24h >= 0 ? 'up' : 'down';
        const chgSign = s.change24h >= 0 ? '+' : '';
        row.querySelector('.accum-sym').textContent = s.symbol + (s.accType === 'band' ? ' 📡' : '');
        row.dataset.sym = s.symbol;
        row.querySelector('.accum-price').textContent = '$' + fmt.price(s.price);
        const chgEl = row.querySelector('.accum-chg');
        chgEl.textContent = chgSign + s.change24h.toFixed(2) + '%';
        chgEl.className = 'accum-chg ' + chgCls;
      }
    }
  } catch(e) {
    el.innerHTML = '<div style="color:var(--text-dim);padding:10px;">加载失败</div>';
  }
}

// ─── 币圈强信号 ───
window._whaleTxs = [];
window._whaleHashes = new Set();
function dirLabel(t) {
  const fEx = t.exFrom || '';
  const tEx = t.exTo || '';
  if (fEx && tEx) return fEx + ' → ' + tEx;
  if (fEx) return fEx + ' → 钱包';
  if (tEx) return '钱包 → ' + tEx;
  return '钱包 → 钱包';
}
function applyWhaleFilter() {
  const sel = document.getElementById('whaleFilter');
  const f = sel ? sel.value : 'all';
  const txs = window._whaleTxs || [];
  const el = document.getElementById('whaleTransfers');
  if (!el) return;
  const show = f === 'all' ? txs : f === 'USDT/C' ? txs.filter(t => t.c === 'USDT' || t.c === 'USDC') : txs.filter(t => t.c === f);
  el.innerHTML = !show.length ? '<div style="color:var(--text-dim);padding:10px;">暂无数据</div>' : show.map(t => {
    const isNew = !window._whaleHashes.has(t.hash);
    if (isNew) window._whaleHashes.add(t.hash);
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
    return '<div' + newClass + ' style="font-size:12px;padding:6px 0;border-bottom:1px solid var(--border);font-family:monospace;">' +
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
  }).join('');
}

let _altcoinData = null;

async function refreshAltcoinSignals() {
  try {
    const [walletRes, whaleRes] = await Promise.all([
      fetch('/api/wallets'),
      fetch('/api/whale/transfers'),
    ]);
    const walletData = walletRes.ok ? await walletRes.json() : { wallets: [] };
    const whaleData = whaleRes.ok ? await whaleRes.json() : { transfers: [] };
    window._whaleTxs = whaleData.transfers || [];
    applyWhaleFilter();
    renderWallets(walletData);
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
      refreshAccumulationMonitor().catch(e => console.error('accum', e)),
    ]);
  } catch(e) {}
  await loadChart().catch(e => console.error('loadChart', e));
  document.getElementById('headerStatus').textContent = '已连接';
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
      if (tab.dataset.tab === 'accumulation') {
        refreshAccumulationMonitor();
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
// ─── 消息面：重建版 — 只展示真实 RSS 数据，零伪造 ───
window._jin10Seen = new Set();
window._rssSeen = new Set();
function setupNews() {
  fetch('/api/news').then(r => r.json()).then(data => {
    const jin10 = data?.jin10 || [];
    const rss = data?.rss || [];

    // 金十模块 — 仅追加新条目
    const jin10Body = document.getElementById('jin10Body');
    const jin10Count = document.getElementById('jin10Count');
    if (jin10Count) jin10Count.textContent = '(' + jin10.length + ')';
    if (jin10Body) {
      if (!jin10.length) {
        if (!jin10Body.children.length) jin10Body.innerHTML = '<div class="sig-loading">暂无快讯</div>';
      } else {
        let newCount = 0;
        jin10.slice().reverse().forEach(i => {
          const key = i.t + i.s;
          if (window._jin10Seen.has(key)) return;
          window._jin10Seen.add(key);
          newCount++;
          const hasBody = i.body && i.body.length > 5;
          const imp = i.imp ? ' imp' : '';
          const div = document.createElement('div');
          div.className = 'jin10-item' + imp + ' whale-new';
          if (hasBody) div.onclick = function(){this.classList.toggle('expanded');};
          div.innerHTML = '<div class="jin10-head"><span class="jin10-time">' + i.t + '</span><span class="jin10-text">' + i.s + '</span>' + (hasBody ? '<span class="jin10-arrow">▾</span>' : '') + '</div>' + (hasBody ? '<div class="jin10-body">' + i.body + '</div>' : '');
          jin10Body.insertBefore(div, jin10Body.firstChild);
        });
      }
    }

    // RSS 模块 — 仅追加新条目
    const rssBody = document.getElementById('rssBody');
    const rssCount = document.getElementById('rssCount');
    if (rssCount) rssCount.textContent = '(' + rss.length + ')';
    if (rssBody) {
      if (!rss.length) {
        if (!rssBody.children.length) rssBody.innerHTML = '<div class="sig-loading">暂无新闻</div>';
      } else {
        const now = new Date();
        const pad2 = n => String(n).padStart(2, '0');
        rss.slice().reverse().forEach(i => {
          const key = i.s + (i.link || '');
          if (window._rssSeen.has(key)) return;
          window._rssSeen.add(key);
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
          rssBody.insertBefore(div, rssBody.firstChild);
        });
      }
    }
  }).catch(() => {});
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
  // Tier 0: 秒级（BTC大盘 + K线最新蜡烛）—— 1秒
  setInterval(() => { tickBtcPrice(); tickChart(); }, 1000);

  // Tier 1: 大盘（纳指/标普/上证 + 主流排行）—— 5秒
  setInterval(() => { refreshMarket(); refreshTickers(); }, 5000);

  // Tier 2: 存储股 + 强信号—— 5秒
  setInterval(() => { refreshAnomalies(); refreshAltcoinSignals(); }, 2000);
  setInterval(() => { refreshAccumulationMonitor(); }, 30000);

  // Tier 3: 低频（恐惧指数 + 山寨季指数）—— 3分钟
  setInterval(() => { refreshIndicators(); refreshLlama(); }, 180000);

  // 消息面：10秒刷新一次（实时新闻）
  setInterval(() => {
    if (document.getElementById('tabNews')?.classList.contains('active')) {
      setupNews();
    }
  }, 10000);

  // 巨鲸转账：无论哪个 tab 都 2 秒拉一次
  // 聪明地址分析：30秒刷新
  refreshAddressAnalysis();
  setInterval(refreshAddressAnalysis, 30000);
  setInterval(() => {
    refreshAltcoinSignals();
  }, 2000);

  // 终端启动动画 + 数据拉取，两边都完成才淡出
  const bootDone = bootTerminal();
  Promise.all([refreshAll(), bootDone]).then(() => {
    const loader = document.getElementById('fullLoader');
    if (loader) {
      loader.classList.add('hidden');
      setTimeout(() => { if (loader.parentNode) loader.remove(); }, 500);
    }
  });
}

// ─── 终端启动动画（返回 Promise，完成后 resolve）───
function bootTerminal() {
  const body = document.getElementById('termBootBody');
  if (!body) return Promise.resolve();

  const speed = 0.7 + Math.random() * 0.6;
  const baseChar = Math.round(4 * speed);
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
