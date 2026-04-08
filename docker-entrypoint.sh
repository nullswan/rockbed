#!/bin/sh
# Run prisma db push on boot (creates/migrates tables)
PRISMA_CLI=$(find /app/node_modules/.bun/prisma@*/node_modules/prisma/build/index.js -maxdepth 0 2>/dev/null | head -1)
if [ -n "$PRISMA_CLI" ]; then
  cd /app/packages/db && bun "$PRISMA_CLI" db push --skip-generate 2>&1 || true
fi

# Ensure analytics tables exist (prisma db push may fail due to missing deps)
DB_PATH="${DATABASE_URL#file:}"
if [ -f "$DB_PATH" ]; then
  bun -e "
    const Database = require('bun:sqlite');
    const db = new Database('$DB_PATH');
    db.run(\`CREATE TABLE IF NOT EXISTS AnalyticsAgg (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      userKey TEXT NOT NULL,
      modelKey TEXT NOT NULL,
      region TEXT NOT NULL DEFAULT 'us-east-1',
      totalIn INTEGER NOT NULL DEFAULT 0,
      totalOut INTEGER NOT NULL DEFAULT 0,
      cacheRead INTEGER NOT NULL DEFAULT 0,
      cacheWrite INTEGER NOT NULL DEFAULT 0,
      invocations INTEGER NOT NULL DEFAULT 0
    )\`);
    db.run(\`CREATE UNIQUE INDEX IF NOT EXISTS AnalyticsAgg_day_userKey_modelKey_region_key ON AnalyticsAgg(day, userKey, modelKey, region)\`);
    db.run(\`CREATE INDEX IF NOT EXISTS AnalyticsAgg_day_idx ON AnalyticsAgg(day)\`);
    db.run(\`CREATE INDEX IF NOT EXISTS AnalyticsAgg_region_idx ON AnalyticsAgg(region)\`);
    db.run(\`CREATE TABLE IF NOT EXISTS AnalyticsSyncState (
      region TEXT PRIMARY KEY NOT NULL,
      lastSyncAt DATETIME NOT NULL
    )\`);
    console.log('[entrypoint] Analytics tables ensured');
  " 2>&1 || echo "[entrypoint] Warning: could not ensure analytics tables"
fi

cd /app
exec bun apps/web/server.js
