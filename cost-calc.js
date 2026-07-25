// ─── Vultr 成本估算器 ───
// 根据服务器硬件配置估算每月费用
// Vultr Japan 2026年定价

const os = require('os');

const PLANS = [
  { cpu: 1, ram: 1, disk: 25, price: 6, name: '起步型' },
  { cpu: 1, ram: 2, disk: 40, price: 12, name: '经济型' },
  { cpu: 2, ram: 4, disk: 80, price: 24, name: '标准型' },
  { cpu: 4, ram: 8, disk: 160, price: 48, name: '进阶型' },
  { cpu: 6, ram: 16, disk: 320, price: 96, name: '高性能型' },
  { cpu: 8, ram: 32, disk: 400, price: 160, name: '专业型' },
];

function estimate() {
  const cpu = os.cpus().length;
  const totalRam = Math.round(os.totalmem() / 1024 / 1024 / 1024);
  // 磁盘大小粗略估算（从根分区）
  
  console.log('═══════════════════════════════════');
  console.log('  💰 服务器成本估算');
  console.log('═══════════════════════════════════');
  console.log('');
  console.log('  当前配置:');
  console.log(`  CPU: ${cpu} 核`);
  console.log(`  内存: ${totalRam} GB`);
  console.log(`  地区: 日本 (Vultr)`);
  console.log('');
  console.log('  Vultr 日本机房定价参考:');
  console.log('  ─────────────────────────────────');
  
  let bestMatch = null;
  for (const p of PLANS) {
    const match = cpu >= p.cpu && totalRam >= p.ram;
    const marker = (cpu === p.cpu && totalRam >= p.ram && totalRam < p.ram * 2) ? ' ◀ 最接近' : '';
    if (match && !bestMatch) bestMatch = p;
    console.log(`  ${p.cpu}核/${p.ram}GB/${p.disk}GB  \$${p.price}/月${marker}`);
  }
  
  console.log('');
  if (bestMatch) {
    console.log(`  📌 最匹配套餐: ${bestMatch.name} (\$${bestMatch.price}/月)`);
    console.log(`  📌 预估年费: \$${bestMatch.price * 12}/年`);
  }
  console.log('  ⚠️ 此为估算，实际以 Vultr 账单为准');
  console.log('');
  console.log('  其他月费成本:');
  console.log('  Cloudflare Tunnel: $0/月');
  console.log('  DeepSeek API: 按量（约$0-2/月）');
  console.log('  域名: $0（未购买）');
  console.log('  ─────────────────────────────────');
  const total = (bestMatch ? bestMatch.price : 48) + 1;
  console.log(`  📊 总月费预估: ~\$${total}/月`);
  console.log('═══════════════════════════════════');
}

estimate();
