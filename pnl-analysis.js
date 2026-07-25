#!/usr/bin/env node
/** 老阈值回测：提取≥4条件样本→盈亏比+Bootstrap */
const axios = require('axios'); const fs = require('fs'); const path = require('path');
const BINANCE = 'https://api.binance.com/api/v3';
const OUT = path.join(__dirname,'public','data','analysis','old_threshold_pnl.json');
const MAJORS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT'];

const ema=(d,p)=>{const k=2/(p+1),o=[];let s=0;for(let i=0;i<p&&i<d.length;i++)s+=d[i];o.push(s/Math.min(p,d.length));for(let i=1;i<d.length;i++)o.push(d[i]*k+o[i-1]*(1-k));return o};
const rsi=(c,p=14)=>{if(c.length<p+1)return new Array(c.length).fill(50);const o=new Array(p).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d}let ag=g/p,al=l/p;o[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*13+(d>0?d:0))/14;al=(al*13+(d<0?-d:0))/14;o[i]=al===0?100:100-100/(1+ag/al)}return o};
const pear = (x,y) => {const rx=[],ry=[];for(let i=1;i<Math.min(x.length,y.length);i++){rx.push((x[i]-x[i-1])/x[i-1]);ry.push((y[i]-y[i-1])/y[i-1])}const n=Math.min(rx.length,ry.length);let sx=0,sy=0,sxy=0,sx2=0,sy2=0;for(let i=0;i<n;i++){sx+=rx[i];sy+=ry[i];sxy+=rx[i]*ry[i];sx2+=rx[i]*rx[i];sy2+=ry[i]*ry[i]}const num=n*sxy-sx*sy;const den=Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));return den===0?0:num/den};
async function gj(u,p={}){return(await axios.get(u,{params:p,timeout:15000})).data}
async function gk(s,st,en){const d=await gj(`${BINANCE}/klines`,{symbol:s,interval:'1d',startTime:st,endTime:en,limit:300});return d.map(k=>({time:k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}))}
function L(m){console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`)}

// ═══ 老阈值5形态（长下影≥2）═══
function ck_old(kl,btc){
  const n=kl.length,cl=kl.map(k=>k.close);
  const hf=kl.slice(-Math.floor(n/2)),ah=kl.slice(0,kl.length-hf.length);
  const vh=hf.reduce((s,k)=>s+k.volume,0)/Math.max(hf.length,1),ve=ah.reduce((s,k)=>s+k.volume,0)/Math.max(ah.length,1);
  const hi=Math.max(...kl.map(k=>k.high)),lo=Math.min(...kl.map(k=>k.low));const c1={met:ve>0&&vh/ve<0.6&&(hi-lo)/lo<0.30};
  const r=rsi(cl,14);const pls=[];
  for(let i=2;i<kl.length-2;i++){if(kl[i].low<kl[i-1].low&&kl[i].low<kl[i-2].low&&kl[i].low<kl[i+1].low&&kl[i].low<kl[i+2].low)if(r[i]!==null)pls.push({low:kl[i].low,rsi:r[i]})}
  let c2={met:false};if(pls.length>=2){const p1=pls[pls.length-2],p2=pls[pls.length-1];c2={met:p2.low<=p1.low&&p2.rsi>p1.rsi}}
  // 老阈值: ≥2根长下影
  let wc=0;for(const k of kl.slice(-n)){const b=Math.abs(k.close-k.open),w=Math.min(k.open,k.close)-k.low;if(b>0&&w>b*2.5)wc++}const c3={met:wc>=2,count:wc};
  const lw=Math.min(...kl.map(k=>k.low));let c4={met:false};for(let i=5;i<kl.length-3;i++){if(kl[i].low<lw*0.95){let rc=false,vs=false;for(let j=i+1;j<Math.min(i+4,kl.length);j++){if(kl[j].close>lw)rc=true;if(kl[j].volume>kl.slice(Math.max(0,i-5),i).reduce((s,x)=>s+x.volume,0)/Math.max(i-5,1))vs=true}if(rc&&vs){c4.met=true;break}}}
  const cr=pear(cl.slice(-30),btc.slice(-30).map(k=>k.close));const c5={met:Math.abs(cr)<0.3};
  return [c1,c2,c3,c4,c5];
}

async function main(){
  const now=Date.now();
  const windows = [];
  // 跑最近8个可用窗口，每个窗口90天训练+30天验证
  for (let m = 1; m <= 8; m++) {
    const test = now - m * 30 * 86400000;
    const train = test - 90 * 86400000;
    const fwd = test + 30 * 86400000;
    if (test < now && fwd <= now) windows.push({ test, train, fwd });
  }
  L(`🔬 老阈值回测: ${windows.length}个窗口`);

  const xi = await gj(`${BINANCE}/exchangeInfo`);
  const alts = xi.symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && !MAJORS.includes(s.symbol)).map(s => s.symbol);
  L(`${alts.length}个山寨币`);

  const allTop = [];
  let totalTests = 0;

  for (const w of windows) {
    let btc; try { btc = await gk('BTCUSDT', w.train, w.test); } catch(e) { continue; }
    if (btc.length < 30) continue;
    let found = 0;
    for (const sym of alts) {
      try {
        const tr = await gk(sym, w.train, w.test); if (tr.length < 31) continue;
        const cs = ck_old(tr, btc); const mc = cs.filter(c => c.met).length;
        if (mc < 4) continue;
        const fw = await gk(sym, w.test, Math.min(w.fwd, now)); if (fw.length < 5) continue;
        const ep = tr[tr.length - 1].close, xp = fw[fw.length - 1].close;
        const rtn = (xp - ep) / ep;
        const mx = (Math.max(...fw.map(k => k.high)) - ep) / ep;
        const mn = (Math.min(...fw.map(k => k.low)) - ep) / ep;
        allTop.push({ sym: sym.replace('USDT', ''), rtn, mx, mn, mc, wicks: cs[2].count || 0 });
        found++;
      } catch(e) {}
      totalTests++;
      if (totalTests % 500 === 0) await new Promise(r => setTimeout(r, 10));
    }
    L(`  窗${new Date(w.test).toISOString().slice(0,10)}: ≥4条件${found}个`);
    await new Promise(r => setTimeout(r, 10));
  }

  // ═══ 盈亏比 ═══
  L(`\n═══ 老阈值≥4条件: ${allTop.length}个样本 ═══`);
  if (allTop.length === 0) { L('❌ 无样本'); process.exit(0); }

  const wins = allTop.filter(r => r.rtn > 0);
  const losses = allTop.filter(r => r.rtn <= 0);
  const winAvg = wins.length > 0 ? wins.reduce((s,r) => s + r.rtn, 0) / wins.length : 0;
  const lossAvg = losses.length > 0 ? losses.reduce((s,r) => s + r.rtn, 0) / losses.length : 0;
  const pnl = Math.abs(winAvg / (lossAvg || 0.01));
  const hardStop = Math.abs(winAvg / 0.10);

  L(`赢(${wins.length}): 均+${(winAvg*100).toFixed(1)}%`);
  L(`亏(${losses.length}): 均${(lossAvg*100).toFixed(1)}%`);
  L(`盈亏比: ${pnl.toFixed(2)}  硬止损10%→${hardStop.toFixed(2)}`);

  // ═══ Bootstrap ═══
  const returns = allTop.map(r => r.rtn);
  const B = 10000;
  const boot = [];
  for (let i = 0; i < B; i++) {
    let s = 0;
    for (let j = 0; j < allTop.length; j++) s += returns[Math.floor(Math.random() * returns.length)];
    boot.push(s / allTop.length);
  }
  boot.sort((a,b) => a - b);
  const avg = boot.reduce((s,v) => s+v, 0)/B;
  const bMin = boot[Math.floor(B * 0.01)];
  const bMax = boot[Math.floor(B * 0.99)];
  const lossProb = boot.filter(v => v < 0).length / B;

  L(`\n═══ Bootstrap (N=${B}) ═══`);
  L(`均值: ${(avg*100).toFixed(1)}%`);
  L(`1%分位: ${(bMin*100).toFixed(1)}%  99%分位: ${(bMax*100).toFixed(1)}%`);
  L(`亏损概率: ${(lossProb*100).toFixed(1)}%`);
  L(`投\$10: 预期\$${(10*avg).toFixed(2)} (最差\$${(10*bMin).toFixed(2)}~最好\$${(10*bMax).toFixed(2)})`);

  // 逐个样本
  L(`\n样本明细:`);
  for (const r of allTop.sort((a,b) => b.rtn - a.rtn)) {
    L(`  ${(r.rtn>=0?'+':'')}${(r.rtn*100).toFixed(1)}% ${r.sym.padEnd(12)} 最高${(r.mx*100).toFixed(0)}% 最惨${(r.mn*100).toFixed(0)}% ${r.wicks}影`);
  }

  // 盈亏比敏感度（不同止损比例）
  L(`\n盈亏比敏感度:`);
  for (const stop of [0.05, 0.10, 0.15, 0.20]) {
    const adjLoss = Math.max(lossAvg, -stop);
    const adjPnl = Math.abs(winAvg / adjLoss);
    L(`  止损${(stop*100).toFixed(0)}% → 盈亏比${adjPnl.toFixed(2)}`);
  }

  const out = {
    samples: allTop.length,
    wins: wins.length, losses: losses.length,
    winAvg, lossAvg, pnl, hardStopPnl: hardStop,
    bootstrap: { avg, min: bMin, max: bMax, lossProb, samples: B },
    raw: allTop,
  };
  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  L(`\n✅ 保存至${OUT}`);
}
main().catch(e => { L('❌ '+e.message); process.exit(1); });
