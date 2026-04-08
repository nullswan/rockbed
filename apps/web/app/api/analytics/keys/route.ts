import { auth } from "@/lib/auth";
import { ensureSyncFresh } from "@/lib/analytics-sync";
import { prisma } from "@rockbed/db";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

type ModelStats = { totalIn: number; totalOut: number; cacheRead: number; cacheWrite: number; invocations: number };

type KeyEntry = {
  mtdIn: number; mtdOut: number; mtdInv: number;
  recentIn: number; recentOut: number; recentInv: number;
  mtdCacheRead: number; mtdCacheWrite: number;
  recentCacheRead: number; recentCacheWrite: number;
  lastUsed: string | null;
  models: Record<string, ModelStats>;
};

function emptyEntry(): KeyEntry {
  return {
    mtdIn: 0, mtdOut: 0, mtdInv: 0,
    recentIn: 0, recentOut: 0, recentInv: 0,
    mtdCacheRead: 0, mtdCacheWrite: 0,
    recentCacheRead: 0, recentCacheWrite: 0,
    lastUsed: null,
    models: {},
  };
}

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const region = req.nextUrl.searchParams.get("region") ?? "us-east-1";
  const activeKeysParam = req.nextUrl.searchParams.get("activeKeys");
  let activeKeys: Record<string, string> = {};
  if (activeKeysParam) {
    try { activeKeys = JSON.parse(activeKeysParam); } catch {}
  }

  // Trigger background sync if stale
  await ensureSyncFresh(region);

  try {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgoStr = ninetyDaysAgo.toISOString().split("T")[0];

    // MTD data
    const mtdRows = await prisma.analyticsAgg.findMany({
      where: { region, day: { gte: monthStart } },
    });

    // Recent (90-day) data
    const recentRows = await prisma.analyticsAgg.findMany({
      where: { region, day: { gte: ninetyDaysAgoStr } },
    });

    const allKeys: Record<string, KeyEntry> = {};

    // Accumulate MTD
    for (const r of mtdRows) {
      if (!allKeys[r.userKey]) allKeys[r.userKey] = emptyEntry();
      const entry = allKeys[r.userKey];
      const totalIn = Number(r.totalIn);
      const totalOut = Number(r.totalOut);
      const cacheRead = Number(r.cacheRead);
      const cacheWrite = Number(r.cacheWrite);

      entry.mtdIn += totalIn;
      entry.mtdOut += totalOut;
      entry.mtdInv += r.invocations;
      entry.mtdCacheRead += cacheRead;
      entry.mtdCacheWrite += cacheWrite;

      if (!entry.models[r.modelKey]) {
        entry.models[r.modelKey] = { totalIn: 0, totalOut: 0, cacheRead: 0, cacheWrite: 0, invocations: 0 };
      }
      entry.models[r.modelKey].totalIn += totalIn;
      entry.models[r.modelKey].totalOut += totalOut;
      entry.models[r.modelKey].cacheRead += cacheRead;
      entry.models[r.modelKey].cacheWrite += cacheWrite;
      entry.models[r.modelKey].invocations += r.invocations;
    }

    // Accumulate recent
    for (const r of recentRows) {
      if (!allKeys[r.userKey]) allKeys[r.userKey] = emptyEntry();
      const entry = allKeys[r.userKey];
      entry.recentIn += Number(r.totalIn);
      entry.recentOut += Number(r.totalOut);
      entry.recentInv += r.invocations;
      entry.recentCacheRead += Number(r.cacheRead);
      entry.recentCacheWrite += Number(r.cacheWrite);

      // Merge model data from recent if not already in MTD
      if (!entry.models[r.modelKey]) {
        entry.models[r.modelKey] = {
          totalIn: Number(r.totalIn),
          totalOut: Number(r.totalOut),
          cacheRead: Number(r.cacheRead),
          cacheWrite: Number(r.cacheWrite),
          invocations: r.invocations,
        };
      }
    }

    // Approximate lastUsed from the most recent day with data
    for (const [key, entry] of Object.entries(allKeys)) {
      const latestRow = recentRows
        .filter((r) => r.userKey === key)
        .sort((a, b) => b.day.localeCompare(a.day))[0];
      if (latestRow) {
        entry.lastUsed = latestRow.day + "T23:59:59Z";
      }
    }

    // If no activeKeys filter, return all
    if (Object.keys(activeKeys).length === 0) {
      return NextResponse.json(allKeys);
    }

    // Filter to active keys + unattributed
    const activeKeyNames = new Set(Object.keys(activeKeys));
    const unattrib = emptyEntry();

    for (const [name, stats] of Object.entries(allKeys)) {
      if (!activeKeyNames.has(name)) {
        unattrib.mtdIn += stats.mtdIn;
        unattrib.mtdOut += stats.mtdOut;
        unattrib.mtdInv += stats.mtdInv;
        unattrib.mtdCacheRead += stats.mtdCacheRead;
        unattrib.mtdCacheWrite += stats.mtdCacheWrite;
        unattrib.recentIn += stats.recentIn;
        unattrib.recentOut += stats.recentOut;
        unattrib.recentInv += stats.recentInv;
        unattrib.recentCacheRead += stats.recentCacheRead;
        unattrib.recentCacheWrite += stats.recentCacheWrite;
        for (const [model, m] of Object.entries(stats.models)) {
          if (!unattrib.models[model]) unattrib.models[model] = { totalIn: 0, totalOut: 0, cacheRead: 0, cacheWrite: 0, invocations: 0 };
          unattrib.models[model].totalIn += m.totalIn;
          unattrib.models[model].totalOut += m.totalOut;
          unattrib.models[model].cacheRead += m.cacheRead;
          unattrib.models[model].cacheWrite += m.cacheWrite;
          unattrib.models[model].invocations += m.invocations;
        }
      }
    }

    const result: Record<string, KeyEntry> = {};
    for (const name of activeKeyNames) {
      if (allKeys[name]) result[name] = allKeys[name];
    }

    if (unattrib.mtdInv > 0 || unattrib.recentInv > 0) {
      result["__unattributed__"] = unattrib;
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[analytics/keys]", err);
    return NextResponse.json({});
  }
}
