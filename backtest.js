#!/usr/bin/env node
/** 分层回测引擎 v2 — 按牛/熊/横盘分组验证 */
const axios = require('axios'); const fs = require('fs'); const path = require('path');
const BINANCE = 'https://api.binance.com/api/v3';
const OUT = path.join(__dirname, 'public', 'data', 'analysis', 'backtest_stratified.json');
const MAJORS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT'];

// ═══ 工具 ═══
const ema = (d,p) => {const k=2/(p+1),o=[];let s=0;for(let i=0;i<p&&i<d.length;i++)s+=d[i];o.push(s/Math.min(p,d.length));for(let i=1;i<d.length;i++)o.push(d[i]*k+o[i-1]*(1-k));return o};
const rsi = (c,p=14) => {if(c.length<p+1)return new Array(c.length).fill(50);const o=new Array(p).fill(null);let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d}let ag=g/p,al=l/p;o[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*13+(d>0?d:0))/14;al=(al*13+(d<0?-d:0))/14;o[i]=al===0?100:100-100/(1+ag/al)}return o};
const pear = (x,y) => {const rx=[],ry=[];for(let i=1;i<Math.min(x.length,y.length);i++){rx.push((x[i]-x[i-1])/x[i-1]);ry.push((y[i]-y[i-1])/y[i-1])}const n=Math.min(rx.length,ry.length);let sx=0,sy=0,sxy=0,sx2=0,sy2=0;for(let i=0;i<n;i++){sx+=rx[i];sy+=ry[i];sxy+=rx[i]*ry[i];sx2+=rx[i]*rx[i];sy2+=ry[i]*ry[i]}const num=n*sxy-sx*sy;const den=Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));return den===0?0:num/den};
async function gj(url,p={}){return(await axios.get(url,{params:p,timeout:15000})).data}
async function gk(s,st,en){const d=await gj(`${BINANCE}/klines`,{symbol:s,interval:'1d',startTime:st,endTime:en,limit:300});return d.map(k=>({time:k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}))}
function L(m){console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`)}

// ═══ 5形态 ═══
function ck(kl,btc){
  const n=kl.length,cl=kl.map(k=>k.close);
  const hf=kl.slice(-Math.floor(n/2)),ah=kl.slice(0,kl.length-hf.length);
  const vh=hf.reduce((s,k)=>s+k.volume,0)/Math.max(hf.length,1),ve=ah.reduce((s,k)=>s+k.volume,0)/Math.max(ah.length,1);
  const hi=Math.max(...kl.map(k=>k.high)),lo=Math.min(...kl.map(k=>k.low));
  const c1={met:ve>0&&vh/ve<0.6&&(hi-lo)/lo<0.30};
  const r=rsi(cl,14);const pls=[];
  for(let i=2;i<kl.length-2;i++){if(kl[i].low<kl[i-1].low&&kl[i].low<kl[i-2].low&&kl[i].low<kl[i+1].low&&kl[i].low<kl[i+2].low)if(r[i]!==null)pls.push({low:kl[i].low,rsi:r[i]})}
  let c2={met:false};if(pls.length>=2){const p1=pls[pls.length-2],p2=pls[pls.length-1];c2={met:p2.low<=p1.low&&p2.rsi>p1.rsi}}
  let wc=0;for(const k of kl.slice(-n)){const b=Math.abs(k.close-k.open),w=Math.min(k.open,k.close)-k.low;if(b>0&&w>b*2.5)wc++}const c3={met:wc>=7};
  const lw=Math.min(...kl.map(k=>k.low));let c4={met:false};for(let i=5;i<kl.length-3;i++){if(kl[i].low<lw*0.95){let rc=false,vs=false;for(let j=i+1;j<Math.min(i+4,kl.length);j++){if(kl[j].close>lw)rc=true;if(kl[j].volume>kl.slice(Math.max(0,i-5),i).reduce((s,x)=>s+x.volume,0)/Math.max(i-5,1))vs=true}if(rc&&vs){c4.met=true;break}}}
  const cr=pear(cl.slice(-30),btc.slice(-30).map(k=>k.close));const c5={met:Math.abs(cr)<0.3,corr:cr};
  return [c1,c2,c3,c4,c5];
}

// ═══ 市场分层 ═══
function regime(btc){
  const cl=btc.map(k=>k.close);
  const ma200=cl.length>=200?cl.slice(-200).reduce((s,c)=>s+c,0)/200:cl.reduce((s,c)=>s+c,0)/cl.length;
  const f30=cl.slice(0,30).reduce((s,c)=>s+c,0)/Math.min(30,cl.length);
  const l30=cl.slice(-30).reduce((s,c)=>s+c,0)/30;
  const t30=(l30-f30)/f30;
  if(Math.abs(t30)<0.05)return'sideways';
  return t30>0?'bull':'bear';
}

// ═══ 主流程 ═══
async function main(){
  const now=Date.now();
  const wins=[]; for(let m=1;m<=12;m++){wins.push({id:`W${m}`,ts:now-m*30*86400000,tf:now-(m-1)*30*86400000,tr:now-m*30*86400000-120*86400000})}
  L(`🔬 分层回测: ${wins.length}窗口`);

  const xi=await gj(`${BINANCE}/exchangeInfo`);
  const alts=xi.symbols.filter(s=>s.quoteAsset==='USDT'&&s.status==='TRADING'&&!MAJORS.includes(s.symbol)).map(s=>s.symbol);
  L(`山寨${alts.length}个`);

  const regimeResults={bull:[],bear:[],sideways:[]};
  const factorRegimes={c1:{bull:[],bear:[],sideways:[]},c2:{bull:[],bear:[],sideways:[]},c3:{bull:[],bear:[],sideways:[]},c4:{bull:[],bear:[],sideways:[]},c5:{bull:[],bear:[],sideways:[]}};
  const fNames=['地量横盘','底背离','长下影','震仓','独立走势'];
  const fKeys=['c1','c2','c3','c4','c5'];
  let totalTests=0;

  for(const w of wins){
    let btcA; try{btcA=await gk('BTCUSDT',w.tr,w.tf)}catch(e){continue}; if(btcA.length<30)continue;
    const rg=regime(btcA);
    const res=[]; let d=0;
    for(const sym of alts){
      try{
        const tr=await gk(sym,w.tr,w.tf); if(tr.length<31)continue;
        const fw=await gk(sym,w.tf,Math.min(w.tf+30*86400000,now)); if(fw.length<5)continue;
        const cs=ck(tr,btcA); const mc=cs.filter(c=>c.met).length;
        const ep=tr[tr.length-1].close,xp=fw[fw.length-1].close; const rtn=(xp-ep)/ep;
        const mr=Math.max(...fw.map(k=>k.high)); const mxn=(mr-ep)/ep;
        totalTests++;
        res.push({sym:sym.replace('USDT',''),rtn,mxn,mc,c1:cs[0].met,c2:cs[1].met,c3:cs[2].met,c4:cs[3].met,c5:cs[4].met});
      }catch(e){}
      d++; if(d%3===0)await new Promise(r=>setTimeout(r,10));
    }
    for(const r of res){for(let fi=0;fi<5;fi++){if(r[fKeys[fi]])factorRegimes[fKeys[fi]][rg].push(r);regimeResults[rg].push(r)}}
    if(res.length>30)L(`  ${w.id} [${rg}] ${res.length}条`);
  }

  // ═══ 分层报告 ═══
  L('\n'+'═'.repeat(60));
  L('📊 分层胜率报告 (按市场状态)');
  L('═'.repeat(60));

  for(const [rg,label] of [['bull','🟢 牛市'],['bear','🔴 熊市'],['sideways','⚪ 横盘']]){
    const set=regimeResults[rg]; if(set.length<10)continue;
    const baseW=set.filter(r=>r.rtn>0).length/set.length;
    const baseAvg=set.reduce((s,r)=>s+r.rtn,0)/set.length;
    L(`\n${label}: ${set.length}个测试  基准胜率${(baseW*100).toFixed(1)}%  均收益${(baseAvg*100).toFixed(1)}%`);

    for(let fi=0;fi<5;fi++){
      const fSet=factorRegimes[fKeys[fi]][rg]; if(fSet.length<5)continue;
      const fW=fSet.filter(r=>r.rtn>0).length/fSet.length;
      const fAvg=fSet.reduce((s,r)=>s+r.rtn,0)/fSet.length;
      const adv=fW-baseW;
      L(`  ${fNames[fi]}: ${fSet.length}个 胜率${(fW*100).toFixed(1)}% 优势${(adv*100).toFixed(1)}% 均收益${(fAvg*100).toFixed(1)}%`);
    }

    // 条件组合
    for(let n=2;n<=4;n++){
      const mSet=set.filter(r=>r.mc>=n);
      if(mSet.length<3)continue;
      const mW=mSet.filter(r=>r.rtn>0).length/mSet.length;
      const mAvg=mSet.reduce((s,r)=>s+r.rtn,0)/mSet.length;
      L(`  ≥${n}条件: ${mSet.length}个 胜率${(mW*100).toFixed(1)}% 超额${((mW-baseW)*100).toFixed(1)}%`);
    }
  }

  // ═══ 跨市场因子一致性 ═══
  L('\n'+'═'.repeat(60));
  L('📊 因子跨市场一致性');
  L('═'.repeat(60));

  for(let fi=0;fi<5;fi++){
    const advs=[];
    for(const rg of ['bull','bear','sideways']){
      const fSet=factorRegimes[fKeys[fi]][rg]; if(fSet.length<5)continue;
      const baseW=regimeResults[rg].filter(r=>r.rtn>0).length/regimeResults[rg].length;
      const fW=fSet.filter(r=>r.rtn>0).length/fSet.length;
      advs.push({rg,adv:fW-baseW});
    }
    if(advs.length<2)continue;
    const allPos=advs.every(a=>a.adv>0);
    const allNeg=advs.every(a=>a.adv<0);
    const sign=allPos?'✅ 全正向':allNeg?'❌ 全负向':'⚠ 不一致';
    L(`\n${fNames[fi]}: ${sign}`);
    for(const a of advs)L(`  ${a.rg}: ${(a.adv*100).toFixed(1)}%`);
  }

  L(`\n✅ 分层回测完成 → ${OUT}`);
  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    totalTests,
    regimeCounts: {bull:regimeResults.bull.length,bear:regimeResults.bear.length,sideways:regimeResults.sideways.length},
    factorRegimes: Object.fromEntries(fKeys.map((k,i)=>
      [fNames[i],Object.fromEntries(['bull','bear','sideways'].map(rg=>{
        const s=factorRegimes[k][rg];
        return [rg,{count:s.length,winRate:s.filter(r=>r.rtn>0).length/(s.length||1)}];
      }))]
    )),
  }, null, 2));
}
main().catch(e=>{L('❌ '+e.message); process.exit(1)});
