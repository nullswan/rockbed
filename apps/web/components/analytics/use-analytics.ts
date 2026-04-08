import { useState, useEffect, useCallback, useRef } from "react";
import { useRegion } from "@/lib/region-context";

// --- Types matching two-dimensional API response ---

export type AnalyticsRow = {
  userKey: string;
  modelKey: string;
  totalIn: number;
  totalOut: number;
  cacheRead: number;
  cacheWrite: number;
  invocations: number;
};

export type DailyRow = AnalyticsRow & { day: string };

export type AnalyticsData = {
  daily: DailyRow[];
  summary: AnalyticsRow[];
  period: { year: number; month: number; startTime: string; endTime: string };
  keyToUser?: Record<string, string>; // rawKey → email, only when groupBy=user
  error?: string;
};

// Keep old type aliases for backwards compat
export type DailyData = DailyRow;
export type SummaryData = AnalyticsRow;

// Re-export centralized pricing
export { calculateCost, calculateCost as getModelCost } from "@rockbed/shared";

// --- Aggregation helpers ---

/** Aggregate rows by a key field, summing numeric columns */
function aggregateBy(rows: AnalyticsRow[], keyFn: (r: AnalyticsRow) => string): AnalyticsRow[] {
  const map = new Map<string, AnalyticsRow>();
  for (const r of rows) {
    const key = keyFn(r);
    const existing = map.get(key);
    if (existing) {
      existing.totalIn += r.totalIn;
      existing.totalOut += r.totalOut;
      existing.cacheRead += r.cacheRead;
      existing.cacheWrite += r.cacheWrite;
      existing.invocations += r.invocations;
    } else {
      map.set(key, { ...r });
    }
  }
  return Array.from(map.values());
}

/** Aggregate summary rows by model (sum across users) */
export function aggregateByModel(rows: AnalyticsRow[]): AnalyticsRow[] {
  return aggregateBy(rows, (r) => r.modelKey).map((r) => ({
    ...r,
    userKey: "__all__",
  }));
}

/** Aggregate summary rows by user (sum across models) */
export function aggregateByUser(rows: AnalyticsRow[]): AnalyticsRow[] {
  return aggregateBy(rows, (r) => r.userKey).map((r) => ({
    ...r,
    modelKey: "__all__",
  }));
}

/** Get per-model breakdown for a specific user */
export function modelsForUser(rows: AnalyticsRow[], userKey: string): AnalyticsRow[] {
  return rows.filter((r) => r.userKey === userKey);
}

// --- Hook ---

export type AnalyticsFilters = {
  apiKey?: string;
  model?: string;
  user?: string;
};

export function useAnalytics(
  groupBy: string,
  year: number,
  month: number,
  filters?: AnalyticsFilters
) {
  const { region } = useRegion();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doFetch = useCallback((showLoading = true) => {
    if (showLoading) setLoading(true);
    const params = new URLSearchParams({
      region,
      groupBy,
      year: String(year),
      month: String(month),
    });
    if (filters?.apiKey) params.set("apiKey", filters.apiKey);
    if (filters?.model) params.set("model", filters.model);
    if (filters?.user) params.set("user", filters.user);

    fetch(`/api/analytics?${params}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [region, groupBy, year, month, filters?.apiKey, filters?.model, filters?.user]);

  useEffect(() => {
    doFetch(true);
    intervalRef.current = setInterval(() => doFetch(false), 5 * 60 * 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [doFetch]);

  return { data, loading };
}

// --- Formatting ---

export function formatNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatCurrency(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthName(m: number): string {
  return MONTH_NAMES[m - 1] ?? "";
}

// Pastel chart colors
export const CHART_COLORS = [
  "hsl(210, 70%, 72%)",   // soft blue
  "hsl(25, 85%, 72%)",    // soft orange
  "hsl(150, 50%, 65%)",   // soft green
  "hsl(340, 60%, 72%)",   // soft pink
  "hsl(270, 55%, 72%)",   // soft purple
  "hsl(45, 80%, 70%)",    // soft yellow
  "hsl(190, 60%, 65%)",   // soft teal
  "hsl(0, 60%, 72%)",     // soft red
  "hsl(230, 50%, 72%)",   // soft indigo
  "hsl(100, 45%, 65%)",   // soft lime
];

// Sanitize key for CSS variable name (no dots, slashes, colons)
export function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]/g, "_");
}
