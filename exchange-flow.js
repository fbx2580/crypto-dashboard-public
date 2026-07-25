#!/usr/bin/env node
/** 
 * 交易所净流出检测 v2 — BSC链 (BscScan)
 * 476个≥2条件BSC代币 → 查Binance BSC热钱包净流出
 */
const axios = require('axios'); const fs = require('fs'); const path = require('path');

const BSC_KEY = 'NB66FT4WSZNCUGR4YPQ9WE47GC37256GZF';
const BSC_API = 'https://api.bscscan.com/api';
const CG = 'https://api.coingecko.com/api/v3';
const OUT = path.join(__dirname, 'public', 'data', 'analysis', 'exchange_flow_bsc.json');

// Binance BSC热钱包 (公开)
const BINANCE_BSC = [
  '0x631Fc1EA2270e98fbD9D92658eCe0F5a269Aa161',
  '0x8894E0a0c962CB723c1976a4421c95949bE2D4E3',
  '0xE2fc31F816A9b94326492132018C3aEcC4a93aE1',
];

async function gj(u){return(await axios.get(u,{timeout:15000})).data}
async function bs(params){
  params.apikey = BSC_KEY;
  try {
    const r = await axios.get(BSC_API, {params, timeout:15000});
    return r.data.status==='1' ? r.data.result : [];
  } catch(e) { return []; }
}
function L(m){console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`)}

async function main(){
  // 1. BSC合约地址映射 (CoinGecko)
  L('拉BSC合约地址…');
  const cgL = await gj(`${CG}/coins/list?include_platform=true`);
  const symToBsc = {};
  for(const c of cgL||[]){
    const bsc = (c.platforms||{})['binance-smart-chain'];
    if(bsc && c.symbol){ const s=c.symbol.toUpperCase(); if(!symToBsc[s]) symToBsc[s]=bsc; }
  }
  L(`${Object.keys(symToBsc).length}个BSC映射`);

  // 2. 读取≥2条件币
  const sf = path.join(__dirname,'public','data','analysis','accumulation_signals.json');
  const sigs = JSON.parse(fs.readFileSync(sf,'utf8')).signals.filter(s=>s.metCount>=2);
  L(`${sigs.length}个≥2条件币`);

  // 3. 匹配BSC合约
  const targets = [];
  for(const s of sigs){
    const bsc = symToBsc[s.symbol];
    if(bsc) targets.push({sym:s.symbol, bsc, score:s.score, mc:s.metCount, entry:s.entryStatus, type:s.accType});
  }
  L(`${targets.length}个BSC币种`);

  // 4. 查转账 (最近7天)
  const wk = Math.floor(Date.now()/1000)-7*86400;
  const res = []; let calls=0;
  const bWallets = BINANCE_BSC.map(a=>a.toLowerCase());

  for(let i=0;i<targets.length;i++){
    const t=targets[i]; let ti=0,to=0;
    for(const w of BINANCE_BSC){
      try {
        const txs=await bs({module:'account',action:'tokentx',contractaddress:t.bsc,address:w,startblock:0,endblock:99999999,page:1,offset:1000,sort:'desc'});
        calls++; if(calls%5===0)await new Promise(r=>setTimeout(r,1000));
        for(const tx of txs){
          if(parseInt(tx.timeStamp)<wk)continue;
          const v=parseFloat(tx.value)/Math.pow(10,parseInt(tx.tokenDecimal||18));
          if(bWallets.includes(tx.from.toLowerCase()))to+=v;
          if(bWallets.includes(tx.to.toLowerCase()))ti+=v;
        }
      }catch(e){}
    }
    const nf=to-ti, ratio=(ti+to)>0?to/(ti+to):0.5;
    let sig='neutral'; if(nf>0&&ratio>0.6)sig='outflow';else if(nf>0)sig='weak';else if(nf<0)sig='inflow';
    res.push({sym:t.sym,score:t.score,mc:t.mc,entry:t.entry,type:t.type,netFlow:nf,ratio,signal:sig,ti,to});
    if((i+1)%20===0)L(`  ${i+1}/${targets.length} → ${res.filter(r=>r.signal==='outflow').length}流出`);
  }

  // 5. 统计
  const out=res.filter(r=>r.signal==='outflow'), wkO=res.filter(r=>r.signal==='weak'), inF=res.filter(r=>r.signal==='inflow');
  L(`\n═══ BSC净流出 ═══`);
  L(`明确流出: ${out.length}/${res.length} (${(out.length/res.length*100).toFixed(0)}%)`);
  L(`轻微流出: ${wkO.length}  净流入: ${inF.length}`);

  if(out.length>0){
    L('\n净流出TOP10:');
    for(const r of[...out,...wkO].sort((a,b)=>b.netFlow-a.netFlow).slice(0,10))
      L(`  ${r.sym.padEnd(12)} 出${r.to.toFixed(0)} 入${r.ti.toFixed(0)} 净+${r.netFlow.toFixed(2)}`);
  }

  // ≥3条件交叉验证
  const m3 = res.filter(r=>r.mc>=3);
  const m3out = m3.filter(r=>r.signal==='outflow'||r.signal==='weak');
  L(`\n═══ ≥3条件交叉验证 ═══`);
  L(`≥3条件中有BSC数据: ${m3.length}个`);
  L(`其中净流出: ${m3out.length}个 → 吸筹确认率 ${(m3out.length/m3.length*100).toFixed(0)}%`);

  const outFile = {...JSON.parse(fs.readFileSync(sf,'utf8'))};
  // 把flow数据回写到信号文件
  for(const s of outFile.signals){
    const f = res.find(r=>r.sym===s.symbol);
    if(f && f.signal==='outflow') s.flowConfirmed = true;
  }
  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT, JSON.stringify({scannedAt:new Date().toISOString(),totalChecked:res.length,outflow:out.length,weak:wkO.length,results:res},null,2));
  L(`\n✅ 保存`);
}
main().catch(e=>{L('❌ '+e.message); process.exit(1)});
