"use client";

import React, { useState, useMemo, useEffect } from "react";
import { client } from "@/lib/orpc";
import { useRegion } from "@/lib/region-context";
import {
  useAnalytics,
  formatNumber,
  formatCurrency,
  calculateCost,
  monthName,
  CHART_COLORS,
  sanitizeKey,
  aggregateByModel,
  aggregateByUser,
  modelsForUser,
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
import {
  Bar,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Pie,
  PieChart,
  Cell,
} from "recharts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

export function CostPage() {
  const now = new Date();
  const { region } = useRegion();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [groupBy, setGroupBy] = useState("user");
  const [filterUser, setFilterUser] = useState("");
  const [apiKeys, setApiKeys] = useState<{ name: string; userName: string }[]>([]);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [drillDay, setDrillDay] = useState<string | null>(null);
  const [expandedDrillKeys, setExpandedDrillKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    client.keys.list({ region }).then((keys) =>
      setApiKeys(keys.map((k) => ({ name: k.friendlyName, userName: k.userName })))
    ).catch(() => {});
  }, [region]);

  const filters: AnalyticsFilters = {};
  if (filterUser) filters.user = filterUser;

  // Single two-dimensional query — groupBy only controls email resolution
  const { data, loading } = useAnalytics(groupBy, year, month, filters);

  // Reset drill-down expanded state when day changes
  useEffect(() => { setExpandedDrillKeys(new Set()); }, [drillDay]);

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear(year - 1); }
    else setMonth(month - 1);
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear(year + 1); }
    else setMonth(month + 1);
  }

  // Total cost from model-level aggregation with cache-aware pricing
  const totalCost = useMemo(() => {
    if (!data?.summary.length) return 0;
    return aggregateByModel(data.summary).reduce(
      (acc, r) => acc + calculateCost(r.modelKey, r.totalIn, r.totalOut, r.cacheRead, r.cacheWrite),
      0,
    );
  }, [data]);

  // Total cache read tokens
  const totalCacheRead = useMemo(() => {
    if (!data?.summary.length) return 0;
    return data.summary.reduce((a, r) => a + r.cacheRead, 0);
  }, [data]);

  // Pie chart data by model
  const pieData = useMemo(() => {
    if (!data?.summary.length) return [];
    return aggregateByModel(data.summary)
      .map((r) => ({
        name: r.modelKey,
        value: calculateCost(r.modelKey, r.totalIn, r.totalOut, r.cacheRead, r.cacheWrite),
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [data]);

  const pieConfig = useMemo(() => {
    const config: Record<string, { label: string; color: string }> = {};
    pieData.forEach((d, i) => {
      config[sanitizeKey(d.name)] = { label: d.name, color: CHART_COLORS[i % CHART_COLORS.length] };
    });
    return config;
  }, [pieData]);

  // Daily cost chart (from model-aggregated daily data)
  const { dailyCostData, dailyConfig, dailyKeys, dayLabelToDate } = useMemo(() => {
    const rows = data?.daily ?? [];
    if (!rows.length) return { dailyCostData: [], dailyConfig: {}, dailyKeys: [], dayLabelToDate: new Map<string, string>() };

    // Aggregate daily rows by model
    const rawKeys = [...new Set(rows.map((d) => d.modelKey))];
    const keyMap = new Map(rawKeys.map((k) => [k, sanitizeKey(k)]));
    const safeKeys = rawKeys.map((k) => keyMap.get(k)!);
    const labelToDate = new Map<string, string>();

    const byDay = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const dayKey = new Date(row.day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      // Store ISO date for drill-down
      const isoDay = new Date(row.day).toISOString().slice(0, 10);
      labelToDate.set(dayKey, isoDay);
      if (!byDay.has(dayKey)) byDay.set(dayKey, {});
      const entry = byDay.get(dayKey)!;
      entry.day = dayKey as any;
      const safe = keyMap.get(row.modelKey)!;
      entry[safe] =
        (entry[safe] ?? 0) + calculateCost(row.modelKey, row.totalIn, row.totalOut, row.cacheRead, row.cacheWrite);
    }

    const config: Record<string, { label: string; color: string }> = {};
    rawKeys.forEach((k, i) => {
      config[keyMap.get(k)!] = { label: k, color: CHART_COLORS[i % CHART_COLORS.length] };
    });

    return {
      dailyCostData: Array.from(byDay.values()),
      dailyConfig: config,
      dailyKeys: safeKeys,
      dayLabelToDate: labelToDate,
    };
  }, [data]);

  // Per-key breakdown for the selected drill-down day
  const drillBreakdown = useMemo(() => {
    if (!drillDay || !data?.daily.length) return [];
    const dayRows = data.daily.filter((r) => r.day.startsWith(drillDay));
    const byUser = new Map<string, { userKey: string; totalIn: number; totalOut: number; cacheRead: number; cacheWrite: number; invocations: number; cost: number; models: AnalyticsRow[] }>();
    for (const r of dayRows) {
      const existing = byUser.get(r.userKey);
      if (existing) {
        existing.totalIn += r.totalIn;
        existing.totalOut += r.totalOut;
        existing.cacheRead += r.cacheRead;
        existing.cacheWrite += r.cacheWrite;
        existing.invocations += r.invocations;
        existing.cost += calculateCost(r.modelKey, r.totalIn, r.totalOut, r.cacheRead, r.cacheWrite);
        existing.models.push(r);
      } else {
        byUser.set(r.userKey, {
          userKey: r.userKey,
          totalIn: r.totalIn, totalOut: r.totalOut,
          cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
          invocations: r.invocations,
          cost: calculateCost(r.modelKey, r.totalIn, r.totalOut, r.cacheRead, r.cacheWrite),
          models: [r],
        });
      }
    }
    return Array.from(byUser.values()).sort((a, b) => b.cost - a.cost);
  }, [drillDay, data]);

  // Breakdown table with expandable rows
  const costBreakdown = useMemo(() => {
    if (!data?.summary.length) return [];
    if (groupBy === "model") {
      return aggregateByModel(data.summary).map((r) => ({
        ...r,
        groupKey: r.modelKey,
        cost: calculateCost(r.modelKey, r.totalIn, r.totalOut, r.cacheRead, r.cacheWrite),
      }));
    }
    // user or apiKey: aggregate by user, each row's cost is sum of per-model costs
    return aggregateByUser(data.summary).map((r) => ({
      ...r,
      groupKey: r.userKey,
      cost: modelsForUser(data.summary, r.userKey).reduce(
        (acc, m) => acc + calculateCost(m.modelKey, m.totalIn, m.totalOut, m.cacheRead, m.cacheWrite),
        0,
      ),
    }));
  }, [data, groupBy]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Cost</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Costs based on Bedrock on-demand pricing.
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
            <span>API key: {filterUser ? apiKeys.find(k => k.userName === filterUser)?.name ?? filterUser : "All"}</span>
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

      {/* Cost summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Total cost</p>
              {loading ? (
                <Skeleton className="h-8 w-32 mt-1" />
              ) : (
                <p className="text-2xl font-bold mt-1">{formatCurrency(totalCost)}</p>
              )}
            </div>
            {!loading && pieData.length > 0 && (
              <ChartContainer config={pieConfig} className="size-20">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={25}
                    outerRadius={38}
                    strokeWidth={2}
                  >
                    {pieData.map((d, i) => (
                      <Cell
                        key={`${d.name}-${i}`}
                        fill={CHART_COLORS[i % CHART_COLORS.length]}
                      />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Total tokens in</p>
            {loading ? (
              <Skeleton className="h-8 w-32 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">
                {formatNumber(
                  data?.summary.reduce((a, r) => a + r.totalIn, 0) ?? 0
                )}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Total tokens out</p>
            {loading ? (
              <Skeleton className="h-8 w-32 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">
                {formatNumber(
                  data?.summary.reduce((a, r) => a + r.totalOut, 0) ?? 0
                )}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-sm text-muted-foreground">Cache read tokens</p>
            {loading ? (
              <Skeleton className="h-8 w-32 mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1">
                {formatNumber(totalCacheRead)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Daily cost chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Daily cost</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-80 w-full" />
          ) : dailyCostData.length === 0 ? (
            <div className="h-80 flex items-center justify-center text-sm text-muted-foreground">
              No cost data for this period.
            </div>
          ) : (
            <ChartContainer config={dailyConfig} className="h-80 w-full">
              <BarChart
                data={dailyCostData}
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
                  tickFormatter={(v) => `$${formatNumber(v)}`}
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
                            <span className="text-muted-foreground">{dailyConfig[p.dataKey]?.label ?? p.dataKey}:</span>
                            <span className="font-mono font-medium ml-auto">{formatCurrency(p.value)}</span>
                          </div>
                        ))}
                        <p className="text-xs text-muted-foreground mt-1.5">Click to see per-key breakdown</p>
                      </div>
                    );
                  }}
                />
                <ChartLegend content={<ChartLegendContent />} />
                {dailyKeys.map((key, i) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="cost"
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
                Cost breakdown — {new Date(drillDay + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
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
                    <th className="text-right p-3 font-medium text-muted-foreground">Invocations</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Cost</th>
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
                        <td className="p-3 text-right font-mono">{formatNumber(row.invocations)}</td>
                        <td className="p-3 text-right font-mono">{formatCurrency(row.cost)}</td>
                      </tr>
                      {expandedDrillKeys.has(row.userKey) && row.models.map((m, j) => (
                        <tr key={`${row.userKey}-${m.modelKey}-${j}`} className="border-b last:border-0 bg-muted/30">
                          <td className="p-3 pl-8 text-sm text-muted-foreground">{m.modelKey}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.totalIn)}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.totalOut)}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.cacheRead)}</td>
                          <td className="p-3 text-right font-mono text-sm">{formatNumber(m.invocations)}</td>
                          <td className="p-3 text-right font-mono text-sm">
                            {formatCurrency(calculateCost(m.modelKey, m.totalIn, m.totalOut, m.cacheRead, m.cacheWrite))}
                          </td>
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

      {/* Cost breakdown */}
      {costBreakdown.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Cost breakdown by {groupBy === "apiKey" ? "API key" : groupBy}
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
                    <th className="text-right p-3 font-medium text-muted-foreground">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {costBreakdown.map((row, i) => (
                    <React.Fragment key={`${row.groupKey}-${i}`}>
                      <tr
                        className={`border-b last:border-0 ${groupBy !== "model" ? "cursor-pointer hover:bg-muted/50" : ""}`}
                        onClick={() => {
                          if (groupBy === "model") return;
                          setExpandedUsers((prev) => {
                            const next = new Set(prev);
                            if (next.has(row.groupKey)) next.delete(row.groupKey);
                            else next.add(row.groupKey);
                            return next;
                          });
                        }}
                      >
                        <td className="p-3 font-medium">
                          {groupBy !== "model" && (
                            <ChevronRightIcon
                              className={`inline size-4 mr-1 transition-transform ${expandedUsers.has(row.groupKey) ? "rotate-90" : ""}`}
                            />
                          )}
                          {row.groupKey}
                        </td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.totalIn)}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.totalOut)}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.cacheRead)}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.cacheWrite)}</td>
                        <td className="p-3 text-right font-mono">{formatNumber(row.invocations)}</td>
                        <td className="p-3 text-right font-mono">{formatCurrency(row.cost)}</td>
                      </tr>
                      {groupBy !== "model" && expandedUsers.has(row.groupKey) &&
                        modelsForUser(data!.summary, row.userKey).map((m, j) => (
                          <tr key={`${row.groupKey}-${m.modelKey}-${j}`} className="border-b last:border-0 bg-muted/30">
                            <td className="p-3 pl-8 text-sm text-muted-foreground">{m.modelKey}</td>
                            <td className="p-3 text-right font-mono text-sm">{formatNumber(m.totalIn)}</td>
                            <td className="p-3 text-right font-mono text-sm">{formatNumber(m.totalOut)}</td>
                            <td className="p-3 text-right font-mono text-sm">{formatNumber(m.cacheRead)}</td>
                            <td className="p-3 text-right font-mono text-sm">{formatNumber(m.cacheWrite)}</td>
                            <td className="p-3 text-right font-mono text-sm">{formatNumber(m.invocations)}</td>
                            <td className="p-3 text-right font-mono text-sm">
                              {formatCurrency(calculateCost(m.modelKey, m.totalIn, m.totalOut, m.cacheRead, m.cacheWrite))}
                            </td>
                          </tr>
                        ))
                      }
                    </React.Fragment>
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
