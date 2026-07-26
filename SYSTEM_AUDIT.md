# System Architecture Audit Final

> 审计时间: 2026-07-26 14:08 UTC  
> 审计范围: 原站 + 量化站 + 所有后台任务  
> 原则: 只审计，不修改

---

## 一、当前架构

```
┌─────────────────────────────────────────────────────────┐
│                     数据源层                              │
│  Binance FAPI · CoinGecko · RSS · Alchemy · Yahoo       │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                     采集层                                │
│  market-data-layer.js (每日01:00)                        │
│  coin-data-layer.js    (每日01:05, 自动增量K线)           │
│  event-analysis-layer  (每日01:10)                       │
│  rss-fetcher.js        (每2分钟)                         │
│  whale-monitor.js      (每10分钟)                        │
│  price-alert.js        (每小时)                          │
│  binance-fetcher.js    (实时)                            │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                     存储层                                │
│  market_data/   (每日快照, 不覆盖)                        │
│  klines_cache/  (528币K线, 增量补全)                     │
│  news/          (覆盖式, RSS+金十)                        │
│  alerts/        (覆盖式)                                  │
│  whale/         (覆盖式)                                  │
│  binance/       (1小时K线, 9个主流币)                     │
│  analysis/      (回测报告+预测记录)                        │
│  wallets/       (钱包监控)                                │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                     API层                                 │
│  server.js:3001    (原站, nginx:8080 反向代理)            │
│  quant-server:3002 (量化站, 独立端口)                     │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│                     前端                                  │
│  public/         (原站 index.html + app.js)               │
│  public-quant/   (量化站, 7个Tab)                         │
│  cloudflared ×2  (两个独立隧道)                           │
└─────────────────────────────────────────────────────────┘
```

---

## 二、进程体系

### 活跃进程

| PID | 进程 | 端口 | 运行 |
|-----|------|------|------|
| 2324960 | server.js (原站) | 3001 | ✅ |
| 2329404 | quant-server.js (量化站) | 3002 | ✅ |
| 26895 | nginx master | 8080 | ✅ |
| 2279482 | cloudflared → 原站 | — | ✅ |
| 2325413 | cloudflared → 量化站 | — | ✅ |
| 2148003 | OpenClaw runtime | — | ✅ |

### 僵尸进程

| 数量 | 进程 | 根因 |
|------|------|------|
| **22** | bd-worker.js | `server.js:197` — crash 后 `fork()` 从不 kill 旧进程 |

**根因分析**：
```javascript
// server.js line 194-197
bdWorker.on('exit', (code) => {
  console.log(`⚠️ bd-worker exited with code ${code}, restarting in 5s...`);
  setTimeout(() => {
    require('child_process').fork(path.join(__dirname, 'bd-worker.js'), [], ...)
    // ⚠️ 旧进程从未 .kill(), 每次crash泄漏一个PID
  }, 5000);
});
```

**解决**: 重启前 `oldWorker.kill()` + 全局 `pgrep bd-worker | xargs kill` 清理

### Cron 任务 (18条)

| 频率 | 任务 | 状态 |
|------|------|------|
| 每1分钟 | binance-fetcher API触发 | ✅ |
| 每2分钟 | rss-fetcher.js | ✅ |
| 每10分钟 | whale-monitor.js | ✅ |
| 每15分钟 | eth-monitor.js | ✅ |
| 每小时 | price-alert.js, snapshot-db.js, auto-git.sh | ✅ |
| 每4小时 | accumulation-scanner.js, accumulation-radar.js | ✅ |
| 每日01:00 | market-data-layer.js | ✅ |
| 每日01:05 | coin-data-layer.js | ✅ |
| 每日01:10 | event-analysis-layer.js | ✅ |
| 每日02:00/14:00 | lifecycle-diagnosis-v2.js | ✅ |
| 每日03:00 | lifecycle-backtest.js | ✅ |
| 每日00:00 | logrotate | ✅ |
| @reboot | restart.sh, supervisor.sh | ✅ |

### 重启/保活机制

| 机制 | 范围 | 说明 |
|------|------|------|
| restart.sh | server.js | 文件修改检测 + 自动重启 |
| supervisor.sh | 采集器+服务+隧道 | 全局保活 |
| server.js crash恢复 | bd-worker | 有问题(泄漏) |
| @reboot cron | 全站 | 开机自启 |

---

## 三、数据链路

### BTC 价格链路 ✅

```
Binance FAPI /ticker/24hr
  ↓ [market-data-layer.js, 每日01:00]
public/data/market_data/latest.json (快照)
  ↓ [quant-server.js /api/market]
BTC price → 前端展示
  ↓
延迟: ~11分钟 (手动触发) / ~数小时 (cron触发)
```

