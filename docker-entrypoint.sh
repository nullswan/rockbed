#!/bin/sh
bun /app/packages/db/src/migrate.ts
exec bun apps/web/server.js
