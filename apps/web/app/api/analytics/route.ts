import { auth } from "@/lib/auth";
import { ensureSyncFresh } from "@/lib/analytics-sync";
import { prisma } from "@rockbed/db";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  IAMClient,
  ListUsersCommand,
  ListUserTagsCommand,
} from "@aws-sdk/client-iam";

// Cache IAM email lookups for 10 min
let iamCache: { data: Map<string, string>; expiry: number } | null = null;

async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

async function getUserEmailMap(region: string): Promise<Map<string, string>> {
  if (iamCache && Date.now() < iamCache.expiry) return iamCache.data;

  const map = new Map<string, string>();
  try {
    const iam = new IAMClient({ region });
    const usersRes = await iam.send(new ListUsersCommand({ PathPrefix: "/" }));
    const bedrockUsers = (usersRes.Users ?? []).filter((u) =>
      u.UserName?.startsWith("bedrock-key-")
    );
    await Promise.all(
      bedrockUsers.map(async (u) => {
        try {
          const tags = await iam.send(new ListUserTagsCommand({ UserName: u.UserName! }));
          const createdBy = tags.Tags?.find((t) => t.Key === "rockbed:createdBy")?.Value;
          if (createdBy && createdBy !== "unknown") {
            map.set(u.UserName!.replace(/^bedrock-key-/, ""), createdBy);
          }
        } catch {}
      })
    );
  } catch {}

  iamCache = { data: map, expiry: Date.now() + 10 * 60 * 1000 };
  return map;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const region = searchParams.get("region") ?? "us-east-1";
  const groupBy = searchParams.get("groupBy") ?? "model";
  const year = parseInt(searchParams.get("year") ?? new Date().getFullYear().toString());
  const month = parseInt(searchParams.get("month") ?? (new Date().getMonth() + 1).toString());
  const granularity = searchParams.get("granularity") ?? "day";
  const day = searchParams.get("day"); // YYYY-MM-DD for hourly drill-down

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_\-\.@]/g, "");
  const filterApiKey = sanitize(searchParams.get("apiKey") ?? "");
  const filterModel = sanitize(searchParams.get("model") ?? "");
  const filterUser = sanitize(searchParams.get("user") ?? "");

  // Trigger background sync if data is stale (non-blocking)
  await ensureSyncFresh(region);

  // Build date range
  const startDay = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDay = `${year}-${String(month).padStart(2, "0")}-31`; // inclusive, SQLite string compare works

  try {
    // Build where clause
    const where: any = {
      region,
      day: { gte: startDay, lte: endDay },
    };
    if (filterApiKey) where.userKey = { contains: filterApiKey };
    if (filterModel) where.modelKey = { contains: filterModel };
    if (filterUser) where.userKey = { contains: filterUser };

    // If hourly drill-down requested, we still need CloudWatch for that
    // (our SQLite only stores daily granularity). Fall back to CW for hourly.
    if (granularity === "hour" && day) {
      // Lazy import to avoid loading CW client on every request
      const { runInsightsQuery } = await import("@/lib/cloudwatch");
      const { CloudWatchLogsClient } = await import("@aws-sdk/client-cloudwatch-logs");
      const cwl = new CloudWatchLogsClient({ region });
      const dayDate = new Date(day + "T00:00:00Z");
      const dayEnd = new Date(dayDate.getTime() + 24 * 60 * 60 * 1000 - 1);

      const hourlyQuery = `
        fields input.inputTokenCount as inTok, output.outputTokenCount as outTok,
               coalesce(input.cacheReadInputTokenCount, 0) as cacheReadTok,
               coalesce(input.cacheWriteInputTokenCount, 0) as cacheWriteTok,
               modelId, identity.arn as userArn
        | stats sum(inTok) as totalIn, sum(outTok) as totalOut,
                sum(cacheReadTok) as cacheRead, sum(cacheWriteTok) as cacheWrite,
                count(*) as invocations
          by bin(1h) as day, modelId, identity.arn
        | sort day asc
      `;

      const hourlyResults = await runInsightsQuery(cwl, hourlyQuery, dayDate, dayEnd);
      const mapRow = (r: Record<string, string>) => ({
        day: r.day,
        userKey: cleanUser(r["identity.arn"] ?? r.userArn ?? "unknown"),
        modelKey: cleanModel(r.modelId ?? "unknown"),
        totalIn: parseInt(r.totalIn ?? "0"),
        totalOut: parseInt(r.totalOut ?? "0"),
        cacheRead: parseInt(r.cacheRead ?? "0"),
        cacheWrite: parseInt(r.cacheWrite ?? "0"),
        invocations: parseInt(r.invocations ?? "0"),
      });

      return NextResponse.json({
        daily: hourlyResults
          .filter((r) => r.totalIn || r.totalOut)
          .map(mapRow),
        summary: [],
        period: { year, month, startTime: dayDate.toISOString(), endTime: dayEnd.toISOString() },
      });
    }

    // Read from SQLite — instant
    const rows = await prisma.analyticsAgg.findMany({ where });

    // Resolve IAM usernames to emails for user groupBy
    let userEmailMap = new Map<string, string>();
    if (groupBy === "user") {
      userEmailMap = await getUserEmailMap(region);
    }

    const resolveUser = (userKey: string) => {
      if (groupBy === "user") {
        return userEmailMap.get(userKey) ?? userKey;
      }
      return userKey;
    };

    // Build daily rows
    const daily = rows.map((r) => ({
      day: r.day,
      userKey: resolveUser(r.userKey),
      modelKey: r.modelKey,
      totalIn: Number(r.totalIn),
      totalOut: Number(r.totalOut),
      cacheRead: Number(r.cacheRead),
      cacheWrite: Number(r.cacheWrite),
      invocations: r.invocations,
    }));

    // Build summary (aggregate across days)
    const summaryMap = new Map<string, {
      userKey: string; modelKey: string;
      totalIn: number; totalOut: number;
      cacheRead: number; cacheWrite: number;
      invocations: number;
    }>();

    for (const r of daily) {
      const key = `${r.userKey}:${r.modelKey}`;
      const existing = summaryMap.get(key);
      if (existing) {
        existing.totalIn += r.totalIn;
        existing.totalOut += r.totalOut;
        existing.cacheRead += r.cacheRead;
        existing.cacheWrite += r.cacheWrite;
        existing.invocations += r.invocations;
      } else {
        summaryMap.set(key, { ...r });
      }
    }

    const summary = Array.from(summaryMap.values()).sort(
      (a, b) => b.totalIn - a.totalIn
    );

    const startTime = new Date(year, month - 1, 1);
    const endTime = new Date(year, month, 0, 23, 59, 59);

    return NextResponse.json({
      daily,
      summary,
      period: { year, month, startTime: startTime.toISOString(), endTime: endTime.toISOString() },
      ...(groupBy === "user" && userEmailMap.size > 0
        ? { keyToUser: Object.fromEntries(userEmailMap) }
        : {}),
    });
  } catch (err: any) {
    console.error("[analytics]", err);
    return NextResponse.json({
      daily: [],
      summary: [],
      period: { year, month, startTime: new Date(year, month - 1, 1).toISOString(), endTime: new Date(year, month, 0, 23, 59, 59).toISOString() },
      error: "Failed to load analytics data",
    });
  }
}

// Helpers (same as before)
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
