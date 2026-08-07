#!/bin/bash
# ─── 数据库备份 v2：Node.js dump + gzip ───
# 每天 03:00 UTC（北京 11:00）执行，保留 7 天
BACKUP_DIR="/root/backups/db"
DATE=$(date +%Y%m%d)
mkdir -p "$BACKUP_DIR"

cd /root/.openclaw/workspace/crypto-dashboard

for db in data/dashboard.db public/data/data.db public/data/snapshots.db public/data/radar_tracking.db; do
    if [ -f "$db" ]; then
        name=$(basename "$db" .db)
        echo "[backup] dumping $db..."
        node -e "
            const db = require('better-sqlite3')('$db', {readonly:true});
            const fs = require('fs');
            const zlib = require('zlib');
            const out = fs.createWriteStream('$BACKUP_DIR/${name}_${DATE}.sql.gz');
            const gzip = zlib.createGzip();
            gzip.pipe(out);
            for (const row of db.prepare(\"SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name\").all()) {
                gzip.write(row.sql + ';\\n');
            }
            const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").all();
            for (const t of tables) {
                gzip.write('.mode insert ' + t.name + '\\n');
                const cols = db.prepare('SELECT * FROM [' + t.name + '] LIMIT 1').columns().map(c => c.name);
                const rows = db.prepare('SELECT * FROM [' + t.name + ']').all();
                for (const r of rows) {
                    const vals = cols.map(c => {
                        const v = r[c];
                        if (v === null) return 'NULL';
                        if (typeof v === 'number') return String(v);
                        return \"'\" + String(v).replace(/'/g, \"''\") + \"'\";
                    }).join(',');
                    gzip.write('INSERT INTO [' + t.name + '] VALUES(' + vals + ');\\n');
                }
            }
            gzip.end();
            return new Promise(resolve => out.on('finish', resolve));
        " && echo "[backup] OK $(du -h $BACKUP_DIR/${name}_${DATE}.sql.gz | cut -f1)" || echo "[backup] FAIL $db"
    fi
done
find "$BACKUP_DIR" -name '*.sql.gz' -mtime +7 -delete
echo "[backup] done $(date)"
