import { createMemo, For, Show } from "solid-js"
import { readFileSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ─── Formatters ────────────────────────────────────────────

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return n.toLocaleString()
}

// ─── Stats Log Parsing ─────────────────────────────────────

interface KeepaliveEntry {
  ts: string
  dur: number
  read: number
  write: number
  pid: number
  ses: string
  idle: number
  quota: number
}

interface PidStats {
  pid: number
  count: number
  read: number
  write: number
  dur: { min: number; p50: number; max: number }
}

function tailFile(path: string, bytes: number): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(Math.min(size, bytes))
    const fd = require("fs").openSync(path, "r")
    try {
      require("fs").readSync(fd, buf, 0, buf.length, start)
    } finally {
      require("fs").closeSync(fd)
    }
    const text = buf.toString("utf8")
    // Drop partial first line if we didn't start at 0
    if (start > 0) {
      const nl = text.indexOf("\n")
      return nl >= 0 ? text.slice(nl + 1) : text
    }
    return text
  } catch {
    return ""
  }
}

function parseStats(): KeepaliveEntry[] {
  try {
    const path = join(homedir(), ".claude", "claude-max-stats.log")
    const raw = tailFile(path, 200 * 1024)
    if (!raw) return []
    const lines = raw.split("\n").filter((l) => l.includes("type=keepalive"))
    return lines.map((line) => {
      const ts = line.match(/^\[([^\]]+)\]/)?.[1] ?? ""
      const dur = parseInt(line.match(/dur=(\d+)ms/)?.[1] ?? "0", 10)
      const read = parseInt(line.match(/cacheRead=(\d+)/)?.[1] ?? "0", 10)
      const write = parseInt(line.match(/cacheWrite=(\d+)/)?.[1] ?? "0", 10)
      const pid = parseInt(line.match(/pid=(\d+)/)?.[1] ?? "0", 10)
      const ses = line.match(/ses=(\S+)/)?.[1] ?? ""
      const idle = parseInt(line.match(/idle=(\d+)s/)?.[1] ?? "0", 10)
      const quota = parseInt(line.match(/quota=(\d+)/)?.[1] ?? "0", 10)
      return { ts, dur, read, write, pid, ses, idle, quota }
    })
  } catch {
    return []
  }
}

function groupByPid(entries: KeepaliveEntry[]): PidStats[] {
  const map = new Map<number, KeepaliveEntry[]>()
  for (const e of entries) {
    if (!e.pid) continue
    const arr = map.get(e.pid) ?? []
    arr.push(e)
    map.set(e.pid, arr)
  }
  const result: PidStats[] = []
  for (const [pid, items] of map) {
    const durs = items.map((i) => i.dur).sort((a, b) => a - b)
    result.push({
      pid,
      count: items.length,
      read: items.reduce((s, i) => s + i.read, 0),
      write: items.reduce((s, i) => s + i.write, 0),
      dur: {
        min: durs[0] ?? 0,
        p50: durs[Math.floor(durs.length / 2)] ?? 0,
        max: durs[durs.length - 1] ?? 0,
      },
    })
  }
  return result.sort((a, b) => b.count - a.count)
}

