#!/bin/sh
# Run prisma db push on boot (creates/migrates tables)
PRISMA_CLI=$(find /app/node_modules/.bun/prisma@*/node_modules/prisma/build/index.js -maxdepth 0 2>/dev/null | head -1)
if [ -n "$PRISMA_CLI" ]; then
  cd /app/packages/db && bun "$PRISMA_CLI" db push --skip-generate 2>&1 || true
fi
cd /app
exec bun apps/web/server.js
