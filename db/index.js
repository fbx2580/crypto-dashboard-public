// ─── 数据库层 ───
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'dashboard.db');
const DATA_DIR = path.join(__dirname, '..', 'data');

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ─── 建表 ───
db.exec(`
  CREATE TABLE IF NOT EXISTS whale_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    value REAL NOT NULL,
    hash TEXT UNIQUE NOT NULL,
    ts INTEGER NOT NULL,
    from_addr TEXT,
    to_addr TEXT,
    ex_from TEXT,
    ex_to TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    title TEXT,
    content TEXT,
    url TEXT UNIQUE,
    ts INTEGER NOT NULL,
    lang TEXT DEFAULT 'zh',
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT,
    data TEXT,
    ts INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS addresses (
    address TEXT PRIMARY KEY,
    chain TEXT NOT NULL DEFAULT 'BTC',
    tags TEXT DEFAULT '[]',
    behavior TEXT DEFAULT '中性',
    balance REAL DEFAULT 0,
    last_seen INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS addr_tx_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL,
    hash TEXT NOT NULL,
    ts INTEGER NOT NULL,
    net_val REAL NOT NULL,
    is_send INTEGER DEFAULT 0,
    is_receive INTEGER DEFAULT 0,
    FOREIGN KEY (address) REFERENCES addresses(address)
  );

  CREATE INDEX IF NOT EXISTS idx_whale_ts ON whale_transfers(ts);
  CREATE INDEX IF NOT EXISTS idx_whale_chain ON whale_transfers(chain);
  CREATE INDEX IF NOT EXISTS idx_news_ts ON news(ts);
  CREATE INDEX IF NOT EXISTS idx_addr_ts ON addr_tx_history(ts);
`);

module.exports = db;
