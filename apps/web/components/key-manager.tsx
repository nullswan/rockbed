"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { client } from "@/lib/orpc";
import { useRegion } from "@/lib/region-context";
import { useSession } from "@/lib/auth-client";
import { EXPIRY_PRESETS, calculateCost } from "@rockbed/shared";
import { CopyButton } from "@/components/shared/copy-button";
import { CheckIcon, PauseIcon, PlayIcon } from "lucide-react";
import type { BedrockKey, NewBedrockKey } from "@rockbed/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatNumber } from "@/components/analytics/use-analytics";

type ModelStats = { totalIn: number; totalOut: number; cacheRead: number; cacheWrite: number; invocations: number };

type KeyStats = Record<string, {
  mtdIn: number; mtdOut: number; mtdInv: number;
  recentIn: number; recentOut: number; recentInv: number;
  mtdCacheRead: number; mtdCacheWrite: number;
  recentCacheRead: number; recentCacheWrite: number;
  lastUsed: string | null;
  models: Record<string, ModelStats>;
}>;

function perModelCost(models: Record<string, ModelStats> | undefined): number {
  if (!models) return 0;
  return Object.entries(models).reduce(
    (acc, [model, m]) => acc + calculateCost(model, m.totalIn, m.totalOut, m.cacheRead, m.cacheWrite),
    0,
  );
}

