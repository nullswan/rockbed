import { prisma } from "@rockbed/db";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { runInsightsQuery, LOG_GROUP } from "./cloudwatch";

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// In-flight sync guard — prevents concurrent syncs
let syncInFlight = false;

const cleanUser = (arn: string) => {
  const m = arn.match(/user\/bedrock-key-(.+)$/);
  if (m) return m[1];
  if (arn.includes(":root")) return "root";
  const userMatch = arn.match(/user\/(.+)$/);
  return userMatch ? userMatch[1] : arn;
};

const cleanModel = (key: string) =>
  key
    .replace(/^arn:aws:bedrock:[^:]+:\d+:inference-profile\//, "")
    .replace(/^us\./, "")
    .replace(/^anthropic\./, "")
    .replace(/^amazon\./, "")
    .replace(/^meta\./, "");

/**
 * Incrementally sync CloudWatch analytics into SQLite.
 * Only queries data since the last sync (or from the start of the month on first run).
 */
export async function syncAnalytics(region: string = "us-east-1"): Promise<void> {
  if (syncInFlight) return;
  syncInFlight = true;

  try {
    const cwl = new CloudWatchLogsClient({ region });
    const now = new Date();

    // Get last sync time, or default to start of current month
    const syncState = await prisma.analyticsSyncState.findUnique({
      where: { region },
    });

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    // On first sync, query from start of month. On subsequent syncs, overlap by 5 min
    // to catch any late-arriving log entries.
    const lastSync = syncState
      ? new Date(syncState.lastSyncAt.getTime() - 5 * 60 * 1000)
      : monthStart;

    const query = `
      fields input.inputTokenCount as inTok, output.outputTokenCount as outTok,
             coalesce(input.cacheReadInputTokenCount, 0) as cacheReadTok,
             coalesce(input.cacheWriteInputTokenCount, 0) as cacheWriteTok,
             modelId, identity.arn as userArn
      | stats sum(inTok) as totalIn, sum(outTok) as totalOut,
              sum(cacheReadTok) as cacheRead, sum(cacheWriteTok) as cacheWrite,
              count(*) as invocations
        by bin(1d) as day, modelId, identity.arn
      | sort day asc
    `;

    const results = await runInsightsQuery(cwl, query, lastSync, now);

    if (results.length === 0) {
      // Nothing new — still update sync timestamp
      await prisma.analyticsSyncState.upsert({
        where: { region },
        update: { lastSyncAt: now },
        create: { region, lastSyncAt: now },
      });
      return;
    }

    // Upsert results into SQLite
    for (const r of results) {
      const dayStr = r.day?.split(" ")[0]; // "2026-04-07 00:00:00.000" → "2026-04-07"
      if (!dayStr || !r.modelId) continue;

      const userKey = cleanUser(r["identity.arn"] ?? r.userArn ?? "unknown");
      const modelKey = cleanModel(r.modelId);
      const totalIn = BigInt(r.totalIn ?? "0");
      const totalOut = BigInt(r.totalOut ?? "0");
      const cacheRead = BigInt(r.cacheRead ?? "0");
      const cacheWrite = BigInt(r.cacheWrite ?? "0");
      const invocations = parseInt(r.invocations ?? "0");

      await prisma.analyticsAgg.upsert({
        where: {
          day_userKey_modelKey_region: {
            day: dayStr,
            userKey,
            modelKey,
            region,
          },
        },
        update: { totalIn, totalOut, cacheRead, cacheWrite, invocations },
        create: {
          day: dayStr,
          userKey,
          modelKey,
          region,
          totalIn,
          totalOut,
          cacheRead,
          cacheWrite,
          invocations,
        },
      });
    }

    await prisma.analyticsSyncState.upsert({
      where: { region },
      update: { lastSyncAt: now },
      create: { region, lastSyncAt: now },
    });
  } finally {
    syncInFlight = false;
  }
}

/**
 * Check if sync is needed (stale by SYNC_INTERVAL_MS) and trigger in background.
 * Returns immediately — does not block the caller.
 */
export async function ensureSyncFresh(region: string = "us-east-1"): Promise<void> {
  const syncState = await prisma.analyticsSyncState.findUnique({
    where: { region },
  });

  const isStale =
    !syncState ||
    Date.now() - syncState.lastSyncAt.getTime() > SYNC_INTERVAL_MS;

  if (isStale) {
    // Fire and forget — don't block the API response
    syncAnalytics(region).catch((err) =>
      console.error("[analytics-sync]", err)
    );
  }
}
