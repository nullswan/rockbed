"use client";

import React, { useState, useMemo, useEffect } from "react";
import { client } from "@/lib/orpc";
import { useRegion } from "@/lib/region-context";
import {
  useAnalytics,
  formatNumber,
  monthName,
  CHART_COLORS,
  sanitizeKey,
  aggregateByModel,
  aggregateByUser,
  type AnalyticsFilters,
  type AnalyticsRow,
} from "./use-analytics";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from "recharts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

export function UsagePage() {
  const now = new Date();
  const { region } = useRegion();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [groupBy, setGroupBy] = useState("model");
  const [filterUser, setFilterUser] = useState("");
  const [apiKeys, setApiKeys] = useState<{ name: string; userName: string }[]>([]);
  const [drillDay, setDrillDay] = useState<string | null>(null);
  const [expandedDrillKeys, setExpandedDrillKeys] = useState<Set<string>>(new Set());

  useEffect(() => { setExpandedDrillKeys(new Set()); }, [drillDay]);

  useEffect(() => {
    client.keys.list({ region }).then((keys) =>
      setApiKeys(keys.map((k) => ({ name: k.friendlyName, userName: k.userName })))
    ).catch(() => {});
  }, [region]);

  const filters: AnalyticsFilters = {};
  if (filterUser) filters.user = filterUser;

  const { data, loading } = useAnalytics(groupBy, year, month, filters);

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear(year - 1); }
    else setMonth(month - 1);
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear(year + 1); }
    else setMonth(month + 1);
  }

  const getGroupKey = (r: AnalyticsRow) =>
    groupBy === "model" ? r.modelKey : r.userKey;

  const { chartData, chartConfig, groupKeys, dayLabelToDate } = useMemo(() => {
    if (!data?.daily.length) return { chartData: [], chartConfig: {}, groupKeys: [], dayLabelToDate: new Map<string, string>() };

    const rawKeys = [...new Set(data.daily.map((d) => getGroupKey(d)))];
    const keyMap = new Map(rawKeys.map((k) => [k, sanitizeKey(k)]));
    const safeKeys = rawKeys.map((k) => keyMap.get(k)!);
    const labelToDate = new Map<string, string>();

    const byDay = new Map<string, Record<string, number>>();
    for (const row of data.daily) {
      const dayKey = new Date(row.day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const isoDay = new Date(row.day).toISOString().slice(0, 10);
      labelToDate.set(dayKey, isoDay);
      if (!byDay.has(dayKey)) byDay.set(dayKey, { day: dayKey as any });
      const entry = byDay.get(dayKey)!;
      const gk = getGroupKey(row);
      const safe = keyMap.get(gk) ?? gk;
      entry[safe] = (entry[safe] ?? 0) + row.totalIn + row.totalOut;
    }

    const config: Record<string, { label: string; color: string }> = {};
    rawKeys.forEach((k, i) => {
      config[keyMap.get(k)!] = { label: k, color: CHART_COLORS[i % CHART_COLORS.length] };
    });

    return {
      chartData: Array.from(byDay.values()),
      chartConfig: config,
      groupKeys: safeKeys,
      dayLabelToDate: labelToDate,
    };
  }, [data, groupBy]);

  // Per-key breakdown for selected drill-down day
  const drillBreakdown = useMemo(() => {
    if (!drillDay || !data?.daily.length) return [];
    const dayRows = data.daily.filter((r) => r.day.startsWith(drillDay));
    const byUser = new Map<string, { userKey: string; totalIn: number; totalOut: number; cacheRead: number; cacheWrite: number; invocations: number; models: AnalyticsRow[] }>();
    for (const r of dayRows) {
      const existing = byUser.get(r.userKey);
      if (existing) {
        existing.totalIn += r.totalIn;
        existing.totalOut += r.totalOut;
        existing.cacheRead += r.cacheRead;
        existing.cacheWrite += r.cacheWrite;
        existing.invocations += r.invocations;
        existing.models.push(r);
      } else {
        byUser.set(r.userKey, {
          userKey: r.userKey,
          totalIn: r.totalIn, totalOut: r.totalOut,
          cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
          invocations: r.invocations,
          models: [r],
        });
      }
    }
    return Array.from(byUser.values()).sort((a, b) => (b.totalIn + b.totalOut) - (a.totalIn + a.totalOut));
  }, [drillDay, data]);

  // Totals
  const totals = useMemo(() => {
    if (!data?.summary.length) return { totalIn: 0, totalOut: 0, cacheRead: 0, cacheWrite: 0, invocations: 0 };
    return data.summary.reduce(
      (acc, r) => ({
        totalIn: acc.totalIn + r.totalIn,
        totalOut: acc.totalOut + r.totalOut,
        cacheRead: acc.cacheRead + r.cacheRead,
        cacheWrite: acc.cacheWrite + r.cacheWrite,
        invocations: acc.invocations + r.invocations,
      }),
      { totalIn: 0, totalOut: 0, cacheRead: 0, cacheWrite: 0, invocations: 0 }
    );
  }, [data]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usage</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Token usage across all API keys.
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={groupBy} onValueChange={(v) => v && setGroupBy(v)}>
          <SelectTrigger className="w-44">
            <span>Group by: {groupBy === "apiKey" ? "API Key" : groupBy === "user" ? "User" : "Model"}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="model">Model</SelectItem>
            <SelectItem value="apiKey">API Key</SelectItem>
            <SelectItem value="user">User</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterUser || "_all"} onValueChange={(v) => setFilterUser(!v || v === "_all" ? "" : v)}>
          <SelectTrigger className="w-44">
            <span>API key: {filterUser ? apiKeys.find(k => k.userName.includes(filterUser))?.name ?? filterUser : "All"}</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All</SelectItem>
            {apiKeys.map((k) => (
              <SelectItem key={k.userName} value={k.userName}>
                {k.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1 border rounded-lg px-1">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={prevMonth}>
            <ChevronLeftIcon className="size-4" />
          </Button>
          <span className="text-sm font-medium px-2 min-w-[120px] text-center">
            {monthName(month)} {year}
          </span>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={nextMonth}>
            <ChevronRightIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Total tokens in</p>
            {loading ? (
              <Skeleton className="h-8 w-40 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">{formatNumber(totals.totalIn)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Total tokens out</p>
            {loading ? (
              <Skeleton className="h-8 w-40 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">{formatNumber(totals.totalOut)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Cache read tokens</p>
            {loading ? (
              <Skeleton className="h-8 w-40 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">{formatNumber(totals.cacheRead)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Cache write tokens</p>
            {loading ? (
              <Skeleton className="h-8 w-40 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">{formatNumber(totals.cacheWrite)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Total invocations</p>
            {loading ? (
              <Skeleton className="h-8 w-40 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">{formatNumber(totals.invocations)}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Token usage chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Token usage</CardTitle>
          <p className="text-sm text-muted-foreground">
            Daily token usage grouped by {groupBy === "apiKey" ? "API key" : groupBy}
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-80 w-full" />
          ) : chartData.length === 0 ? (
            <div className="h-80 flex items-center justify-center text-sm text-muted-foreground">
              No usage data for this period.
              {data?.error && <span className="ml-1 text-destructive">({data.error})</span>}
            </div>
          ) : (
            <ChartContainer config={chartConfig} className="h-80 w-full">
              <BarChart
                data={chartData}
                barCategoryGap="20%"
                onClick={(state) => {
                  if (!state?.activeLabel) return;
                  const isoDay = dayLabelToDate.get(String(state.activeLabel));
                  if (isoDay) setDrillDay(drillDay === isoDay ? null : isoDay);
                }}
                style={{ cursor: "pointer" }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
                  tickFormatter={(v) => formatNumber(v)}
                />
                <ChartTooltip
                  content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="rounded-lg border bg-background p-3 shadow-md text-sm">
                        <p className="font-medium mb-1.5">{label}</p>
                        {payload.filter((p: any) => p.value > 0).map((p: any) => (
                          <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
                            <span className="size-2.5 rounded-full shrink-0" style={{ background: p.fill }} />
                            <span className="text-muted-foreground">{chartConfig[p.dataKey]?.label ?? p.dataKey}:</span>
                            <span className="font-mono font-medium ml-auto">{formatNumber(p.value)}</span>
                          </div>
                        ))}
                        <p className="text-xs text-muted-foreground mt-1.5">Click to see per-key breakdown</p>
                      </div>
                    );
                  }}
                />
                <ChartLegend content={<ChartLegendContent />} />
                {groupKeys.map((key, i) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="tokens"
                    fill={CHART_COLORS[i % CHART_COLORS.length]}
                    radius={[0, 0, 0, 0]}
                  />
                ))}
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* Per-key breakdown for selected day */}
      {drillDay && drillBreakdown.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                Usage breakdown — {new Date(drillDay + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setDrillDay(null)}>
                <ChevronLeftIcon className="size-4 mr-1" />
                Close
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-3 font-medium text-muted-foreground">Key</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Tokens in</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Tokens out</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Cache read</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Cache write</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Invocations</th>
                  </tr>
                </thead>
                <tbody>
                  {drillBreakdown.map((row) => (
                    <React.Fragment key={row.userKey}>
                      <tr
                        className="border-b last:border-0 cursor-pointer hover:bg-muted/50"
                        onClick={() => {
                          setExpandedDrillKeys((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.userKey)) next.delete(row.userKey);
                            else next.add(row.userKey);
                            return next;
                          });
                        }}
                      >
                        <td className="p-3 font-medium">
                          <ChevronRightIcon className={`inline size-4 mr-1 transition-transform ${expandedDrillKeys.has(row.userKey) ? "rotate-90" : ""}`} />
                          {row.userKey}
                        </td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.totalIn)}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.totalOut)}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.cacheRead)}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.cacheWrite)}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.invocations)}</td>
                      </tr>
                      {expandedDrillKeys.has(row.userKey) && row.models.map((m, j) => (
                        <tr key={`${row.userKey}-${m.modelKey}-${j}`} className="border-b last:border-0 bg-muted/30">
                          <td className="p-3 pl-8 text-sm text-muted-foreground">{m.modelKey}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.totalIn)}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.totalOut)}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.cacheRead)}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.cacheWrite)}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.invocations)}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Breakdown table */}
      {data && data.summary.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Breakdown by {groupBy === "apiKey" ? "API key" : groupBy}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-3 font-medium text-muted-foreground">
                      {groupBy === "apiKey" ? "API Key" : groupBy === "user" ? "User" : "Model"}
                    </th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Tokens in</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Tokens out</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Cache read</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Cache write</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Invocations</th>
                  </tr>
                </thead>
                <tbody>
                  {(groupBy === "model" ? aggregateByModel(data.summary) : aggregateByUser(data.summary)).map((row, i) => (
                    <tr key={`${getGroupKey(row)}-${i}`} className="border-b last:border-0">
                      <td className="p-3 font-medium">{getGroupKey(row)}</td>
                      <td className="p-3 text-right font-mono">{formatNumber(row.totalIn)}</td>
                      <td className="p-3 text-right font-mono">{formatNumber(row.totalOut)}</td>
                      <td className="p-3 text-right font-mono">{formatNumber(row.cacheRead)}</td>
                      <td className="p-3 text-right font-mono">{formatNumber(row.cacheWrite)}</td>
                      <td className="p-3 text-right font-mono">{formatNumber(row.invocations)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
