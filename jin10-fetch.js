#!/usr/bin/env node
const axios=require('axios');const fs=require('fs');
(async()=>{
const r=await axios.get('https://www.jin10.com',{timeout:10000,headers:{'User-Agent':'Mozilla/5.0'}});
const t=r.data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
const re=/(\d{2}:\d{2}:\d{2})\s+([\s\S]*?)(?=\d{2}:\d{2}:\d{2}|$)/g;
let m;const items=[];
while((m=re.exec(t))!==null&&items.length<50){const h=m[1].slice(0,5);const s=m[2].trim().slice(0,300);if(s.length>5&&!/TradingHero|金十数据·|VIP年会员|高定礼盒|PLUS|解锁|专属文章|期货盯盘|财经数据|今日重点|周[一二三四五六日]/.test(s))items.push({t:h,s,src:'jin10'})}
const bj=(new Date().getUTCHours()+8)%24;const sk=i=>{let h=parseInt(i.t),m=parseInt(i.t.split(':')[1]||0);if(bj<12&&h>=23)h-=24;return h*60+m};
let o=[];try{o=JSON.parse(fs.readFileSync(__dirname+'/public/data/news/jin10.json','utf8')).items||[]}catch(e){}
const sn=new Set(items.map(i=>i.s));for(const i of o){if(!sn.has(i.s)){items.unshift(i);sn.add(i.s)}}
items.sort((a,b)=>sk(b)-sk(a));
fs.writeFileSync(__dirname+'/public/data/news/jin10.json',JSON.stringify({items:items.slice(0,500),updated:Date.now()},null,2));
try{const db=require('better-sqlite3')(__dirname+'/data/dashboard.db');const ins=db.prepare('INSERT OR IGNORE INTO news_archive (source,title,content,url,ts) VALUES (?,?,?,?,?)');const tx=db.transaction(l=>{for(const i of l)ins.run('jin10',i.s.slice(0,200),'','',Math.floor(Date.now()/1000))});tx(items)}catch(e){}
console.log(new Date().toISOString().slice(11,19),items.length,items[0]?.t,items[0]?.s?.slice(0,30));
})();
