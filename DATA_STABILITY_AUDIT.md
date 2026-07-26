# DATA STABILITY AUDIT

> 审计时间: 2026-07-26 15:15 UTC  
> 原则: 只评估, 不修改

---

## 一、数据资产清单

| 数据 | 来源 | 脚本 | 存储 | 理论频率 | 状态 |
|------|------|------|------|---------|------|
| Binance 行情 | Binance FAPI | cron API触发 | binance/ | 1分钟 | ⚠️ 最后 7/24 |
| CoinGecko | CoinGecko API | market-data-layer.js | market_data/ | 每日 01:00 | ✅ |
| K线缓存 | Binance FAPI | coin-data-layer.js | klines_cache/ | 每日+增量 | ✅ 200/528 |
| 新闻 RSS | RSS 聚合源 | rss-fetcher.js → rt-daemon | news/latest.json | 1秒 | ✅ |
| 金十快讯 | jin10.com | jin10-scraper.js | news/jin10.json | 1秒 | ✅ 497条 |
| 巨鲸监控 | Alchemy API | whale-monitor.js → rt-daemon | whale/ | 1秒 | ✅ |
| ETH 追踪 | Alchemy API | eth-monitor.js → rt-daemon | analysis/ | 1秒 | ✅ |
| 异动监控 | Binance FAPI | price-alert.js → rt-daemon | alerts/ | 1秒 | ✅ |
| 市场快照 | Binance+CG | market-data-layer.js | market_data/ | 每日 | ⚠️ 13:50更新 |
| 数据质量 | 综合 | data-quality-monitor.js | market_data/ | 5分钟 | ✅ 97% |
| 断层检测 | 综合 | gap-checker.js | — | 12小时 | ✅ |

---

## 二、实时性

| 数据 | 理论 | 实际频率 | 延迟 | 评级 |
|------|------|---------|------|------|
| 新闻 RSS | 1秒 | 1秒 | ~2秒 | A |
| 金十快讯 | 1秒 | 1秒 | ~3秒(Chromium) | A |
| 巨鲸 | 1秒 | 1秒 | ~2秒 | A |
| ETH 追踪 | 1秒 | 1秒 | ~2秒 | A |
| 异动 | 1秒 | 1秒 | ~2秒 | A |
| 数据质量 | 5分钟 | 5分钟 | 实时 | A |
| 市场快照 | 每日 | 每日 | 数小时 | C |
| K线缓存 | 每日 | 每日 | 数小时 | C |
| Binance行情 | 1分钟 | 1分钟 | 滞后2天 | D |

评级: A=正常延迟, C=影响决策, D=不可用

---

## 三、数据源健康

| 数据源 | 状态 | 延迟 | 限流风险 | 备用 |
|--------|------|------|---------|------|
| Binance FAPI | ✅ | 56ms | 低(1200/min) | WARP代理 |
| CoinGecko | ✅ | 254ms | 中(30/min) | 无 |
| WARP 代理 | ✅ | — | — | — |
| Alchemy | ✅ | — | 低 | WARP代理 |

无 429、无超时。WARP 代理已配置可用。

---

## 四、采集任务

| 任务 | 进程 | 状态 | 自动恢复 | 日志 |
|------|------|------|---------|------|
| rt-daemon (RSS/鲸鱼/ETH/异动) | 2个进程 | ✅ 运行 | ⚠️ 无守护 | /tmp/rt.log |
| jin10-scraper (金十) | 1个进程 | ✅ 运行 | ⚠️ 无守护 | /tmp/jin10.log |
| data-quality-monitor | cron/5分钟 | ✅ | — | /tmp/quality.log |
| gap-checker | cron/12小时 | ✅ | — | /tmp/gap-checker.log |
| market-data-layer | cron/01:00 | ⚠️ 仅手动触发 | — | — |
| coin-data-layer | cron/01:05 | ⚠️ 仅手动触发 | — | — |

**问题**: rt-daemon 和 jin10 没有守护进程。如果 crash，不会自动重启。

---

## 五、数据完整性

| 数据 | 字段缺失 | NaN | 时间戳异常 | 历史丢失 |
|------|---------|-----|----------|---------|
| BTC | ✅ 无 | ✅ 无 | ✅ | ❌ 覆盖式 |
| K线 | ✅ 无 | ✅ 无 | ✅ | ❌ 覆盖式 |
| 新闻 RSS | ✅ 无 | ✅ 无 | ✅ | ❌ 覆盖式 |
| 金十快讯 | ✅ 无 | ✅ 无 | ✅ | ✅ 合并式 |
| 巨鲸 | ✅ 无 | ✅ 无 | ⚠️ 旧数据 epoch | ❌ 覆盖式 |
| 异动 | ✅ 无 | ✅ 无 | ✅ | ❌ 覆盖式 |

**问题**: 多个数据源是覆盖式存储，历史数据不可回放。金十是唯一合并式的。

---

## 六、失败恢复能力

| 场景 | 能感知 | 感知速度 | 自动恢复 | 备用 | 可补数据 |
|------|--------|---------|---------|------|---------|
| Binance 挂 | ⚠️ data-quality | 5分钟 | ❌ | WARP代理 | ✅ |
| 新闻源挂 | ⚠️ data-quality | 5分钟 | ❌ | 无 | ❌ |
| RSS 挂 | ⚠️ data-quality | 5分钟 | ❌ | 无 | ❌ |
| 巨鲸 API 挂 | ⚠️ data-quality | 5分钟 | ❌ | WARP代理 | ❌ |
| jin10 挂 | ⚠️ gap-checker | 12小时 | ❌ | 无 | ❌ |
| rt-daemon crash | ❌ 不知 | — | ❌ | 无 | — |

**最大风险**: rt-daemon/jin10 crash 后没有自动重启。data-quality 能 5 分钟内感知数据断流，但不能恢复。

---

## 七、数据稳定性评分

| 维度 | 分数 | 说明 |
|------|------|------|
| 实时性 | **85/100** | 核心数据源 1秒, 市场/Binance 滞后 |
| 完整性 | **70/100** | 字段齐全, 但多覆盖式存储 |
| 可靠性 | **55/100** | daemon 无守护, 无自动恢复 |
| 可恢复性 | **30/100** | 数据断档无法回补(除金十) |
| 监控能力 | **60/100** | data-quality 5分钟, 但无告警 |

**综合: 60/100**

---

## 八、TOP10 风险

| # | 风险 | 严重度 | 
|---|------|--------|
| 1 | rt-daemon crash 无自动重启 | 🔴 高 |
| 2 | jin10 crash 无自动重启 | 🔴 高 |
| 3 | 覆盖式存储不可回放 | 🟡 中 |
| 4 | 市场快照仅每日更新 | 🟡 中 |
| 5 | 无告警通知 | 🟡 中 |
| 6 | 新闻断档无法回补 | 🟡 中 |
| 7 | Binance 行情滞后 | 🟢 低 |
| 8 | 巨鲸旧数据时间戳异常 | 🟢 低 |
| 9 | 数据质量无趋势分析 | 🟢 低 |
| 10 | gap-checker 12小时间隔太疏 | 🟢 低 |

## 九、优先修复

1. **P0**: supervisor守护 rt-daemon + jin10 (保活)
2. **P1**: 告警通知 (data-quality异常 → 日志标记)
3. **P2**: 关键数据改追加式存储(金十已做, 推及其他)
4. **P3**: 市场快照频率提升

## 十、不建议动

- ❌ 数据采集逻辑 — 当前稳定
- ❌ 1秒实时频率 — P0 已标注
- ❌ K线增量缓存 — 自动工作
- ❌ 原站业务逻辑