function loadConfig(): Record<string, any> | null {
  try {
    const raw = readFileSync(join(homedir(), ".claude", "keepalive.json"), "utf8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ─── PART 1: Sidebar CacheView ─────────────────────────────

function CacheView(props: { api: any; session_id: string }) {
  const theme = () => props.api.theme.current
  const msgs = createMemo(() => props.api.state.session.messages(props.session_id))

  const stats = createMemo(() => {
    let read = 0
    let write = 0
    let input = 0
    let lastProvider = ""
    let lastModel = ""

    for (const msg of msgs()) {
      if (msg.role !== "assistant") continue
      read += msg.tokens?.cache?.read ?? 0
      write += msg.tokens?.cache?.write ?? 0
      input += msg.tokens?.input ?? 0
      lastProvider = msg.providerID ?? lastProvider
      lastModel = msg.modelID ?? lastModel
    }

    const total = read + write + input
    const ratio = total > 0 ? (read / total) * 100 : 0

    let savings = 0
    let hasCost = false
    if (lastProvider && lastModel) {
      const provider = props.api.state.provider.find((p: any) => p.id === lastProvider)
      const cost = provider?.models?.[lastModel]?.cost
      if (cost && cost.input > 0) {
        hasCost = true
        const perToken = cost.input - (cost.cache?.read ?? 0)
        savings = (read * perToken) / 1_000_000
      }
    }

    return { read, write, input, ratio, savings, hasCost, hasData: read + write > 0 }
  })

  return (
    <Show when={stats().hasData}>
      <box>
        <text fg={theme().text}>
          <b>Cache</b>
        </text>
        <text fg={theme().textMuted}>
          {fmt(stats().read)} read / {fmt(stats().write)} write
        </text>
        <text fg={theme().textMuted}>{stats().ratio.toFixed(1)}% hit ratio</text>
        <text fg={theme().textMuted}>
          {stats().hasCost ? `${money.format(stats().savings)} saved` : "N/A savings"}
        </text>
      </box>
    </Show>
  )
}

// ─── PART 2: /cache Slash Command + CacheDialog ────────────

function CacheDialog(props: { api: any }) {
  const theme = () => props.api.theme.current

  const session = createMemo(() => {
    const id = props.api.state.session.current
    if (!id) return null
    const msgs = props.api.state.session.messages(id)
    let read = 0
    let write = 0
    let input = 0
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue
      read += msg.tokens?.cache?.read ?? 0
      write += msg.tokens?.cache?.write ?? 0
      input += msg.tokens?.input ?? 0
    }
    const total = read + write + input
    const ratio = total > 0 ? (read / total) * 100 : 0
    return { read, write, input, ratio, count: msgs.filter((m: any) => m.role === "assistant").length }
  })

  const keepalive = createMemo(() => {
    const entries = parseStats()
    const pids = groupByPid(entries)
    const cfg = loadConfig()
    const total = entries.length
    const totalRead = entries.reduce((s, e) => s + e.read, 0)
    const totalWrite = entries.reduce((s, e) => s + e.write, 0)
    return { entries: total, pids, cfg, totalRead, totalWrite }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Cache Diagnostics</b>
      </text>
      <text fg={theme().text}>{""}</text>

      <Show when={session()}>
        <text fg={theme().text}>
          <b>Session Cache</b>
        </text>
        <text fg={theme().textMuted}>
          Messages: {session()!.count} | Read: {fmt(session()!.read)} | Write: {fmt(session()!.write)}
        </text>
        <text fg={theme().textMuted}>
          Input: {fmt(session()!.input)} | Hit ratio: {session()!.ratio.toFixed(1)}%
        </text>
        <text fg={theme().text}>{""}</text>
      </Show>

      <Show when={keepalive().entries > 0}>
        <text fg={theme().text}>
          <b>Keepalive Stats</b> ({keepalive().entries} pings)
        </text>
        <text fg={theme().textMuted}>
          Total read: {fmt(keepalive().totalRead)} | Total write: {fmt(keepalive().totalWrite)}
        </text>
        <text fg={theme().text}>{""}</text>

        <text fg={theme().text}>
          <b>Active Sessions (by PID)</b>
        </text>
        <For each={keepalive().pids.slice(0, 10)}>
          {(p) => (
            <text fg={theme().textMuted}>
              PID {p.pid}: {p.count} pings, {fmt(p.read)} cached | dur {p.dur.min}/{p.dur.p50}/{p.dur.max}ms
            </text>
          )}
        </For>
        <text fg={theme().text}>{""}</text>
      </Show>

      <Show when={keepalive().cfg}>
        <text fg={theme().text}>
          <b>Keepalive Config</b>
        </text>
        <text fg={theme().textMuted}>
          {JSON.stringify(keepalive().cfg, null, 2)
            .split("\n")
            .slice(0, 8)
            .join("\n")}
        </text>
      </Show>

      <Show when={!session() && keepalive().entries === 0}>
        <text fg={theme().textMuted}>No cache data available yet.</text>
      </Show>
    </box>
  )
}

// ─── PART 3: Plugin Registration ───────────────────────────

const tui = async (api: any) => {
  // Sidebar section
  api.slots.register({
    order: 110,
    slots: {
      sidebar_content(_ctx: any, props: { session_id: string }) {
        return <CacheView api={api} session_id={props.session_id} />
      },
    },
  })

  // /cache slash command
  api.command.register(() => [
    {
      title: "Cache Stats",
      value: "cache.stats",
      slash: { name: "cache", aliases: ["cs"] },
      category: "Provider",
      onSelect() {
        api.ui.dialog.replace(() => <CacheDialog api={api} />)
      },
    },
  ])
}

export default {
  id: "opencode-claude-max",
  tui,
}
