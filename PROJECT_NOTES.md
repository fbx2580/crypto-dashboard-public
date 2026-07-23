# Crypto Dashboard 项目文档

## 📊 大看板

### 大盘行情
- [x] BTC 实时价格 + 24h涨跌幅
- [x] A 股指数（上证/深证/创业板/沪深300）
- [x] 纳斯达克 / S&P 500
- [x] 恐惧贪婪指数
- [x] 山寨季/比特季指数

### 主流币排行
- [x] 主流币按涨跌幅排序（BTC/ETH/SOL/BNB/XRP/DOGE/ADA/AVAX/DOT/LINK）
- [ ] 存储/美股板块（完善名称映射 + B 后缀适配）
- [ ] 板块轮动热力图
- [ ] 可选更多主流币

### 巨鲸转账
- [x] BTC 转账监控（blockchain.info）
- [x] USDT/USDC 转账监控（Etherscan V2）
- [x] ETH 原生转账监控（Etherscan proxy）
- [x] 500 条 FIFO 滚动
- [x] 交易所识别
- [ ] SOL/BNB 链转账监控
- [ ] 大额转账推送通知

### DeFi 收益率排行
- [x] DefiLlama 全链收益排行
- [x] 项目筛选（Uniswap V3/V4、PancakeSwap）
- [ ] 按链筛选
- [ ] 单项目数据不全（需确认分页）
- [ ] 历史 APY 走势图

---

## 💪 币圈强信号

### 鲸鱼钱包监控
#### 第一阶段：建立基础地址库
- [ ] 从 Etherscan/BscScan Top Holders 采集前 50 个非交易所/非合约/非黑洞地址
- [ ] 注册 Whale Alert，记录近 7 天 >$100 万转账地址
- [ ] DexScreener 异动监控钩子：大额买入地址标记为"潜在聪明钱"

#### 第二阶段：地址标签系统
- [ ] 集成公开交易所地址标签库
- [ ] 行为标签：高频交易者、钻石手、精准抄底、对敲嫌疑
- [ ] 标签自动更新机制（每周）

#### 第三阶段：信号输出
- [ ] 精准抄底地址批量提币 → 高置信吸筹信号
- [ ] 钻石手首次向交易所转入 → 潜在派发信号
- [ ] 关联地址频繁互转 → 对敲警告

### 巨鲸转账
- [x] 显示 BTC/ETH/USDT/USDC 转账
- [ ] 智能筛选（高价值/对敲/集中提币）
- [ ] 历史搜索

---

## 📰 消息面

- [x] 金十快讯（实时财经资讯）
- [x] 墙外新闻（RSS 聚合 + 展开收起）
- [ ] 新闻分类（宏观/政策/行业）
- [ ] 关键词提醒
- [ ] 重要新闻推送

---

## ⚙️ 后端/系统

### 数据源
- [x] 币安现货行情
- [x] 币安合约行情（备用）
- [x] Etherscan V2（USDT/USDC/ETH）
- [x] DefiLlama（DeFi 收益）
- [x] Jin10（金十快讯）
- [x] RSS（加密新闻）
- [x] CoinGecko（恐惧贪婪）
- [x] Yahoo Finance（美股）

### 采集器
- [x] binance-fetcher（30 秒轮询）
- [x] whale-monitor（4 秒轮询）
- [x] wallet-monitor（120 秒轮询）
- [x] jin10-scraper
- [x] rss-fetcher
- [ ] 采集器健康监控面板
- [ ] 采集器宕机自动重启

### API
- [x] /api/market/overview
- [x] /api/market/indicators
- [x] /api/binance/signals
- [x] /api/whale/transfers
- [x] /api/wallets
- [x] /api/defi/llama
- [x] /api/health
- [ ] WebSocket 支持（替代轮询）

### 部署
- [x] Express @ 3001
- [x] Nginx 反代 @ 8080
- [x] Cloudflare Tunnel
- [x] Git 版本控制（私有 + 公开）

---

## 🐛 已知问题

- [ ] K 线图模块已删除但代码未彻底清理
- [ ] 钱包监控余额偶尔为 0（RPC 限流）
- [ ] PC 端大屏布局待优化
- [ ] 前端代码未模块化（单文件 app.js 过大）
- [ ] 无 git 自动备份机制（目前手动提交）
- [ ] 无日志轮转（server.log 等无限增长）

---

## 📈 未来规划

- [ ] 手机端 PWA 支持
- [ ] WebSocket 替代 HTTP 轮询
- [ ] 交易所 API 自动切换（币安被封时转 Gate/OKX）
- [ ] 条件警报（价格/链上/新闻触发）
- [ ] 历史数据回放
- [ ] 多语言支持

