#!/bin/sh
cd /app/packages/db && bun prisma db push --skip-generate 2>&1 || true
cd /app
exec bun apps/web/server.js
