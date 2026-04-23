import { createMemo, For, Show } from "solid-js"
import { readFileSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ─── Wake Subscription Imports (Task 6) ────────────────────
import {
  loadPreferences,
  savePreferences,
  applyPreset,
  addSubscription,
  removeSubscription,
  WAKE_PRESETS,
  PRESET_NAMES,
  type WakePreferences,
} from './wake-preferences'
import { updateDiscovery, getSubscriptionState } from './wake-listener'
import { getIdentityError } from './index'
import { WAKE_EVENT_TYPES } from './wake-types'

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

  // ─── /wake command (REQ-03, Task 6) ──────────────────────────
  const cwd = process.cwd()
  const allEventTypes = Object.values(WAKE_EVENT_TYPES) as string[]

  api.command.register(() => {
    const state = getSubscriptionState()
    const identityErr = getIdentityError()

    return [
      // /wake — show status (AC-09)
      {
        title: "Wake: Status",
        value: "wake.status",
        slash: { name: "wake", aliases: ["w"] },
        category: "Provider",
        onSelect() {
          const st = getSubscriptionState()
          const err = getIdentityError()
          const sub = st.subscribe ?? ['*']
          const subText = sub.includes('*') ? '* (all events)' : sub.join(', ') || '(none — quiet)'
          const ruleInfo = (() => {
            try {
              const { getSignalWireInstance } = require('./provider')
              const sw = getSignalWireInstance()
              if (!sw) return 'SignalWire: not loaded'
              const rules = sw.listRules()
              const enabled = rules.filter((r: any) => r.enabled).length
              const disabled = rules.length - enabled
              return `Rules: ${enabled} enabled, ${disabled} disabled (${rules.length} total)`
            } catch { return 'Rules: error reading' }
          })()
          const lines = [
            `🔔 Wake Status`,
            `Identity: ${st.memberName ?? 'unresolved'} (${st.memberType})`,
            `Member ID: ${st.memberId ?? 'none'}`,
            `Preset: ${st.subscribePreset ?? 'custom'}`,
            `Subscriptions: ${subText}`,
            ruleInfo,
            `Discovery: ${st.discoveryPath ? 'active' : 'not written'}`,
          ]
          if (err) lines.push(`⚠️ Identity error: ${err}`)
          api.ui.toast(lines.join('\n'))
          api.ui.dialog.clear()
        },
      },

      // /wake on <type> (AC-10)
      ...allEventTypes.map(t => ({
        title: `Wake: Subscribe to ${t}`,
        value: `wake.on.${t}`,
        slash: { name: `wake on ${t}` },
        category: "Provider",
        onSelect() {
          let prefs = loadPreferences(cwd) ?? { subscribe: getSubscriptionState().subscribe ?? ['*'] }
          prefs = addSubscription(prefs, t)
          savePreferences(prefs, cwd)
          updateDiscovery({ subscribe: prefs.subscribe, subscribePreset: prefs.preset })
          api.ui.toast(`🔔 Subscribed to: ${t}`)
          api.ui.dialog.clear()
        },
      })),

      // /wake off <type> (AC-11)
      ...allEventTypes.map(t => ({
        title: `Wake: Unsubscribe from ${t}`,
        value: `wake.off.${t}`,
        slash: { name: `wake off ${t}` },
        category: "Provider",
        onSelect() {
          let prefs = loadPreferences(cwd) ?? { subscribe: getSubscriptionState().subscribe ?? ['*'] }
          prefs = removeSubscription(prefs, t)
          savePreferences(prefs, cwd)
          updateDiscovery({ subscribe: prefs.subscribe, subscribePreset: prefs.preset })
          api.ui.toast(`🔇 Unsubscribed from: ${t}`)
          api.ui.dialog.clear()
        },
      })),

      // /wake preset <name> (AC-14-19)
      ...PRESET_NAMES.map(name => ({
        title: `Wake: Preset "${name}" (${WAKE_PRESETS[name].join(', ') || 'none'})`,
        value: `wake.preset.${name}`,
        slash: { name: `wake preset ${name}` },
        category: "Provider",
        onSelect() {
          const prefs = applyPreset(name)
          if (!prefs) { api.ui.toast(`❌ Unknown preset: ${name}`); return }
          savePreferences(prefs, cwd)
          updateDiscovery({ subscribe: prefs.subscribe, subscribePreset: name })
          api.ui.toast(`🔔 Preset "${name}" applied: ${prefs.subscribe.join(', ') || '(quiet)'}`)
          api.ui.dialog.clear()
        },
      })),

      // /wake save (AC-28)
      {
        title: "Wake: Save preferences",
        value: "wake.save",
        slash: { name: "wake save" },
        category: "Provider",
        onSelect() {
          const current = getSubscriptionState()
          const prefs: WakePreferences = {
            preset: current.subscribePreset,
            subscribe: current.subscribe ?? ['*'],
          }
          savePreferences(prefs, cwd)
          api.ui.toast('💾 Wake preferences saved')
          api.ui.dialog.clear()
        },
      },

      // /wake auth — retry identity resolution (GAP-1 fix)
      {
        title: "Wake: Retry identity resolution",
        value: "wake.auth",
        slash: { name: "wake auth" },
        category: "Provider",
        async onSelect() {
          api.ui.toast('🔄 Retrying OAuth identity resolution...')
          try {
            // Dynamic import to call the async identity resolver from index.ts
            // The actual resolveOAuthIdentity is module-private in index.ts,
            // so we re-implement the minimal check here (CN-04 exception: /wake auth explicitly does OAuth)
            const { readFileSync, existsSync } = require('fs')
            const { join } = require('path')
            const { homedir } = require('os')
            const authPath = join(homedir(), '.local', 'share', 'opencode', 'mcp-auth.json')
            if (!existsSync(authPath)) {
              api.ui.toast('❌ No mcp-auth.json found — run OAuth login first')
              api.ui.dialog.clear()
              return
            }
            const authData = JSON.parse(readFileSync(authPath, 'utf-8'))
            const accessToken = authData?.synqtask?.tokens?.accessToken
            const serverUrl = authData?.synqtask?.serverUrl ?? 'http://localhost:3747/mcp'
            if (!accessToken) {
              api.ui.toast('❌ No SynqTask access token in mcp-auth.json')
              api.ui.dialog.clear()
              return
            }
            // Call MCP whoami (matches index.ts pattern)
            const res = await fetch(serverUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'todo_session', arguments: { operations: { action: 'whoami' } } },
              }),
              signal: AbortSignal.timeout(5000),
            })
            if (!res.ok) {
              api.ui.toast(`❌ OAuth whoami failed: HTTP ${res.status}`)
              api.ui.dialog.clear()
              return
            }
            const text = await res.text()
            // Parse SSE response
            const dataLine = text.split('\n').find((l: string) => l.startsWith('data: '))
            const payload = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(text)
            const content = payload?.result?.content?.[0]?.text
            if (content) {
              const data = JSON.parse(content)
              const name = data?.actingAs?.name ?? data?.member?.name ?? 'unknown'
              const id = data?.actingAs?.id ?? data?.member?.id
              if (id) {
                api.ui.toast(`✅ Identity resolved: ${name} (${id})`)
              } else {
                api.ui.toast('⚠️ Whoami returned no member ID')
              }
            } else {
              api.ui.toast('⚠️ Unexpected whoami response format')
            }
          } catch (e: any) {
            api.ui.toast(`❌ Auth retry failed: ${e?.message ?? 'unknown error'}`)
          }
          api.ui.dialog.clear()
        },
      },

      // /wake rules — show signal-wire rules (AC-20)
      {
        title: "Wake: Show signal-wire rules",
        value: "wake.rules",
        slash: { name: "wake rules" },
        category: "Provider",
        onSelect() {
          try {
            // CONCERN-2 fix: check at runtime, not registration time
            const { getSignalWireInstance } = require('./provider')
            const sw = getSignalWireInstance()
            if (!sw) {
              api.ui.toast('⚠️ SignalWire not initialized yet')
              api.ui.dialog.clear()
              return
            }
            const rules = sw.listRules()
            if (rules.length === 0) {
              api.ui.toast('No signal-wire rules loaded')
            } else {
              const lines = rules.map((r: any) =>
                `${r.enabled ? '✅' : '❌'} ${r.id}${r.description ? ` — ${r.description}` : ''}`
              )
              api.ui.toast(`⚡ Signal-Wire Rules:\n${lines.join('\n')}`)
            }
          } catch (e: any) {
            api.ui.toast(`⚠️ Error listing rules: ${e?.message}`)
          }
          api.ui.dialog.clear()
        },
      },

      // /wake rule on <id> / /wake rule off <id> (AC-21-22)
      // Dynamic: generate commands from currently loaded rules
      ...(() => {
        try {
          const { getSignalWireInstance } = require('./provider')
          const sw = getSignalWireInstance()
          if (!sw) return []
          const rules = sw.listRules()
          const cmds: any[] = []
          for (const r of rules) {
            // Enable command
            cmds.push({
              title: `Wake: Enable rule "${r.id}"`,
              value: `wake.rule.on.${r.id}`,
              slash: { name: `wake rule on ${r.id}` },
              category: "Provider",
              onSelect() {
                const { getSignalWireInstance } = require('./provider')
                const sw = getSignalWireInstance()
                if (!sw) { api.ui.toast('⚠️ SignalWire not loaded'); api.ui.dialog.clear(); return }
                const ok = sw.toggleRule(r.id, true)
                if (ok) {
                  const overrides = api.kv.get('wakeRuleOverrides') ?? {}
                  overrides[r.id] = true
                  api.kv.set('wakeRuleOverrides', overrides)
                  api.ui.toast(`✅ Rule "${r.id}" enabled`)
                } else {
                  api.ui.toast(`❌ Rule "${r.id}" not found`)
                }
                api.ui.dialog.clear()
              },
            })
            // Disable command
            cmds.push({
              title: `Wake: Disable rule "${r.id}"`,
              value: `wake.rule.off.${r.id}`,
              slash: { name: `wake rule off ${r.id}` },
              category: "Provider",
              onSelect() {
                const { getSignalWireInstance } = require('./provider')
                const sw = getSignalWireInstance()
                if (!sw) { api.ui.toast('⚠️ SignalWire not loaded'); api.ui.dialog.clear(); return }
                const ok = sw.toggleRule(r.id, false)
                if (ok) {
                  const overrides = api.kv.get('wakeRuleOverrides') ?? {}
                  overrides[r.id] = false
                  api.kv.set('wakeRuleOverrides', overrides)
                  api.ui.toast(`❌ Rule "${r.id}" disabled`)
                } else {
                  api.ui.toast(`❌ Rule "${r.id}" not found`)
                }
                api.ui.dialog.clear()
              },
            })
          }
          return cmds
        } catch { return [] }
      })(),
    ]
  })

  // ─── Wake status badge slot (AC-29, AC-30, GAP-2 fix) ──────
  api.slots.register({
    order: 300,  // after voice (200)
    slots: {
      app() {
        const state = getSubscriptionState()
        const err = getIdentityError()
        const sub = state.subscribe ?? ['*']
        const count = sub.includes('*') ? '∞' : sub.length.toString()

        // GAP-2 fix: return actual JSX, not null
        if (err) {
          return <text>⚠️ wake</text>
        }
        if (sub.length === 0) {
          return <text>🔇</text>
        }
        return <text>🔔 {count}</text>
      },
    },
  })

  // ─── Restore rule toggles from session KV on init (AC-24) ──
  // Use setTimeout to give SignalWire time to initialize
  const _kvRestoreTimer = setTimeout(() => {
    try {
      const overrides = api.kv.get('wakeRuleOverrides') as Record<string, boolean> | undefined
      if (overrides) {
        const { getSignalWireInstance } = require('./provider')
        const sw = getSignalWireInstance()
        if (sw) {
          for (const [ruleId, enabled] of Object.entries(overrides)) {
            sw.toggleRule(ruleId, enabled)
          }
        }
      }
    } catch { /* non-fatal */ }
  }, 3000)

  // ─── Lifecycle cleanup (6E) ──────────────────────────────────
  api.lifecycle.onDispose(() => {
    clearTimeout(_kvRestoreTimer)
  })
}

export default {
  id: "opencode-claude-max",
  tui,
}