export function KeyManager() {
  const { region } = useRegion();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const [keys, setKeys] = useState<BedrockKey[]>([]);
  const [keyStats, setKeyStats] = useState<KeyStats>({});
  const [newKey, setNewKey] = useState<NewBedrockKey | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    userName: string;
    credentialId: string;
    friendlyName: string;
  } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createExpiryPreset, setCreateExpiryPreset] = useState("0");
  const [createExpiryDays, setCreateExpiryDays] = useState(0);
  const [createCustomDays, setCreateCustomDays] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingLimit, setEditingLimit] = useState<string | null>(null);
  const [limitValue, setLimitValue] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);

  async function saveLimit(key: BedrockKey) {
    const val = limitValue.trim();
    const limit = val === "" || val === "none" ? "none" as const : parseFloat(val);
    if (typeof limit === "number" && (isNaN(limit) || limit <= 0)) return;
    try {
      await client.keys.setDailyLimit({ region, userName: key.userName, limit });
      setEditingLimit(null);
      await refresh();
    } catch {}
  }

  async function handleToggle(key: BedrockKey) {
    setToggling(key.credentialId);
    try {
      await client.keys.toggle({
        region,
        userName: key.userName,
        credentialId: key.credentialId,
        active: key.status !== "Active",
      });
      await refresh();
    } catch (err: any) {
      setError(err.message ?? "Failed to toggle key");
    } finally {
      setToggling(null);
    }
  }

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const keyList = await client.keys.list({ region });
      setKeys(keyList);
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to load keys");
    } finally {
      setRefreshing(false);
    }
  }, [region]);

  const keysFingerprint = keys.map((k) => `${k.friendlyName}:${k.createdAt}`).join(",");

  const sortedKeys = useMemo(() => {
    const email = session?.user?.email;
    return [...keys].sort((a, b) => {
      const aOwned = a.createdBy === email ? 1 : 0;
      const bOwned = b.createdBy === email ? 1 : 0;
      if (aOwned !== bOwned) return bOwned - aOwned;
      const aLast = keyStats[a.friendlyName]?.lastUsed ?? "";
      const bLast = keyStats[b.friendlyName]?.lastUsed ?? "";
      return bLast.localeCompare(aLast);
    });
  }, [keys, keyStats, session?.user?.email]);

  useEffect(() => {
    if (keys.length === 0) return;
    const activeKeys: Record<string, string> = {};
    for (const k of keys) {
      activeKeys[k.friendlyName] = k.createdAt;
    }
    const params = new URLSearchParams({ region });
    if (Object.keys(activeKeys).length > 0) {
      params.set("activeKeys", JSON.stringify(activeKeys));
    }
    fetch(`/api/analytics/keys?${params}`)
      .then((r) => r.json())
      .then(setKeyStats)
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region, keysFingerprint]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function handleExpiryChange(value: string | null) {
    if (!value) return;
    setCreateExpiryPreset(value);
    const days = parseInt(value, 10);
    if (days >= 0) {
      setCreateExpiryDays(days);
      setCreateCustomDays("");
    }
  }

  function openCreateDialog() {
    setCreateName("");
    setCreateExpiryPreset("0");
    setCreateExpiryDays(0);
    setCreateCustomDays("");
    setCreateError(null);
    setNewKey(null);
    setCreateOpen(true);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createName.trim()) return;
    const finalDays =
      createExpiryPreset === "-1"
        ? parseInt(createCustomDays, 10) || 0
        : createExpiryDays;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await client.keys.create({
        name: createName.trim(),
        region,
        expiryDays: finalDays,
        createdBy: session?.user?.email ?? undefined,
      });
      setNewKey(created);
      setCreateOpen(false);
      await refresh();
    } catch (err: any) {
      setCreateError(err.message ?? "Failed to create key");
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    const { userName, credentialId } = deleteTarget;
    setDeleting(credentialId);
    setDeleteTarget(null);
    try {
      await client.keys.delete({ userName, credentialId, region });
      setNewKey(null);
      await refresh();
    } catch (err: any) {
      setError(err.message ?? "Failed to delete key");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {newKey && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-2">
            <div className="size-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <CheckIcon className="size-3 text-emerald-500" />
            </div>
            <p className="text-sm font-medium text-foreground">
              Key created &mdash; copy it now, it won&apos;t be shown again.
            </p>
          </div>
          <div className="rounded-md bg-background/80 border border-border/60 divide-y divide-border/60 text-sm">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-muted-foreground text-xs">Name</span>
              <code className="text-xs font-medium">{newKey.apiKeyId}</code>
            </div>
            <div className="px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">API key</span>
                <CopyButton text={newKey.apiKey} label="API key" />
              </div>
              <code className="text-xs font-mono block break-all bg-muted rounded px-2 py-1.5 text-foreground select-all">
                {newKey.apiKey}
              </code>
            </div>
            {newKey.expiresAt && (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-muted-foreground text-xs">Expires</span>
                <span className="text-xs font-medium">
                  {new Date(newKey.expiresAt).toLocaleDateString()}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              API keys
              {!refreshing && (
                <span className="text-muted-foreground font-normal ml-2">
                  ({keys.length})
                </span>
              )}
            </CardTitle>
            <Button onClick={openCreateDialog}>Create key</Button>
          </div>
        </CardHeader>
        <CardContent>
          {refreshing && keys.length === 0 ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg border p-4 animate-pulse">
                  <div className="h-4 bg-muted rounded w-32 mb-3" />
                  <div className="grid grid-cols-3 gap-3">
                    {[1, 2, 3].map((j) => <div key={j} className="h-3 bg-muted rounded w-16" />)}
                  </div>
                </div>
              ))}
            </div>
          ) : keys.length === 0 ? (
            <div className="py-8 text-center space-y-3">
              <p className="text-sm text-muted-foreground">No API keys yet.</p>
              <Button variant="outline" onClick={openCreateDialog}>
                Create your first key
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {sortedKeys.map((key) => {
                const s = keyStats[key.friendlyName];
                const mtdCost = s?.mtdInv ? perModelCost(s.models) : 0;
                const canManage = isAdmin || key.createdBy === session?.user?.email;
                const isOwned = key.createdBy === session?.user?.email;
                return (
                  <div key={key.credentialId} className={cn("rounded-lg border p-4 space-y-3", isOwned && "border-primary/30 bg-primary/[0.02]")}>
                    {/* Header: name, status, actions */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-sm truncate">{key.friendlyName}</span>
                        {key.autoDisabledAt ? (
                          <Badge variant="destructive" className="text-[10px] px-1.5 py-0 shrink-0">Limit hit</Badge>
                        ) : key.status === "Active" ? (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-emerald-500/50 text-emerald-600 shrink-0">Active</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">Paused</Badge>
                        )}
                      </div>
                      {canManage && (
                        <div className="flex items-center gap-1 shrink-0">
                          <Tooltip>
                            <TooltipTrigger className="inline-flex">
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleToggle(key)} disabled={toggling === key.credentialId}>
                                {key.status === "Active" ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>{key.status === "Active" ? "Pause key" : "Resume key"}</TooltipContent>
                          </Tooltip>
                          <Button
                            variant="ghost" size="sm"
                            className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteTarget({ userName: key.userName, credentialId: key.credentialId, friendlyName: key.friendlyName })}
                            disabled={deleting === key.credentialId}
                          >
                            {deleting === key.credentialId ? "..." : "Delete"}
                          </Button>
                        </div>
                      )}
                    </div>

                    {/* Meta row */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger className="cursor-default font-mono truncate max-w-[180px]">
                          {key.apiKeyId.length > 24 ? `${key.apiKeyId.slice(0, 10)}...${key.apiKeyId.slice(-10)}` : key.apiKeyId}
                        </TooltipTrigger>
                        <TooltipContent><code className="text-xs">{key.apiKeyId}</code></TooltipContent>
                      </Tooltip>
                      <span>{new Date(key.createdAt).toLocaleDateString()}</span>
                      {key.createdBy && <span>{key.createdBy}</span>}
                      <span>
                        {(() => {
                          if (!s?.lastUsed) return "Never used";
                          const d = new Date(s.lastUsed);
                          const diffMs = Date.now() - d.getTime();
                          const mins = Math.floor(diffMs / 60000);
                          if (mins < 1) return "Just now";
                          if (mins < 60) return `${mins}m ago`;
                          const hours = Math.floor(mins / 60);
                          if (hours < 24) return `${hours}h ago`;
                          const days = Math.floor(hours / 24);
                          if (days === 1) return "Yesterday";
                          if (days < 7) return `${days}d ago`;
                          return d.toLocaleDateString();
                        })()}
                      </span>
                    </div>

                    {/* Stats grid */}
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-xs">
                      <div>
                        <div className="text-muted-foreground mb-0.5">MTD cost</div>
                        <div className="font-mono font-medium">{mtdCost ? `$${mtdCost.toFixed(2)}` : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Input tokens</div>
                        <div className="font-mono">{s?.mtdIn ? formatNumber(s.mtdIn) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Output tokens</div>
                        <div className="font-mono">{s?.mtdOut ? formatNumber(s.mtdOut) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Cache read</div>
                        <div className="font-mono">{s?.mtdCacheRead ? formatNumber(s.mtdCacheRead) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Cache write</div>
                        <div className="font-mono">{s?.mtdCacheWrite ? formatNumber(s.mtdCacheWrite) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Invocations</div>
                        <div className="font-mono">{s?.mtdInv ? formatNumber(s.mtdInv) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Daily limit</div>
                        {editingLimit === key.userName ? (
                          <Input
                            className="h-5 w-16 text-xs text-right px-1"
                            value={limitValue}
                            onChange={(e) => setLimitValue(e.target.value)}
                            placeholder="none"
                            autoFocus
                            onBlur={() => saveLimit(key)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); saveLimit(key); }
                              if (e.key === "Escape") setEditingLimit(null);
                            }}
                          />
                        ) : canManage ? (
                          <span
                            className="font-mono cursor-pointer hover:underline"
                            onClick={() => { setEditingLimit(key.userName); setLimitValue(key.dailySpendLimit === "none" ? "" : key.dailySpendLimit); }}
                          >
                            {key.dailySpendLimit === "none" ? "—" : `$${key.dailySpendLimit}`}
                          </span>
                        ) : (
                          <span className="font-mono">{key.dailySpendLimit === "none" ? "—" : `$${key.dailySpendLimit}`}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Unattributed / deleted keys */}
              {keyStats["__unattributed__"] && (() => {
                const s = keyStats["__unattributed__"];
                const mtdCost = s.mtdInv ? perModelCost(s.models) : 0;
                if (!mtdCost && !s.mtdInv) return null;
                return (
                  <div className="rounded-lg border border-dashed p-4 space-y-3 opacity-60">
                    <span className="text-sm font-medium italic">Deleted keys</span>
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-xs">
                      <div>
                        <div className="text-muted-foreground mb-0.5">MTD cost</div>
                        <div className="font-mono">{mtdCost ? `$${mtdCost.toFixed(2)}` : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Input tokens</div>
                        <div className="font-mono">{s.mtdIn ? formatNumber(s.mtdIn) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Output tokens</div>
                        <div className="font-mono">{s.mtdOut ? formatNumber(s.mtdOut) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Cache read</div>
                        <div className="font-mono">{s.mtdCacheRead ? formatNumber(s.mtdCacheRead) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Cache write</div>
                        <div className="font-mono">{s.mtdCacheWrite ? formatNumber(s.mtdCacheWrite) : "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-0.5">Invocations</div>
                        <div className="font-mono">{s.mtdInv ? formatNumber(s.mtdInv) : "—"}</div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create key dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Configure how long an API key lasts. Use this key to make requests
              to the Amazon Bedrock API.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                API key name
              </label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-app-dev"
                pattern="^[a-zA-Z0-9_-]+$"
                required
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Alphanumeric characters, hyphens, and underscores only.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                API key expiration
              </label>
              <p className="text-[11px] text-muted-foreground mb-1.5">
                Set an expiration date to enhance security and limit exposure if
                the key is compromised.
              </p>
              <Select
                value={createExpiryPreset}
                onValueChange={handleExpiryChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_PRESETS.map((p) => (
                    <SelectItem key={p.days} value={String(p.days)}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {createExpiryPreset === "-1" && (
                <Input
                  type="number"
                  value={createCustomDays}
                  onChange={(e) => setCreateCustomDays(e.target.value)}
                  placeholder="Specify API key expiry in days"
                  min={1}
                  max={365}
                  className="mt-2"
                />
              )}
            </div>
            {createError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {createError}
              </div>
            )}
            <DialogFooter>
              <DialogClose className="inline-flex items-center justify-center rounded-lg h-8 px-3 text-sm font-medium border border-input bg-background hover:bg-muted transition-colors">
                Cancel
              </DialogClose>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete API key</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the key{" "}
              <strong>{deleteTarget?.friendlyName}</strong>? This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose className="inline-flex items-center justify-center rounded-lg h-8 px-3 text-sm font-medium border border-input bg-background hover:bg-muted transition-colors">
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteConfirm}
            >
              Delete key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