### K线数据链路 ✅

```
Binance FAPI /klines (400日线)
  ↓ [coin-data-layer.js, 每日01:05 + 自动增量]
public/data/klines_cache/ (528币)
  ↓ [quant-server.js /api/scan]
200币扫描结果 → 前端强势/弱势表
  ↓
覆盖率: 200/528 (37%), 每天自动补50个
```

### 新闻链路 ⚠️

```
RSS源 + 金十
  ↓ [rss-fetcher.js, 每2分钟]
public/data/news/jin10.json (覆盖式)
  ↓ [quant-server.js /api/news]
新闻列表 → 前端展示
  ↓
问题: ZIP恢复后cron中断, 停更22小时
状态: 已修复, cron正常运行中
```

### 异动链路 ⚠️

```
Binance FAPI 实时价格
  ↓ [price-alert.js, 每小时]
public/data/alerts/price_alerts.json (覆盖式)
  ↓ [quant-server.js /api/alerts]
异动列表 → 前端展示
  ↓
问题: 同上, cron中断后已修复
```

### 鲸鱼链路 ✅

```
Alchemy API (ETH链)
  ↓ [whale-monitor.js, 每10分钟]
public/data/whale/transfers.json (覆盖式)
  ↓ 
状态: 正常, 最后更新3分钟前
```

---

## 四、外部依赖

| API | 超时 | 重试 | 限频 | 错误日志 | 报警 |
|-----|------|------|------|---------|------|
| Binance FAPI | 10-15s | ✅ 2次 + fallback现货 | 100ms间隔 | ✅ /tmp/*.log | ❌ |
| CoinGecko | 15s | ❌ | 30次/分钟 | ❌ 静默失败 | ❌ |
| RSS | 默认 | ❌ | — | ❌ | ❌ |
| Alchemy | 15s | ❌ | — | ❌ | ❌ |
| Yahoo Finance | 8s | ❌ | — | ❌ | ❌ |
| BscScan | 默认 | ❌ | 5次/秒 | ❌ | ❌ |
| DeepSeek AI | 30s | ✅ 2次 | — | ❌ | ❌ |

---

## 五、存储检查

| 目录 | 大小 | 增长模式 | 覆盖历史 | 可回放 |
|------|------|---------|---------|--------|
| klines_cache | 11MB | 线性(528×400根K线) | ❌ 全量覆盖 | ✅ |
| market_data | <1MB | 每日+2KB | ❌ 按日期 ✅ | ✅ |
| news | 380KB | 线性 | ❌ 覆盖式 | ❌ |
| alerts | <100KB | 线性 | ❌ 覆盖式 | ❌ |
| whale | <100KB | 覆盖式 | ❌ | ❌ |
| binance | 864KB | 按日期存储 | ✅ | ✅ |
| analysis | 大 | 线性(JSON累积) | ❌ 覆盖式 | ⚠️ |
| /tmp/*.log | ~3MB | 线性 | logrotate控制 | — |
| 磁盘总量 | 17G/360G(5%) | 安全 | — | — |

---

## 六、监控能力

| 事件 | 感知 | 报警 | 自动恢复 |
|------|------|------|---------|
| Binance API 挂 | ❌ | ❌ | ✅ fallback |
| CoinGecko 挂 | ❌ | ❌ | ❌ |
| RSS 中断 | ❌ | ❌ | ❌ |
| cron 停止 | ❌ | ❌ | ❌ |
| 磁盘满 | ❌ | ❌ | — |
| 僵尸进程 | ❌ | ❌ | ❌ |
| server crash | ⚠️ restart.sh | ❌ | ✅ 自动 |
| 隧道断 | ❌ | ❌ | ❌ |

**结论: 无任何监控和报警。任何组件挂了都不会知道。**

---

## 七、风险评估

### P0 — 立即修复

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 1 | 22个bd-worker僵尸进程 | 继续crash会耗尽PID | 清理进程 + 修复server.js |
| 2 | 无监控 | 任何故障无感知 | 加healthcheck脚本 |
| 3 | 新闻/异动cron脆弱 | 已断22小时 | cron加有效性检查 |

### P1 — 本周

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 4 | /tmp日志线性增长 | 长期可能占满 | 确认logrotate配置 |
| 5 | API无统一错误处理 | CoinGecko挂掉静默失败 | 加异常捕获+降级标记 |
| 6 | 新闻/异动覆盖式存储 | 无历史可追溯 | 改按日期存储 |

### P2 — 后续优化

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 7 | bd-worker缺乏单实例保护 | 不影响功能但泄漏 | accept_mutex或pidfile |
| 8 | restart.sh检测是基于文件时间 | 可能漏检 | 加进程状态检测 |
