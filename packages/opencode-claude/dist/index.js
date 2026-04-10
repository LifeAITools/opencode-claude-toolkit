// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = import.meta.require;

// wake-types.ts
import { homedir } from "os";
import { join } from "path";
var DISCOVERY_DIR, WARM_CHANNEL_TTL_MS, WAKE_EVENT_TYPES, EVENT_TYPES;
var init_wake_types = __esm(() => {
  DISCOVERY_DIR = join(homedir(), ".opencode", "wake");
  WARM_CHANNEL_TTL_MS = 5 * 60 * 1000;
  WAKE_EVENT_TYPES = {
    TASK_ASSIGNED: "task_assigned",
    CHANNEL_MESSAGE: "channel_message",
    COMMENT_ADDED: "comment_added",
    DELEGATION_RECEIVED: "delegation_received",
    STATUS_CHANGED: "status_changed"
  };
  EVENT_TYPES = {
    PRE_TOOL_USE: "PreToolUse",
    POST_TOOL_USE: "PostToolUse",
    USER_PROMPT_SUBMIT: "UserPromptSubmit",
    STOP: "Stop",
    SUBAGENT_START: "SubagentStart",
    SUBAGENT_STOP: "SubagentStop",
    SESSION_START: "SessionStart",
    SESSION_END: "SessionEnd",
    PERMISSION_REQUEST: "PermissionRequest",
    EXTERNAL_EVENT: "ExternalEvent",
    WEBHOOK_EVENT: "WebhookEvent",
    TIMER_EVENT: "TimerEvent"
  };
});

// wake-listener.ts
var exports_wake_listener = {};
__export(exports_wake_listener, {
  stopWakeListener: () => stopWakeListener,
  startWakeListener: () => startWakeListener,
  resolveCurrentDepth: () => resolveCurrentDepth,
  helperStarted: () => helperStarted,
  helperFinished: () => helperFinished,
  getSpawnTotal: () => getSpawnTotal,
  getSpawnActive: () => getSpawnActive,
  getCurrentDepth: () => getCurrentDepth,
  getAgentIdentity: () => getAgentIdentity,
  checkSpawnAllowed: () => checkSpawnAllowed,
  _parentSessionId: () => _parentSessionId,
  _parentMemberId: () => _parentMemberId,
  _agentIdentity: () => _agentIdentity
});
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, appendFileSync, renameSync } from "fs";
import { join as join2 } from "path";
import { homedir as homedir2 } from "os";
function dbg(...args) {
  if (!DEBUG)
    return;
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [wake-listener] ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}
`);
  } catch {}
}
function markChannelWarm(channelId) {
  const existing = warmChannels.get(channelId);
  warmChannels.set(channelId, {
    lastReply: Date.now(),
    messageCount: (existing?.messageCount ?? 0) + 1
  });
}
function isChannelWarm(channelId) {
  const entry = warmChannels.get(channelId);
  if (!entry)
    return false;
  if (Date.now() - entry.lastReply > WARM_CHANNEL_TTL_MS) {
    warmChannels.delete(channelId);
    return false;
  }
  return true;
}
function getSpawnTotal() {
  return _spawnTotal;
}
function getSpawnActive() {
  const now = Date.now();
  while (_activeHelperTimestamps.length > 0 && now - _activeHelperTimestamps[0] > HELPER_TIMEOUT_MS) {
    _activeHelperTimestamps.shift();
  }
  return _activeHelperTimestamps.length;
}
function helperStarted() {
  _spawnTotal++;
  _activeHelperTimestamps.push(Date.now());
}
function helperFinished() {
  _activeHelperTimestamps.shift();
}
function getAgentIdentity() {
  return _agentIdentity;
}
function getCurrentDepth() {
  return _currentDepth;
}
async function resolveCurrentDepth(serverUrl, sessionId) {
  if (_currentDepth !== null)
    return _currentDepth;
  let depth = 0;
  let currentId = sessionId;
  try {
    for (let i = 0;i < 10; i++) {
      const res = await fetch(`${serverUrl}/session/${currentId}`, {
        signal: AbortSignal.timeout(2000)
      });
      if (!res.ok)
        break;
      const session = await res.json();
      if (!session.parent_id && !session.parentId)
        break;
      depth++;
      currentId = session.parent_id ?? session.parentId;
    }
  } catch {
    dbg("resolveCurrentDepth: failed, assuming 0");
  }
  _currentDepth = depth;
  dbg(`resolveCurrentDepth: depth=${depth}`);
  return depth;
}
function checkSpawnAllowed(identity, currentDepth, activeHelpers) {
  const budget = identity.budget ?? { maxSpawnDepth: 2, maxSubagents: 5 };
  const maxConcurrent = identity._maxConcurrent ?? budget.maxSubagents;
  if (activeHelpers >= maxConcurrent) {
    return {
      allowed: false,
      reason: [
        `\u26A0\uFE0F \u041B\u0438\u043C\u0438\u0442 \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u044B\u0445 \u0445\u0435\u043B\u043F\u0435\u0440\u043E\u0432: ${activeHelpers}/${maxConcurrent} \u0430\u043A\u0442\u0438\u0432\u043D\u044B.`,
        `\u0414\u043E\u0436\u0434\u0438\u0441\u044C \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u044F \u0442\u0435\u043A\u0443\u0449\u0438\u0445 \u0445\u0435\u043B\u043F\u0435\u0440\u043E\u0432, \u043F\u043E\u0442\u043E\u043C \u0432\u044B\u0437\u044B\u0432\u0430\u0439 \u043D\u043E\u0432\u044B\u0445.`,
        `\u0414\u043B\u044F \u0434\u0435\u043B\u0435\u0433\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u044F \u0440\u0430\u0431\u043E\u0442\u044B \u043A\u043E\u043B\u043B\u0435\u0433\u0430\u043C \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439 SynqTask:`,
        `  todo_tasks({action:"delegate", task_id:"...", to_member_id:"..."})`
      ].join(`
`),
      depth: currentDepth,
      maxDepth: budget.maxSpawnDepth,
      active: activeHelpers,
      maxConcurrent
    };
  }
  return {
    allowed: true,
    depth: currentDepth,
    maxDepth: budget.maxSpawnDepth,
    active: activeHelpers,
    maxConcurrent
  };
}
async function fetchIdentity(memberId, synqtaskUrl, timeoutMs) {
  const url = synqtaskUrl ?? process.env.SYNQTASK_API_URL ?? "http://localhost:3747";
  let bearerToken = process.env.SYNQTASK_BEARER_TOKEN ?? "";
  if (!bearerToken) {
    try {
      const authPath = join2(homedir2(), ".local", "share", "opencode", "mcp-auth.json");
      const authData = JSON.parse(readFileSync(authPath, "utf-8"));
      bearerToken = authData?.synqtask?.tokens?.accessToken ?? "";
    } catch {}
  }
  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    };
    if (bearerToken)
      headers["Authorization"] = `Bearer ${bearerToken}`;
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "todo_members",
          arguments: { operations: { action: "get_role_prompt", member_id: memberId } }
        }
      }),
      signal: AbortSignal.timeout(timeoutMs ?? 3000)
    });
    if (!res.ok) {
      dbg(`fetchIdentity: HTTP ${res.status}`);
      return parseAgentsMd();
    }
    const text = await res.text();
    const dataLine = text.split(`
`).find((l) => l.startsWith("data: "));
    if (!dataLine) {
      dbg("fetchIdentity: no data line in response");
      return parseAgentsMd();
    }
    const rpcResult = JSON.parse(dataLine.substring(6));
    const content = rpcResult?.result?.content?.[0]?.text;
    if (!content) {
      dbg("fetchIdentity: empty content");
      return parseAgentsMd();
    }
    const parsed = JSON.parse(content);
    const result = parsed?.results?.[0]?.result ?? parsed;
    const identity = {
      memberId,
      name: result.displayName ?? result.memberName ?? memberId,
      displayName: result.displayName,
      roleName: result.role?.name ?? null,
      rolePrompt: result.role?.systemPrompt ?? null,
      teamName: result.team?.name ?? null,
      teamPlaybook: result.team?.purpose ?? null,
      teammates: [],
      fetchedAt: Date.now()
    };
    if (result.team?.id) {
      try {
        const teamRes = await fetch(`${url}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "todo_teams", arguments: { operations: { action: "members", team_id: result.team.id } } }
          }),
          signal: AbortSignal.timeout(timeoutMs ?? 3000)
        });
        if (teamRes.ok) {
          const teamText = await teamRes.text();
          const teamDataLine = teamText.split(`
`).find((l) => l.startsWith("data: "));
          if (teamDataLine) {
            const teamRpc = JSON.parse(teamDataLine.substring(6));
            const teamContent = teamRpc?.result?.content?.[0]?.text;
            if (teamContent) {
              const teamParsed = JSON.parse(teamContent);
              const members = teamParsed?.results?.[0]?.result ?? [];
              const teammateIds = members.map((m) => m.memberId ?? m.id).filter((id) => id && id !== memberId);
              for (const tid of teammateIds) {
                try {
                  const mRes = await fetch(`${url}/mcp`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                      jsonrpc: "2.0",
                      id: 3,
                      method: "tools/call",
                      params: { name: "todo_members", arguments: { operations: { action: "get_role_prompt", member_id: tid } } }
                    }),
                    signal: AbortSignal.timeout(timeoutMs ?? 3000)
                  });
                  if (mRes.ok) {
                    const mText = await mRes.text();
                    const mLine = mText.split(`
`).find((l) => l.startsWith("data: "));
                    if (mLine) {
                      const mRpc = JSON.parse(mLine.substring(6));
                      const mContent = mRpc?.result?.content?.[0]?.text;
                      if (mContent) {
                        const mData = JSON.parse(mContent);
                        const member = mData?.results?.[0]?.result ?? mData;
                        identity.teammates.push({
                          name: member.displayName ?? member.name ?? tid.slice(0, 8),
                          roleName: member.role?.name ?? null
                        });
                      }
                    }
                  }
                } catch {}
              }
            }
          }
        }
      } catch (e) {
        dbg(`fetchIdentity: team fetch failed: ${e?.message}`);
      }
    }
    if (result.role?.metadata) {
      const md = result.role.metadata;
      const maxConcurrent = parseInt(md.maxConcurrentHelpers ?? md.maxHelpers ?? md.maxSubagents ?? "5", 10) || 5;
      identity.budget = {
        maxSpawnDepth: parseInt(md.maxHelperDepth ?? md.maxSpawnDepth ?? "2", 10) || 2,
        maxSubagents: maxConcurrent
      };
      identity._maxConcurrent = maxConcurrent;
    }
    dbg(`fetchIdentity: OK name=${identity.name} role=${identity.roleName} team=${identity.teamName} teammates=${identity.teammates.length} budget=${identity.budget ? `depth=${identity.budget.maxSpawnDepth},subs=${identity.budget.maxSubagents}` : "none"} playbook=${identity.teamPlaybook ? "yes" : "no"}`);
    return identity;
  } catch (e) {
    dbg(`fetchIdentity: failed: ${e?.message}`);
    return parseAgentsMd();
  }
}
function parseAgentsMd() {
  try {
    const agentsMdPath = join2(process.cwd(), "AGENTS.md");
    const content = readFileSync(agentsMdPath, "utf-8");
    const nameMatch = content.match(/^#\s+(?:Agent\s+)?(.+)/im);
    const name = nameMatch?.[1]?.trim() ?? null;
    const roleMatch = content.match(/##\s+(?:\u0420\u043E\u043B\u044C|Role)[^\n]*\n([\s\S]*?)(?=\n##|\n$)/i);
    const rolePrompt = roleMatch?.[1]?.trim() ?? null;
    const idMatch = content.match(/Member ID.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const memberId = idMatch?.[1] ?? null;
    if (!name) {
      dbg("parseAgentsMd: no name found");
      return null;
    }
    dbg(`parseAgentsMd: fallback OK name=${name}`);
    return {
      memberId: memberId ?? "unknown",
      name,
      roleName: null,
      rolePrompt,
      teamName: null,
      teamPlaybook: null,
      teammates: [],
      fetchedAt: Date.now()
    };
  } catch {
    dbg("parseAgentsMd: file not found or parse error");
    return null;
  }
}
function formatWakeMessage(event, identity) {
  const p = event.payload;
  const esc = (s) => s.replace(/"/g, "&quot;");
  const tag = `<system-reminder type="wake" source="${esc(event.source)}" priority="${event.priority}" event-id="${esc(event.eventId)}">`;
  const end = `</system-reminder>`;
  let identityBlock = "";
  if (identity) {
    const teammatesList = identity.teammates.length > 0 ? identity.teammates.map((t) => `${t.name} (${t.roleName ?? "?"})`).join(", ") : "none";
    const identityLines = [
      `<agent-identity name="${identity.name}" role="${identity.roleName ?? "unassigned"}" team="${identity.teamName ?? "none"}">`,
      `You are ${identity.name}. ${identity.rolePrompt ?? "No role assigned."}`,
      `Team: ${identity.teamName ?? "none"}. Teammates: ${teammatesList}.`
    ];
    if (identity.budget) {
      identityLines.push(`Helpers: max ${identity.budget.maxSubagents} concurrent, depth ${identity.budget.maxSpawnDepth}. \u0414\u0435\u043B\u0435\u0433\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u043A\u043E\u043B\u043B\u0435\u0433\u0430\u043C: SynqTask todo_tasks delegate.`);
    }
    identityLines.push(`</agent-identity>`);
    identityBlock = identityLines.join(`
`);
  }
  let body;
  switch (event.type) {
    case WAKE_EVENT_TYPES.CHANNEL_MESSAGE: {
      const chId = p.channel_id ?? p.channelId ?? "";
      const sendName = p.sender_name ?? p.senderName ?? p.senderId ?? "unknown";
      const text = p.text ?? "(no text)";
      const warm = isChannelWarm(chId);
      if (warm) {
        const preview = text.length > 120 ? text.slice(0, 120) + "\u2026" : text;
        body = `**${sendName}** in channel \`${chId}\`:
> ${preview}
Reply: \`todo_channels({action:"send", channel_id:"${chId}", text:"..."})\``;
      } else {
        body = [
          `## Channel Message from ${sendName}`,
          `> ${text}`,
          `**Channel:** \`${chId}\``,
          `Reply: \`todo_channels({action:"send", channel_id:"${chId}", text:"YOUR REPLY"})\``,
          `Read history: \`todo_channels({action:"read", channel_id:"${chId}", limit:5})\``
        ].join(`
`);
      }
      markChannelWarm(chId);
      break;
    }
    case WAKE_EVENT_TYPES.TASK_ASSIGNED: {
      const taskId = p.task_id ?? p.taskId ?? p.entityId ?? "";
      body = [
        `## Task Assigned: ${p.title ?? "Unknown"}`,
        taskId ? `Task: \`${taskId}\`` : "",
        p.description ? `> ${p.description}` : "",
        `Accept: \`todo_tasks({action:"set_status", task_id:"${taskId}", status:"started"})\``,
        `Details: \`todo_tasks({action:"show", task_id:"${taskId}"})\``
      ].filter(Boolean).join(`
`);
      break;
    }
    case WAKE_EVENT_TYPES.COMMENT_ADDED: {
      const entityId = p.entity_id ?? p.entityId ?? "";
      body = [
        `## Comment on ${p.title ?? entityId}`,
        `From: ${p.actor_name ?? p.actorId ?? "unknown"}`,
        `Read: \`todo_comments({action:"list", task_id:"${entityId}"})\``
      ].join(`
`);
      break;
    }
    case WAKE_EVENT_TYPES.DELEGATION_RECEIVED: {
      const taskId = p.task_id ?? p.taskId ?? p.entityId ?? "";
      body = [
        `## Delegation: ${p.title ?? "Unknown"}`,
        `From: ${p.delegator ?? p.delegated_by ?? p.fromId ?? "unknown"}`,
        `Accept: \`todo_tasks({action:"accept_delegation", task_id:"${taskId}"})\``,
        `Details: \`todo_tasks({action:"show", task_id:"${taskId}"})\``
      ].join(`
`);
      break;
    }
    case WAKE_EVENT_TYPES.STATUS_CHANGED: {
      const taskId = p.task_id ?? p.taskId ?? p.entityId ?? "";
      const status = p.status ?? p.changes?.status?.to ?? "?";
      const title = p.title ?? taskId;
      body = [
        `## Task Status: ${title} \u2192 ${status}`,
        `View: \`todo_tasks({action:"show", task_id:"${taskId}"})\``
      ].join(`
`);
      break;
    }
    default:
      body = `Event: ${event.type}
${JSON.stringify(p, null, 2)}`;
  }
  return identityBlock ? `${identityBlock}
${tag}
${body}
${end}` : `${tag}
${body}
${end}`;
}
async function isAgentBusy(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/session/status`);
    if (!res.ok)
      return false;
    const data = await res.json();
    return data?.sessions?.some?.((s) => s.status === "streaming" || s.status === "busy") ?? false;
  } catch {
    return false;
  }
}
async function resolveSessionId(serverUrl, sessionId) {
  if (_cachedSessionId && _cachedSessionId !== "unknown")
    return _cachedSessionId;
  if (sessionId && sessionId !== "unknown") {
    _cachedSessionId = sessionId;
    return sessionId;
  }
  if (_discoveryPath) {
    try {
      const disc = JSON.parse(readFileSync(_discoveryPath, "utf-8"));
      if (disc.sessionId && disc.sessionId !== "unknown") {
        _cachedSessionId = disc.sessionId;
        dbg(`resolveSessionId from discovery file: ${_cachedSessionId}`);
        return _cachedSessionId;
      }
    } catch {}
  }
  if (_agentDirectory && serverUrl) {
    try {
      const res = await fetch(`${serverUrl}/session?limit=20`);
      if (res.ok) {
        const sessions = await res.json();
        const match = sessions.find((s) => s.directory === _agentDirectory);
        if (match) {
          _cachedSessionId = match.id;
          dbg(`resolveSessionId by directory ${_agentDirectory}: ${_cachedSessionId}`);
          if (_discoveryPath) {
            try {
              const disc = JSON.parse(readFileSync(_discoveryPath, "utf-8"));
              disc.sessionId = _cachedSessionId;
              writeFileSync(_discoveryPath, JSON.stringify(disc));
            } catch {}
          }
          return _cachedSessionId;
        }
      }
    } catch (e) {
      dbg(`resolveSessionId by directory failed: ${e?.message}`);
    }
  }
  dbg("resolveSessionId: no session ID yet, events will queue");
  return null;
}
async function injectWakeEvent(event, serverUrl, sessionId) {
  const resolvedSessionId = await resolveSessionId(serverUrl, sessionId);
  if (!resolvedSessionId) {
    dbg("inject: no valid sessionId");
    return false;
  }
  const text = formatWakeMessage(event, _agentIdentity);
  const url = `${serverUrl}/session/${resolvedSessionId}/message`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        noReply: false,
        parts: [{ type: "text", text }]
      })
    });
    if (res.ok) {
      dbg(`inject OK: session=${resolvedSessionId}`);
      return true;
    }
    dbg(`inject failed: ${res.status}`);
    return false;
  } catch (e) {
    dbg(`inject error: ${e?.message}`);
    return false;
  }
}
async function startWakeListener(config) {
  _agentDirectory = process.cwd();
  if (config.memberId) {
    try {
      _agentIdentity = await fetchIdentity(config.memberId, config.synqtaskUrl, config.identityFetchTimeoutMs);
      dbg(`identity: ${_agentIdentity?.name ?? "null"} role=${_agentIdentity?.roleName ?? "none"} team=${_agentIdentity?.teamName ?? "none"} teammates=${_agentIdentity?.teammates?.length ?? 0}`);
    } catch (e) {
      dbg(`identity fetch failed (non-fatal): ${e?.message}`);
    }
  }
  if (_agentIdentity?.teamPlaybook) {
    try {
      const playbookSessionId = await resolveSessionId(config.serverUrl, config.sessionId);
      if (playbookSessionId) {
        const playbookText = `<team-playbook team="${_agentIdentity.teamName ?? "unknown"}">
${_agentIdentity.teamPlaybook}
</team-playbook>`;
        await fetch(`${config.serverUrl}/session/${playbookSessionId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            noReply: true,
            parts: [{ type: "text", text: playbookText }]
          })
        });
        dbg("playbook injected at session start");
      }
    } catch (e) {
      dbg(`playbook injection failed (non-fatal): ${e?.message}`);
    }
  }
  const token = crypto.randomUUID();
  const queue = [];
  const maxQueue = config.maxQueueSize ?? MAX_QUEUE_DEFAULT;
  const retryInterval = config.busyRetryInterval ?? BUSY_RETRY_INTERVAL_DEFAULT;
  async function handleRequest(req) {
    try {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({
          alive: true,
          sessionId: config.sessionId,
          uptime: Math.floor((Date.now() - STARTUP_TS) / 1000),
          queueSize: queue.length
        });
      }
      if (req.method === "POST" && url.pathname === "/wake") {
        return await handleWake(req);
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      dbg("request handler error:", e?.message);
      return Response.json({ accepted: false, error: "internal error" }, { status: 500 });
    }
  }
  async function handleWake(req) {
    const reqToken = req.headers.get("X-Wake-Token");
    if (reqToken !== token) {
      dbg("wake: auth failed");
      return Response.json({ accepted: false, error: "unauthorized" }, { status: 401 });
    }
    let event;
    try {
      event = await req.json();
    } catch {
      return Response.json({ accepted: false, error: "invalid JSON" }, { status: 400 });
    }
    if (!event.eventId || !event.type || !event.source) {
      return Response.json({ accepted: false, error: "missing required fields" }, { status: 400 });
    }
    dbg(`wake: received ${event.type} from ${event.source} [${event.priority}]`);
    const signalWireInstance = config.signalWire ?? config.signalWireResolver?.() ?? null;
    if (signalWireInstance) {
      try {
        const result = await signalWireInstance.evaluateExternal(event);
        if (result.matched) {
          dbg(`wake: engine handled event ${event.eventId} (wake=${result.wakeTriggered}, actions=${result.actionsExecuted.length})`);
          return Response.json({
            accepted: true,
            engineHandled: true,
            wakeTriggered: result.wakeTriggered,
            actionsExecuted: result.actionsExecuted.length
          });
        }
        dbg("no matching rule for event, falling back to direct injection");
      } catch (e) {
        dbg("engine evaluateExternal error, falling back:", e?.message);
      }
    }
    const busy = await isAgentBusy(config.serverUrl);
    if (busy) {
      if (queue.length >= maxQueue) {
        const dropped = queue.shift();
        dbg(`wake: queue full, dropped oldest event ${dropped?.eventId}`);
      }
      queue.push(event);
      const pos = queue.length;
      dbg(`wake: agent busy, queued at position ${pos}`);
      return Response.json({ accepted: true, queued: true, queuePosition: pos });
    }
    const injected = await injectWakeEvent(event, config.serverUrl, config.sessionId);
    if (injected) {
      dbg(`wake: injected ${event.eventId}`);
      return Response.json({ accepted: true, queued: false });
    }
    if (queue.length >= maxQueue) {
      queue.shift();
    }
    queue.push(event);
    dbg(`wake: inject failed, queued at position ${queue.length}`);
    return Response.json({ accepted: true, queued: true, queuePosition: queue.length });
  }
  const server = Bun.serve({
    port: config.port ?? 0,
    fetch: handleRequest
  });
  const actualPort = server.port;
  dbg(`started on port ${actualPort} for session ${config.sessionId}`);
  if (config.memberId) {
    const discoveryPath = join2(DISCOVERY_DIR, `${process.pid}-${config.sessionId}.json`);
    try {
      mkdirSync(DISCOVERY_DIR, { recursive: true });
      const discoveryData = {
        port: actualPort,
        token,
        sessionId: config.sessionId,
        memberId: config.memberId,
        memberName: _agentIdentity?.name ?? config.memberId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: "http",
        parentMemberId: _parentMemberId,
        parentSessionId: _parentSessionId,
        spawnDepth: _currentDepth ?? 0,
        maxSpawnDepth: _agentIdentity?.budget?.maxSpawnDepth ?? 2,
        maxSubagents: _agentIdentity?.budget?.maxSubagents ?? 5
      };
      const tmpPath = discoveryPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(discoveryData));
      renameSync(tmpPath, discoveryPath);
      _discoveryPath = discoveryPath;
      dbg(`discovery file written: ${discoveryPath} depth=${discoveryData.spawnDepth} parent=${discoveryData.parentMemberId ?? "ROOT"}`);
    } catch (e) {
      dbg("discovery file write failed:", e?.message);
    }
  } else {
    dbg("skipping discovery file: no memberId configured (non-agent session)");
  }
  const drainInterval = setInterval(async () => {
    if (queue.length === 0)
      return;
    try {
      if (await isAgentBusy(config.serverUrl))
        return;
      const event = queue.shift();
      const ok = await injectWakeEvent(event, config.serverUrl, config.sessionId);
      dbg(`drain: ${event.eventId} ${ok ? "injected" : "failed"}`);
    } catch (e) {
      dbg("drain error:", e?.message);
    }
  }, retryInterval * 1000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned)
      return;
    cleaned = true;
    clearInterval(drainInterval);
    try {
      if (_discoveryPath)
        unlinkSync(_discoveryPath);
    } catch {}
    try {
      server.stop();
    } catch {}
    dbg("cleanup complete");
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  return {
    port: actualPort,
    token,
    server,
    stop: cleanup
  };
}
function stopWakeListener(handle) {
  try {
    handle.stop();
  } catch (e) {
    dbg("stopWakeListener error:", e?.message);
  }
}
var DEBUG, LOG_FILE, MAX_QUEUE_DEFAULT = 50, BUSY_RETRY_INTERVAL_DEFAULT = 5, STARTUP_TS, warmChannels, _agentIdentity = null, _spawnTotal = 0, _currentDepth = null, _inheritedDepth, _parentMemberId, _parentSessionId, HELPER_TIMEOUT_MS = 60000, _activeHelperTimestamps, _cachedSessionId = null, _discoveryPath = null, _agentDirectory = null;
var init_wake_listener = __esm(() => {
  init_wake_types();
  DEBUG = process.env.WAKE_LISTENER_DEBUG !== "0";
  LOG_FILE = join2(homedir2(), ".claude", "wake-listener-debug.log");
  STARTUP_TS = Date.now();
  warmChannels = new Map;
  _inheritedDepth = parseInt(process.env.__SPAWN_DEPTH ?? "", 10);
  if (!isNaN(_inheritedDepth) && _inheritedDepth >= 0) {
    _currentDepth = _inheritedDepth;
    dbg(`spawn depth inherited from parent: ${_inheritedDepth}`);
  }
  _parentMemberId = process.env.__PARENT_MEMBER_ID ?? null;
  _parentSessionId = process.env.__PARENT_SESSION_ID ?? null;
  _activeHelperTimestamps = [];
});

// signal-wire-actions.ts
async function dispatchActions(actions, ctx) {
  if (process.env.SIGNAL_WIRE_ACTIVE === "1") {
    dbg2("Re-entrancy detected \u2014 skipping all actions");
    return [];
  }
  const sorted = [...actions].sort((a, b) => {
    const ai = ACTION_ORDER.indexOf(a.type);
    const bi = ACTION_ORDER.indexOf(b.type);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const results = [];
  process.env.SIGNAL_WIRE_ACTIVE = "1";
  try {
    for (const action of sorted) {
      try {
        const result = await executeAction(action, ctx);
        results.push(result);
      } catch (e) {
        dbg2(`action ${action.type} error:`, e?.message);
        results.push({ type: action.type, success: false, error: e?.message ?? "unknown" });
      }
    }
  } finally {
    delete process.env.SIGNAL_WIRE_ACTIVE;
  }
  return results;
}
async function executeAction(action, ctx) {
  switch (action.type) {
    case "block":
      return executeBlock(action, ctx);
    case "hint":
      return executeHint(action, ctx);
    case "exec":
      return executeExec(action, ctx);
    case "wake":
      return executeWake(action, ctx);
    case "respond":
      return executeRespond(action, ctx);
    case "notify":
      return executeNotify(action, ctx);
    case "audit":
      return executeAudit(action, ctx);
    default:
      dbg2(`unknown action type: ${action.type}`);
      return { type: action.type, success: false, error: "unknown_action_type" };
  }
}
function executeBlock(action, ctx) {
  const reason = interpolate(action.reason ?? `Blocked by rule ${ctx.ruleId}`, ctx.variables);
  dbg2(`BLOCK: ${reason}`);
  return {
    type: "block",
    success: true,
    blockResponse: {
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}
function executeHint(action, ctx) {
  const text = interpolate(action.text ?? "", ctx.variables);
  dbg2(`HINT: ${text.slice(0, 80)}...`);
  return { type: "hint", success: true, hintText: text };
}
async function executeExec(action, ctx) {
  const command = interpolate(action.command ?? "", ctx.variables);
  if (!command)
    return { type: "exec", success: false, error: "no command" };
  dbg2(`EXEC: ${command.slice(0, 80)}...`);
  try {
    const proc = Bun.spawn(["sh", "-c", command], {
      env: { ...process.env, ...ctx.variables, SIGNAL_WIRE_ACTIVE: "1" },
      timeout: action.timeout ?? 1e4
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return {
      type: "exec",
      success: exitCode === 0,
      execOutput: output.slice(0, 2000),
      error: exitCode !== 0 ? `exit ${exitCode}` : undefined
    };
  } catch (e) {
    dbg2(`exec error:`, e?.message);
    return { type: "exec", success: false, error: e?.message };
  }
}
async function executeWake(action, ctx) {
  if (!ctx.wakeEvent) {
    return { type: "wake", success: false, error: "no wakeEvent in context" };
  }
  const { formatWakeEvent } = await Promise.resolve().then(() => (init_signal_wire(), exports_signal_wire));
  let identityBlock = "";
  try {
    const wl = await Promise.resolve().then(() => (init_wake_listener(), exports_wake_listener));
    const identity = wl._agentIdentity ?? null;
    if (identity) {
      const teammates = identity.teammates?.length > 0 ? identity.teammates.map((t) => `${t.name} (${t.roleName ?? "?"})`).join(", ") : "none";
      const identityLines = [
        `<agent-identity name="${identity.name}" role="${identity.roleName ?? "unassigned"}" team="${identity.teamName ?? "none"}">`,
        `You are ${identity.name}. ${identity.rolePrompt ?? "No role assigned."}`,
        `Team: ${identity.teamName ?? "none"}. Teammates: ${teammates}.`
      ];
      if (identity.budget) {
        identityLines.push(`Helpers: max ${identity.budget.maxSubagents} concurrent, depth ${identity.budget.maxSpawnDepth}. \u0414\u0435\u043B\u0435\u0433\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u043A\u043E\u043B\u043B\u0435\u0433\u0430\u043C: SynqTask todo_tasks delegate.`);
      }
      identityLines.push(`</agent-identity>`);
      identityBlock = identityLines.join(`
`) + `
`;
    }
  } catch {}
  const text = identityBlock + formatWakeEvent(ctx.wakeEvent);
  const urls = [
    `${ctx.serverUrl}/session/${ctx.sessionId}/prompt_async`,
    `${ctx.serverUrl}/session/${ctx.sessionId}/message`
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          noReply: false,
          parts: [{ type: "text", text }]
        })
      });
      if (res.ok) {
        dbg2(`WAKE: injected via ${url.includes("prompt_async") ? "promptAsync" : "message"}`);
        return { type: "wake", success: true, wakeTriggered: true };
      }
      if (res.status === 404 || res.status === 405)
        continue;
      return { type: "wake", success: false, error: `HTTP ${res.status}` };
    } catch (e) {
      dbg2(`wake fetch error:`, e?.message);
      continue;
    }
  }
  return { type: "wake", success: false, error: "all endpoints failed" };
}
async function executeRespond(action, ctx) {
  const template = interpolate(action.template ?? "", ctx.variables);
  const target = action.target ?? ctx.wakeEvent?.payload?.channel_id;
  if (!target) {
    dbg2("respond: no target channel");
    return { type: "respond", success: false, error: "no target channel" };
  }
  try {
    dbg2(`RESPOND: to channel ${target}: ${template.slice(0, 80)}...`);
    return { type: "respond", success: true };
  } catch (e) {
    dbg2(`respond error:`, e?.message);
    return { type: "respond", success: false, error: e?.message };
  }
}
async function executeNotify(action, ctx) {
  const template = interpolate(action.template ?? `Rule ${ctx.ruleId} fired (${ctx.severity})`, ctx.variables);
  const channel = action.channel ?? "telegram";
  dbg2(`NOTIFY: ${channel}: ${template.slice(0, 80)}...`);
  if (channel === "telegram") {
    const token = process.env.SIGNAL_WIRE_TG_TOKEN;
    const chatId = process.env.SIGNAL_WIRE_TG_CHAT_ID;
    if (token && chatId) {
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: template, parse_mode: "HTML" })
      }).catch((e) => dbg2("telegram notify error:", e?.message));
    } else {
      dbg2("notify: telegram not configured (SIGNAL_WIRE_TG_TOKEN / SIGNAL_WIRE_TG_CHAT_ID)");
    }
  } else if (channel === "webhook" && action.target) {
    fetch(action.target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule: ctx.ruleId, severity: ctx.severity, message: template, event: ctx.event })
    }).catch((e) => dbg2("webhook notify error:", e?.message));
  }
  return { type: "notify", success: true };
}
function executeAudit(action, ctx) {
  const entry = {
    ts: new Date().toISOString(),
    ruleId: ctx.ruleId,
    event: ctx.event,
    eventSource: ctx.eventSource,
    eventType: ctx.eventType,
    severity: ctx.severity,
    sessionId: ctx.sessionId,
    variables: ctx.variables
  };
  if (ctx.auditWriter) {
    ctx.auditWriter(entry);
  } else {
    dbg2("audit: no writer configured, logging to debug");
    dbg2("AUDIT:", JSON.stringify(entry));
  }
  return { type: "audit", success: true };
}
function interpolate(template, variables) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return variables[key] ?? match;
  });
}
var DEBUG2, dbg2 = (...args) => {
  if (DEBUG2)
    console.error("[sw-actions]", ...args);
}, ACTION_ORDER;
var init_signal_wire_actions = __esm(() => {
  DEBUG2 = process.env.SIGNAL_WIRE_DEBUG === "1" || process.env.DEBUG?.includes("signal-wire");
  ACTION_ORDER = ["block", "hint", "exec", "wake", "respond", "notify", "audit"];
});

// signal-wire-audit.ts
import { appendFileSync as appendFileSync2, statSync, renameSync as renameSync2, mkdirSync as mkdirSync2, existsSync } from "fs";
import { join as join3 } from "path";
import { homedir as homedir3 } from "os";
function ensureDir() {
  if (initialized)
    return;
  try {
    if (!existsSync(AUDIT_DIR)) {
      mkdirSync2(AUDIT_DIR, { recursive: true });
    }
    initialized = true;
  } catch (e) {
    dbg3("ensureDir error:", e?.message);
  }
}
function writeAuditEntry(entry) {
  try {
    ensureDir();
    rotateIfNeeded();
    appendFileSync2(AUDIT_FILE, JSON.stringify(entry) + `
`);
  } catch (e) {
    dbg3("writeAuditEntry error:", e?.message);
  }
}
function createAuditWriter(sessionId) {
  return (entry) => {
    writeAuditEntry({
      ts: new Date().toISOString(),
      sessionId,
      outcome: "success",
      actionsTaken: ["audit"],
      severity: "info",
      ruleId: "unknown",
      event: "unknown",
      ...entry
    });
  };
}
function rotateIfNeeded() {
  try {
    const stats = statSync(AUDIT_FILE);
    if (stats.size > MAX_SIZE_BYTES) {
      const rotated = AUDIT_FILE + ".1";
      renameSync2(AUDIT_FILE, rotated);
      dbg3(`rotated audit log (${Math.round(stats.size / 1024 / 1024)}MB)`);
    }
  } catch {}
}
var DEBUG3, dbg3 = (...args) => {
  if (DEBUG3)
    console.error("[sw-audit]", ...args);
}, AUDIT_DIR, AUDIT_FILE, MAX_SIZE_BYTES, initialized = false;
var init_signal_wire_audit = __esm(() => {
  DEBUG3 = process.env.SIGNAL_WIRE_DEBUG === "1" || process.env.DEBUG?.includes("signal-wire");
  AUDIT_DIR = join3(homedir3(), ".opencode", "hooks", "logs");
  AUDIT_FILE = join3(AUDIT_DIR, "signal-wire-audit.jsonl");
  MAX_SIZE_BYTES = 50 * 1024 * 1024;
});

// signal-wire.ts
var exports_signal_wire = {};
__export(exports_signal_wire, {
  migrateRule: () => migrateRule,
  formatWakeEvent: () => formatWakeEvent,
  SignalWire: () => SignalWire
});
import { appendFileSync as appendFileSync3, readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { join as join4 } from "path";
import { homedir as homedir4 } from "os";
function dbg4(...args) {
  if (!DEBUG4)
    return;
  try {
    appendFileSync3(LOG_FILE2, `[${new Date().toISOString()}] [signal-wire] ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}
`);
  } catch {}
}
function migrateRule(rule) {
  const v2 = { ...rule };
  if (v2.actions && v2.actions.length > 0) {
    return v2;
  }
  if (rule.action) {
    const actions = [];
    if (rule.action.hint) {
      actions.push({ type: "hint", text: rule.action.hint });
    }
    if (rule.action.bash) {
      actions.push({ type: "exec", command: rule.action.bash });
    }
    if (actions.length > 0) {
      v2.actions = actions;
    }
  }
  if (!v2.severity)
    v2.severity = "info";
  if (!v2.trust_level)
    v2.trust_level = "any";
  return v2;
}

class SignalWire {
  rules;
  rulesV2 = [];
  serverUrl;
  platform;
  maxRulesPerFire;
  sessionId;
  sessionIdResolved = false;
  cooldownMap = new Map;
  contextPosition = 0;
  constructor(config) {
    this.serverUrl = config.serverUrl;
    this.sessionId = config.sessionId;
    this.platform = config.platform ?? "opencode";
    this.maxRulesPerFire = config.maxRulesPerFire ?? 3;
    this.sessionIdResolved = !!config.sessionId && config.sessionId !== "?" && config.sessionId !== "unknown";
    let rules = [];
    if (config.rulesPath) {
      rules = this.loadRules(config.rulesPath);
    }
    rules = rules.filter((r) => !r.platforms || r.platforms.includes(this.platform));
    this.rules = Object.freeze(rules);
    this.rulesV2 = Object.freeze(this.rules.map((r) => migrateRule(r)));
    if (!this.sessionIdResolved)
      this.resolveSessionId();
    dbg4(`init: ${this.rules.length} rules loaded (platform=${this.platform}), server=${this.serverUrl}, session=${this.sessionId}`);
  }
  loadRules(path) {
    try {
      if (!existsSync2(path)) {
        dbg4(`rules file not found: ${path}`);
        return [];
      }
      const raw = readFileSync2(path, "utf8");
      const parsed = JSON.parse(raw);
      const rules = parsed.rules ?? [];
      dbg4(`loaded ${rules.length} rules from ${path}`);
      return rules;
    } catch (e) {
      dbg4(`failed to load rules from ${path}:`, e.message);
      return [];
    }
  }
  trackTokens(usage) {
    try {
      const promptSize = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
      const prev = this.contextPosition;
      if (prev > 0 && promptSize > 0 && promptSize < prev * 0.6) {
        this.cooldownMap.clear();
        dbg4(`compaction detected: ${prev}\u2192${promptSize} (${((1 - promptSize / prev) * 100).toFixed(0)}% drop) \u2014 all cooldowns reset`);
      }
      if (promptSize > 0) {
        this.contextPosition = promptSize;
      }
      dbg4(`trackTokens: promptSize=${promptSize} contextPosition=${prev}\u2192${this.contextPosition}`);
    } catch (e) {
      dbg4("trackTokens error:", e.message);
    }
  }
  getContextPosition() {
    return this.contextPosition;
  }
  evaluate(context) {
    try {
      const results = [];
      for (const rule of this.rules) {
        if (results.length >= this.maxRulesPerFire)
          break;
        if (rule.enabled === false)
          continue;
        if (!rule.events.includes(context.event))
          continue;
        if (!this.matchRule(rule, context))
          continue;
        if (!this.checkCooldown(rule))
          continue;
        const hint = this.substituteVars(rule.action.hint ?? "", rule, context);
        this.markCooldown(rule);
        if (rule.action.exec) {
          const cmd = this.substituteVars(rule.action.exec, rule, context);
          this.execFireAndForget(cmd, rule);
        }
        if (hint) {
          results.push({
            ruleId: rule.id,
            hint,
            execCmd: rule.action.exec ? this.substituteVars(rule.action.exec, rule, context) : undefined
          });
        }
        dbg4(`rule fired: ${rule.id} \u2192 ${hint.replace(/\n/g, " ").slice(0, 120)}`);
      }
      if (results.length === 0)
        return null;
      const ids = results.map((r) => r.ruleId);
      const combined = results.map((r) => `\u26A1 signal-wire: ${r.ruleId}
${r.hint}`).join(`

`);
      this.notifyTui(ids, combined);
      return {
        ruleId: ids.join("+"),
        hint: combined
      };
    } catch (e) {
      dbg4("evaluate error:", e.message);
      return null;
    }
  }
  matchRule(rule, ctx) {
    try {
      const match = rule.match;
      if (!match || Object.keys(match).length === 0)
        return true;
      if (match.exclude_tools && match.exclude_tools.length > 0) {
        if (match.exclude_tools.includes(ctx.lastToolName))
          return false;
      }
      if (match.tool) {
        try {
          if (!new RegExp(match.tool).test(ctx.lastToolName))
            return false;
        } catch (e) {
          dbg4(`invalid regex in rule ${rule.id}.tool:`, e.message);
          return false;
        }
      }
      if (match.input_contains) {
        try {
          const inputObj = ctx.lastToolInput ? JSON.parse(ctx.lastToolInput) : {};
          if (!this.deepMatch(inputObj, match.input_contains))
            return false;
        } catch {
          if (!this.deepMatch(ctx.lastToolInput, match.input_contains))
            return false;
        }
      }
      if (match.input_regex) {
        try {
          if (!new RegExp(match.input_regex).test(ctx.lastToolInput))
            return false;
        } catch (e) {
          dbg4(`invalid regex in rule ${rule.id}.input_regex:`, e.message);
          return false;
        }
      }
      if (match.input_keywords && match.input_keywords.length > 0) {
        const inputLower = ctx.lastToolInput.toLowerCase();
        if (!match.input_keywords.some((kw) => inputLower.includes(kw.toLowerCase())))
          return false;
      }
      if (match.response_keywords && match.response_keywords.length > 0) {
        const outputLower = ctx.lastToolOutput.toLowerCase();
        if (!match.response_keywords.some((kw) => outputLower.includes(kw.toLowerCase())))
          return false;
      }
      if (match.response_regex) {
        try {
          if (!new RegExp(match.response_regex).test(ctx.lastToolOutput))
            return false;
        } catch (e) {
          dbg4(`invalid regex in rule ${rule.id}.response_regex:`, e.message);
          return false;
        }
      }
      if (match.prompt_keywords && match.prompt_keywords.length > 0) {
        const promptLower = ctx.lastUserText.toLowerCase();
        if (!match.prompt_keywords.some((kw) => promptLower.includes(kw.toLowerCase())))
          return false;
      }
      if (match.prompt_regex) {
        try {
          if (!new RegExp(match.prompt_regex).test(ctx.lastUserText))
            return false;
        } catch (e) {
          dbg4(`invalid regex in rule ${rule.id}.prompt_regex:`, e.message);
          return false;
        }
      }
      return true;
    } catch (e) {
      dbg4(`matchRule error for ${rule.id}:`, e.message);
      return false;
    }
  }
  deepMatch(data, pattern) {
    if (pattern === null || pattern === undefined)
      return data === pattern;
    if (typeof pattern === "object" && !Array.isArray(pattern)) {
      if (typeof data !== "object" || data === null || Array.isArray(data))
        return false;
      return Object.entries(pattern).every(([k, v]) => (k in data) && this.deepMatch(data[k], v));
    }
    if (typeof pattern === "string" && typeof data === "string") {
      return data.toLowerCase().includes(pattern.toLowerCase());
    }
    return data === pattern;
  }
  checkCooldown(rule) {
    try {
      const cooldownTokens = rule.cooldown_tokens ?? 0;
      const cooldownMinutes = rule.cooldown_minutes ?? 0;
      if (cooldownTokens <= 0 && cooldownMinutes <= 0)
        return true;
      if (cooldownTokens > 0) {
        const currentBucket = Math.floor(this.contextPosition / cooldownTokens);
        const ns = rule.cooldown_namespace ?? rule.id;
        const lastBucket = this.cooldownMap.get(ns);
        if (lastBucket !== undefined && currentBucket <= lastBucket) {
          dbg4(`cooldown active: ${rule.id} (ns:${ns}, pos:${this.contextPosition}, cd:${Math.floor(cooldownTokens / 1000)}k, bucket:${currentBucket})`);
          return false;
        }
        return true;
      }
      if (cooldownMinutes > 0) {
        const ns = rule.cooldown_namespace ?? rule.id;
        const key = `${ns}_time`;
        const lastFired = this.cooldownMap.get(key);
        const now = Date.now();
        if (lastFired !== undefined && now - lastFired < cooldownMinutes * 60 * 1000) {
          dbg4(`cooldown active (time): ${rule.id} (ns:${ns}, cd:${cooldownMinutes}m)`);
          return false;
        }
        return true;
      }
      return true;
    } catch (e) {
      dbg4("checkCooldown error:", e.message);
      return true;
    }
  }
  markCooldown(rule) {
    try {
      const cooldownTokens = rule.cooldown_tokens ?? 0;
      const cooldownMinutes = rule.cooldown_minutes ?? 0;
      if (cooldownTokens > 0) {
        const currentBucket = Math.floor(this.contextPosition / cooldownTokens);
        const ns = rule.cooldown_namespace ?? rule.id;
        this.cooldownMap.set(ns, currentBucket);
        dbg4(`cooldown marked: ${rule.id} (ns:${ns}, bucket:${currentBucket}, pos:${this.contextPosition})`);
      } else if (cooldownMinutes > 0) {
        const ns = rule.cooldown_namespace ?? rule.id;
        this.cooldownMap.set(`${ns}_time`, Date.now());
      }
    } catch (e) {
      dbg4("markCooldown error:", e.message);
    }
  }
  substituteVars(template, rule, ctx) {
    if (!template)
      return template;
    return template.replace(/\{tool_name\}/g, ctx.lastToolName).replace(/\{session_id\}/g, this.sessionId).replace(/\{cwd\}/g, process.cwd()).replace(/\{rule_id\}/g, rule.id);
  }
  resolveSessionId() {
    if (this.sessionIdResolved || !this.serverUrl)
      return;
    this.sessionIdResolved = true;
    const cwd = process.cwd();
    fetch(`${this.serverUrl}/session`).then((res) => res.json()).then((sessions) => {
      if (!sessions?.length)
        return;
      const matching = sessions.filter((s) => s.directory === cwd && !s.parentID).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
      if (matching.length) {
        this.sessionId = matching[0].id;
        dbg4(`signal-wire: resolved sessionId=${this.sessionId} (cwd=${cwd}, matched ${matching.length} sessions)`);
      }
    }).catch(() => {});
  }
  formatTuiMessage(ids, hint) {
    const header = ids.length === 1 ? `\u26A1 signal-wire: ${ids[0]}` : `\u26A1 signal-wire: ${ids.join(" + ")}`;
    const width = Math.max(header.length + 2, 40);
    const bar = "\u2501".repeat(width);
    return `${bar}
${header}
${bar}
${hint}
${bar}`;
  }
  notifyTui(ids, hint) {
    const idArr = Array.isArray(ids) ? ids : [ids];
    try {
      if (!this.sessionId || this.sessionId === "?" || this.sessionId === "unknown") {
        setTimeout(() => this.doTuiPost(idArr, hint), 2000);
        return;
      }
      this.doTuiPost(idArr, hint);
    } catch (e) {
      dbg4("notifyTui error:", e.message);
    }
  }
  doTuiPost(ids, hint) {
    try {
      if (!this.sessionId || this.sessionId === "?" || this.sessionId === "unknown") {
        dbg4(`TUI POST skipped: no sessionId after retry`);
        return;
      }
      const label = ids.join("+");
      const formatted = this.formatTuiMessage(ids, hint);
      const url = `${this.serverUrl}/session/${this.sessionId}/message`;
      const body = JSON.stringify({
        noReply: true,
        parts: [
          {
            type: "text",
            text: formatted,
            synthetic: true
          }
        ]
      });
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body
      }).then((res) => {
        dbg4(`TUI POST ${label}: ${res.status}`);
      }).catch((e) => {
        dbg4(`TUI POST ${label} failed:`, e.message);
      });
    } catch (e) {
      dbg4("notifyTui error:", e.message);
    }
  }
  execFireAndForget(cmd, rule) {
    try {
      const timeout = (rule.action.timeout ?? DEFAULT_EXEC_TIMEOUT_S) * 1000;
      if (typeof Bun !== "undefined" && Bun.spawn) {
        const proc = Bun.spawn(["bash", "-c", cmd], {
          env: {
            ...process.env,
            SIGNAL_WIRE_ACTIVE: "1",
            SIGNAL_WIRE_SESSION_ID: this.sessionId,
            SIGNAL_WIRE_CWD: process.cwd(),
            SIGNAL_WIRE_RULE_ID: rule.id
          },
          stdout: "ignore",
          stderr: "pipe"
        });
        const timer = setTimeout(() => {
          try {
            proc.kill();
            dbg4(`exec timeout (${rule.action.timeout ?? DEFAULT_EXEC_TIMEOUT_S}s) for rule ${rule.id}`);
          } catch {}
        }, timeout);
        proc.exited.then((code) => {
          clearTimeout(timer);
          if (code !== 0) {
            dbg4(`exec failed (${code}) for rule ${rule.id}`);
          } else {
            dbg4(`exec ok for rule ${rule.id}`);
          }
        }).catch((e) => {
          clearTimeout(timer);
          dbg4(`exec error for rule ${rule.id}:`, e.message);
        });
      } else {
        const { spawn } = __require("child_process");
        const proc = spawn("bash", ["-c", cmd], {
          env: {
            ...process.env,
            SIGNAL_WIRE_ACTIVE: "1",
            SIGNAL_WIRE_SESSION_ID: this.sessionId,
            SIGNAL_WIRE_CWD: process.cwd(),
            SIGNAL_WIRE_RULE_ID: rule.id
          },
          stdio: ["ignore", "ignore", "pipe"],
          detached: false
        });
        const timer = setTimeout(() => {
          try {
            proc.kill();
            dbg4(`exec timeout (${rule.action.timeout ?? DEFAULT_EXEC_TIMEOUT_S}s) for rule ${rule.id}`);
          } catch {}
        }, timeout);
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            dbg4(`exec failed (${code}) for rule ${rule.id}`);
          } else {
            dbg4(`exec ok for rule ${rule.id}`);
          }
        });
        proc.on("error", (e) => {
          clearTimeout(timer);
          dbg4(`exec error for rule ${rule.id}:`, e.message);
        });
      }
      dbg4(`exec spawned for rule ${rule.id}: ${cmd.slice(0, 120)}`);
    } catch (e) {
      dbg4(`execFireAndForget error for rule ${rule.id}:`, e.message);
    }
  }
  async evaluateHookV2(context) {
    try {
      const matched = this.matchRulesV2(context);
      if (matched.length === 0)
        return { v1Result: null, v2Results: [], blocked: false };
      const results = [];
      let blocked = false;
      let hintText = "";
      for (const rule of matched) {
        if (rule.trust_level === "plugin_only" && this.isProjectRule(rule)) {
          dbg4(`trust: skipping ${rule.id} (plugin_only but from project)`);
          continue;
        }
        if (!this.checkCooldownV2(rule))
          continue;
        const actions = rule.actions ?? [];
        if (actions.length === 0)
          continue;
        this.markCooldownV2(rule);
        const ctx = {
          serverUrl: this.serverUrl,
          sessionId: this.sessionId,
          ruleId: rule.id,
          severity: rule.severity ?? "info",
          event: context.event,
          variables: this.buildVariables(context, rule),
          auditWriter: createAuditWriter(this.sessionId)
        };
        const actionResults = await dispatchActions(actions, ctx);
        results.push(...actionResults);
        const blockResult = actionResults.find((r) => r.type === "block" && r.success);
        if (blockResult)
          blocked = true;
        const hintResults = actionResults.filter((r) => r.type === "hint" && r.hintText);
        if (hintResults.length > 0) {
          hintText += (hintText ? `
` : "") + hintResults.map((r) => r.hintText).join(`
`);
        }
      }
      const v1Result = hintText ? { ruleId: matched[0].id, hint: hintText } : null;
      return { v1Result, v2Results: results, blocked };
    } catch (e) {
      dbg4("evaluateHookV2 error:", e?.message);
      return { v1Result: null, v2Results: [], blocked: false };
    }
  }
  async evaluateHook(context) {
    const { v1Result } = await this.evaluateHookV2(context);
    return v1Result;
  }
  async evaluateExternal(event) {
    try {
      const matched = this.matchExternalRules(event);
      if (matched.length === 0) {
        dbg4(`evaluateExternal: no rules match event ${event.type} from ${event.source}`);
        return { matched: false, actionsExecuted: [], wakeTriggered: false };
      }
      const allResults = [];
      let wakeTriggered = false;
      for (const rule of matched) {
        if (rule.trust_level === "plugin_only" && this.isProjectRule(rule))
          continue;
        const actions = rule.actions ?? [];
        if (actions.length === 0)
          continue;
        const ctx = {
          serverUrl: this.serverUrl,
          sessionId: this.sessionId,
          ruleId: rule.id,
          severity: rule.severity ?? "info",
          event: EVENT_TYPES.EXTERNAL_EVENT,
          eventSource: event.source,
          eventType: event.type,
          variables: this.buildExternalVariables(event, rule),
          wakeEvent: event,
          auditWriter: createAuditWriter(this.sessionId)
        };
        const actionResults = await dispatchActions(actions, ctx);
        allResults.push(...actionResults);
        if (actionResults.some((r) => r.type === "wake" && r.wakeTriggered)) {
          wakeTriggered = true;
        }
      }
      return { matched: true, actionsExecuted: allResults, wakeTriggered };
    } catch (e) {
      dbg4("evaluateExternal error:", e?.message);
      return { matched: false, actionsExecuted: [], wakeTriggered: false };
    }
  }
  matchRulesV2(context) {
    return this.rulesV2.filter((rule) => {
      if (rule.enabled === false)
        return false;
      if (!rule.events.includes(context.event))
        return false;
      if (rule.platforms && !rule.platforms.includes(this.platform))
        return false;
      if (rule.match) {
        if (rule.match.tool && context.lastToolName) {
          try {
            if (!new RegExp(rule.match.tool, "i").test(context.lastToolName))
              return false;
          } catch {
            return false;
          }
        }
        if (rule.match.input_regex && context.lastToolInput) {
          try {
            if (!new RegExp(rule.match.input_regex, "i").test(context.lastToolInput))
              return false;
          } catch {
            return false;
          }
        }
        if (rule.match.response_regex && context.lastToolOutput) {
          try {
            if (!new RegExp(rule.match.response_regex, "i").test(context.lastToolOutput))
              return false;
          } catch {
            return false;
          }
        }
        if (rule.match.keywords) {
          const combined = `${context.lastUserText} ${context.lastToolInput} ${context.lastToolOutput}`.toLowerCase();
          if (!rule.match.keywords.some((kw) => combined.includes(kw.toLowerCase())))
            return false;
        }
      }
      return true;
    });
  }
  matchExternalRules(event) {
    return this.rulesV2.filter((rule) => {
      if (rule.enabled === false)
        return false;
      const externalEvents = [EVENT_TYPES.EXTERNAL_EVENT, EVENT_TYPES.WEBHOOK_EVENT, EVENT_TYPES.TIMER_EVENT];
      if (!rule.events.some((e) => externalEvents.includes(e)))
        return false;
      if (rule.platforms && !rule.platforms.includes(this.platform))
        return false;
      if (rule.event_source_match) {
        if (rule.event_source_match.source && !event.source.includes(rule.event_source_match.source))
          return false;
        if (rule.event_source_match.type && event.type !== rule.event_source_match.type)
          return false;
      }
      return true;
    });
  }
  buildVariables(context, rule) {
    return {
      tool_name: context.lastToolName ?? "",
      tool_input: context.lastToolInput?.slice(0, 500) ?? "",
      tool_output: context.lastToolOutput?.slice(0, 500) ?? "",
      user_text: context.lastUserText?.slice(0, 500) ?? "",
      session_id: this.sessionId,
      rule_id: rule.id,
      severity: rule.severity ?? "info",
      event: context.event,
      cwd: process.cwd(),
      agent_id: process.env.AGENT_ID ?? "",
      agent_type: process.env.AGENT_TYPE ?? ""
    };
  }
  buildExternalVariables(event, rule) {
    return {
      event_source: event.source,
      event_type: event.type,
      event_id: event.eventId,
      target_member: event.targetMemberId,
      session_id: this.sessionId,
      rule_id: rule.id,
      severity: rule.severity ?? "info",
      priority: event.priority,
      cwd: process.cwd()
    };
  }
  checkCooldownV2(rule) {
    try {
      const cooldownTokens = rule.cooldown_tokens ?? 0;
      const cooldownMinutes = rule.cooldown_minutes ?? 0;
      if (cooldownTokens <= 0 && cooldownMinutes <= 0)
        return true;
      if (cooldownTokens > 0) {
        const currentBucket = Math.floor(this.contextPosition / cooldownTokens);
        const ns = `v2:${rule.cooldown_namespace ?? rule.id}`;
        const lastBucket = this.cooldownMap.get(ns);
        if (lastBucket !== undefined && currentBucket <= lastBucket) {
          dbg4(`cooldown v2 active: ${rule.id} (ns:${ns}, pos:${this.contextPosition}, bucket:${currentBucket})`);
          return false;
        }
        return true;
      }
      if (cooldownMinutes > 0) {
        const ns = `v2:${rule.cooldown_namespace ?? rule.id}`;
        const key = `${ns}_time`;
        const lastFired = this.cooldownMap.get(key);
        const now = Date.now();
        if (lastFired !== undefined && now - lastFired < cooldownMinutes * 60 * 1000) {
          dbg4(`cooldown v2 active (time): ${rule.id} (ns:${ns}, cd:${cooldownMinutes}m)`);
          return false;
        }
        return true;
      }
      return true;
    } catch (e) {
      dbg4("checkCooldownV2 error:", e?.message);
      return true;
    }
  }
  markCooldownV2(rule) {
    try {
      const cooldownTokens = rule.cooldown_tokens ?? 0;
      const cooldownMinutes = rule.cooldown_minutes ?? 0;
      if (cooldownTokens > 0) {
        const currentBucket = Math.floor(this.contextPosition / cooldownTokens);
        const ns = `v2:${rule.cooldown_namespace ?? rule.id}`;
        this.cooldownMap.set(ns, currentBucket);
        dbg4(`cooldown v2 marked: ${rule.id} (ns:${ns}, bucket:${currentBucket})`);
      } else if (cooldownMinutes > 0) {
        const ns = `v2:${rule.cooldown_namespace ?? rule.id}`;
        this.cooldownMap.set(`${ns}_time`, Date.now());
      }
    } catch (e) {
      dbg4("markCooldownV2 error:", e?.message);
    }
  }
  isProjectRule(_rule) {
    return false;
  }
}
function formatWakeEvent(event) {
  const header = `<system-reminder type="wake" source="${esc(event.source)}" priority="${event.priority}" event-id="${esc(event.eventId)}">`;
  const footer = `</system-reminder>`;
  const body = getEventTemplate(event);
  return `${header}
${body}
${footer}`;
}
function getEventTemplate(event) {
  const p = event.payload;
  switch (event.type) {
    case "task_assigned":
      return [
        `## Wake: New Task Assigned`,
        ``,
        `### Task Details`,
        p.task_id || p.entityId ? `- **Task ID:** \`${p.task_id ?? p.entityId}\`` : "",
        `- **Title:** ${p.title ?? "Unknown"}`,
        p.description ? `- **Description:** ${p.description}` : "",
        p.list || p.listName ? `- **List:** ${p.list ?? p.listName}` : "",
        p.priority ? `- **Priority:** ${p.priority}` : "",
        p.assigned_by || p.actorId ? `- **Assigned by:** ${p.assigned_by ?? p.actorId}` : "",
        p.due || p.dueDate ? `- **Due:** ${p.due ?? p.dueDate}` : "",
        ``,
        `### How to Work on This`,
        `1. Accept: \`synqtask_todo_tasks({action: "set_status", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}", status: "started"})\``,
        `2. Read full task: \`synqtask_todo_tasks({action: "show", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}"})\``,
        `3. Do the work described above`,
        `4. When done: \`synqtask_todo_tasks({action: "set_status", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}", status: "done"})\``,
        `5. Add result: \`synqtask_todo_comments({action: "add_result", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}", text: "Done: <summary>"})\``
      ].filter(Boolean).join(`
`);
    case "channel_message": {
      const chId = p.channel_id ?? p.channelId ?? "";
      const sendId = p.sender_id ?? p.senderId ?? "";
      const sendName = p.sender_name ?? p.senderName ?? "";
      const isDirect = p.is_direct ?? p.isDirect ?? false;
      return [
        `## Wake: New Channel Message`,
        ``,
        `### Message Details`,
        chId ? `- **Channel ID:** \`${chId}\`` : "",
        p.channel_name ?? p.channelName ? `- **Channel:** ${p.channel_name ?? p.channelName}` : "",
        sendName ? `- **From:** ${sendName}` : "",
        isDirect ? `- **Type:** Direct message to you` : `- **Type:** Channel broadcast`,
        ``,
        `### Message`,
        p.text ? `> ${p.text}` : "> (no text)",
        ``,
        `### \u26A1 ACTION REQUIRED: Reply in channel`,
        `You MUST reply using this exact tool call:`,
        `\`\`\``,
        `synqtask_todo_channels({action: "send", channel_id: "${chId}", text: "YOUR REPLY HERE"})`,
        `\`\`\``,
        sendId ? `Or DM sender: \`synqtask_todo_channels({action: "create_dm", member_b: "${sendId}"})\` then send` : ""
      ].filter(Boolean).join(`
`);
    }
    case "delegation_received":
      return [
        `## Wake: Task Delegated to You`,
        ``,
        `### Delegation Details`,
        p.task_id || p.entityId ? `- **Task ID:** \`${p.task_id ?? p.entityId}\`` : "",
        `- **Title:** ${p.title ?? "Unknown"}`,
        p.delegator || p.delegated_by ? `- **Delegated by:** ${p.delegator ?? p.delegated_by}` : "",
        p.delegator_id ? `- **Delegator ID:** \`${p.delegator_id}\`` : "",
        p.notes ? `- **Notes:** ${p.notes}` : "",
        ``,
        `### How to Handle`,
        `1. Accept: \`synqtask_todo_tasks({action: "accept_delegation", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}"})\``,
        `2. Read task: \`synqtask_todo_tasks({action: "show", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}"})\``,
        `3. Do the work`,
        `4. Complete: \`synqtask_todo_tasks({action: "set_status", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}", status: "done"})\``
      ].filter(Boolean).join(`
`);
    case "comment_added":
      return [
        `## Wake: New Comment on Task`,
        ``,
        `### Comment Details`,
        p.task_id || p.entityId ? `- **Task ID:** \`${p.task_id ?? p.entityId}\`` : "",
        p.task_title ? `- **Task:** ${p.task_title}` : "",
        p.commenter || p.actorId ? `- **From:** ${p.commenter ?? p.actorId}` : "",
        p.commenter_id ? `- **Commenter ID:** \`${p.commenter_id}\`` : "",
        ``,
        `### Comment`,
        p.text ? `> ${p.text}` : "> (no text)",
        ``,
        `### How to Reply`,
        `Reply: \`synqtask_todo_comments({action: "add", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}", text: "YOUR REPLY"})\``,
        `View all: \`synqtask_todo_comments({action: "list", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}"})\``
      ].filter(Boolean).join(`
`);
    case "status_changed":
      return [
        `## Wake: Task Status Changed`,
        ``,
        p.task_id || p.entityId ? `- **Task ID:** \`${p.task_id ?? p.entityId}\`` : "",
        p.title ? `- **Task:** ${p.title}` : "",
        p.changes?.status ? `- **Status:** ${p.changes.status.from ?? "?"} \u2192 ${p.changes.status.to ?? "?"}` : "",
        p.actorId ? `- **Changed by:** ${p.actorId}` : "",
        ``,
        `View task: \`synqtask_todo_tasks({action: "show", task_id: "${p.task_id ?? p.entityId ?? "TASK_ID"}"})\``
      ].filter(Boolean).join(`
`);
    case "webhook_event":
      return [
        `## Wake: External Event`,
        ``,
        `- **Source:** ${event.source}`,
        p.webhook_type ? `- **Type:** ${p.webhook_type}` : "",
        ``,
        `### Payload`,
        "```json",
        JSON.stringify(p, null, 2),
        "```",
        ``,
        `Review and take appropriate action.`
      ].join(`
`);
    default:
      return [
        `## Wake: ${event.type}`,
        ``,
        `- **Source:** ${event.source}`,
        `- **Priority:** ${event.priority}`,
        `- **Event ID:** ${event.eventId}`,
        ``,
        `### Payload`,
        "```json",
        JSON.stringify(p, null, 2),
        "```",
        ``,
        `Review and respond as appropriate.`
      ].join(`
`);
  }
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
var DEBUG4, LOG_FILE2, DEFAULT_EXEC_TIMEOUT_S = 15;
var init_signal_wire = __esm(() => {
  init_wake_types();
  init_signal_wire_actions();
  init_signal_wire_audit();
  DEBUG4 = process.env.SIGNAL_WIRE_DEBUG !== "0";
  LOG_FILE2 = join4(homedir4(), ".claude", "signal-wire-debug.log");
});

// index.ts
import { createHash, randomBytes } from "crypto";
import { readFileSync as readFileSync3, writeFileSync as writeFileSync2, mkdirSync as mkdirSync4, chmodSync, existsSync as existsSync3, statSync as statSync2 } from "fs";
import { join as join6, dirname } from "path";
import { homedir as homedir6 } from "os";

// provider.ts
import { appendFileSync as _traceWrite } from "fs";
import { ClaudeCodeSDK } from "@life-ai-tools/claude-code-sdk";
import { appendFileSync as appendFileSync4 } from "fs";
init_signal_wire();
init_wake_listener();
import { join as join5 } from "path";
import { homedir as homedir5 } from "os";
try {
  _traceWrite("/tmp/opencode-claude-trace.log", `PROVIDER.TS pid=${process.pid} cwd=${process.cwd()} ${new Date().toISOString()}
`);
} catch {}
var DEBUG5 = process.env.CLAUDE_MAX_DEBUG !== "0";
var LOG_FILE3 = join5(homedir5(), ".claude", "claude-max-debug.log");
var STATS_FILE = join5(homedir5(), ".claude", "claude-max-stats.log");
var STATS_JSONL = join5(homedir5(), ".claude", "claude-max-stats.jsonl");
var PID = process.pid;
var SESSION = process.env.OPENCODE_SESSION_SLUG ?? process.env.OPENCODE_SESSION_ID?.slice(0, 12) ?? "?";
var _swServerUrl = "";
function setSignalWireServerUrl(url) {
  _swServerUrl = url;
}
var _signalWire = null;
function getSignalWireInstance() {
  return _signalWire;
}
function dbg5(...args) {
  if (!DEBUG5)
    return;
  try {
    appendFileSync4(LOG_FILE3, `[${new Date().toISOString()}] ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}
`);
  } catch {}
}
var IMAGE_TARGET_RAW_BYTES = 3.75 * 1024 * 1024;
var _fileCache = new Map;
async function handlePreToolUseSpawnCheck(toolName, serverUrl, sessionId, input) {
  const SPAWN_TOOLS = ["task", "Task", "task_tool", "call_omo_agent"];
  if (!SPAWN_TOOLS.includes(toolName))
    return;
  try {
    const identity = getAgentIdentity();
    const depth = await resolveCurrentDepth(serverUrl, sessionId);
    if (!identity || !identity.roleName) {
      const maxDepth = parseInt(process.env.__MAX_HELPER_DEPTH ?? "1", 10);
      if (depth >= maxDepth) {
        return {
          decision: "block",
          message: [
            `\u26A0\uFE0F \u0425\u0435\u043B\u043F\u0435\u0440 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D: \u0433\u043B\u0443\u0431\u0438\u043D\u0430 ${depth}/${maxDepth}.`,
            `\u0414\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u0430\u044F \u0432\u043B\u043E\u0436\u0435\u043D\u043D\u043E\u0441\u0442\u044C \u0445\u0435\u043B\u043F\u0435\u0440\u043E\u0432 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u044F\u0435\u0442\u0441\u044F \u0440\u043E\u043B\u044C\u044E \u0432\u044B\u0437\u0432\u0430\u0432\u0448\u0435\u0433\u043E \u0430\u0433\u0435\u043D\u0442\u0430.`,
            `\u041D\u0430 \u044D\u0442\u043E\u043C \u0443\u0440\u043E\u0432\u043D\u0435 \u043F\u043E\u0440\u043E\u0436\u0434\u0435\u043D\u0438\u0435 \u0437\u0430\u043F\u0440\u0435\u0449\u0435\u043D\u043E.`,
            ``,
            `\u0412\u044B\u043F\u043E\u043B\u043D\u0438 \u0437\u0430\u0434\u0430\u043D\u0438\u0435 \u0441\u0430\u043C \u0438 \u0432\u0435\u0440\u043D\u0438 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442.`,
            `\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439 bash, read, grep, webfetch \u2014 \u043D\u043E \u043D\u0435 task/call_omo_agent.`
          ].join(`
`)
        };
      }
      helperStarted();
      dbg5(`helper spawn OK (depth=${depth}/${maxDepth} active=${getSpawnActive()} total=${getSpawnTotal()})`);
      return;
    }
    const check = checkSpawnAllowed(identity, depth, getSpawnActive());
    if (!check.allowed) {
      const roleName = identity.roleName ?? "unknown";
      const teammates = identity.teammates?.length > 0 ? identity.teammates.map((t) => `${t.name} (${t.roleName ?? "?"})`).join(", ") : "\u043D\u0435\u0442";
      const reason = check.depth >= check.maxDepth ? `\u0413\u043B\u0443\u0431\u0438\u043D\u0430 ${check.depth}/${check.maxDepth} \u0434\u043B\u044F \u0440\u043E\u043B\u0438 '${roleName}'.` : `\u041F\u043E\u0440\u043E\u0436\u0434\u0435\u043D\u043E ${check.spawned}/${check.maxSpawns} \u0441\u0443\u0431\u0430\u0433\u0435\u043D\u0442\u043E\u0432 \u0434\u043B\u044F \u0440\u043E\u043B\u0438 '${roleName}'.`;
      dbg5(`spawn budget BLOCKED: ${reason}`);
      return {
        decision: "block",
        message: [
          `\u26A0\uFE0F Spawn blocked: ${reason}`,
          ``,
          `\u0412\u0430\u0440\u0438\u0430\u043D\u0442\u044B:`,
          `1. \u0412\u044B\u043F\u043E\u043B\u043D\u0438 \u0440\u0430\u0431\u043E\u0442\u0443 \u0441\u0430\u043C \u2014 \u0442\u044B ${roleName}`,
          `2. \u041F\u043E\u043F\u0440\u043E\u0441\u0438 teammate \u043F\u043E\u043C\u043E\u0447\u044C: todo_channels({action:"send", channel_id:"333fec34-5604-447e-ac5d-4046d856ee5a", text:"\u041D\u0443\u0436\u043D\u0430 \u043F\u043E\u043C\u043E\u0449\u044C \u0441 [\u0437\u0430\u0434\u0430\u0447\u0430]"})`,
          `   Teammates: ${teammates}`,
          `3. \u0417\u0430\u043F\u0440\u043E\u0441\u0438 \u0441\u043F\u0435\u0446\u0438\u0430\u043B\u0438\u0441\u0442\u0430: todo_members({action:"find_available", capability:"[\u043D\u0443\u0436\u043D\u0430\u044F]"})`,
          `4. \u042D\u0441\u043A\u0430\u043B\u0438\u0440\u0443\u0439 owner'\u0443: todo_channels({action:"send", ..., text:"@relishjev \u043D\u0443\u0436\u0435\u043D \u0441\u043F\u0435\u0446\u0438\u0430\u043B\u0438\u0441\u0442 \u0441 [capability]"})`
        ].join(`
`)
      };
    }
    const description = String(input?.description ?? input?.prompt ?? input?.message ?? "");
    if (description.length < 200) {
      return {
        decision: "block",
        message: [
          `\u26A0\uFE0F \u0414\u0435\u043B\u0435\u0433\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043E: \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435 (${description.length} \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432, \u043D\u0443\u0436\u043D\u043E 200+).`,
          ``,
          `\u0412\u043A\u043B\u044E\u0447\u0438 \u0432 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435:`,
          `- \u0427\u0442\u043E \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E \u0441\u0434\u0435\u043B\u0430\u0442\u044C`,
          `- \u0427\u0442\u043E \u041D\u0415 \u0434\u0435\u043B\u0430\u0442\u044C`,
          `- ID \u0440\u043E\u0434\u0438\u0442\u0435\u043B\u044C\u0441\u043A\u043E\u0439 \u0437\u0430\u0434\u0430\u0447\u0438 \u0434\u043B\u044F \u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442\u0430`,
          `- \u041A\u0430\u043A\u0438\u0435 \u0444\u0430\u0439\u043B\u044B/\u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u044B \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C`
        ].join(`
`)
      };
    }
    helperStarted();
    process.env.__PARENT_MEMBER_ID = identity.memberId;
    process.env.__PARENT_SESSION_ID = sessionId;
    process.env.__SPAWN_DEPTH = String(check.depth + 1);
    process.env.__MAX_HELPER_DEPTH = String(identity.budget?.maxSpawnDepth ?? 2);
    dbg5(`spawn budget OK: depth=${check.depth}/${check.maxDepth} spawned=${check.spawned + 1}/${check.maxSpawns} \u2192 child will be depth=${check.depth + 1}`);
    return;
  } catch (e) {
    dbg5(`spawn budget check failed (allowing): ${e?.message}`);
    return;
  }
}

// index.ts
init_wake_listener();
import { appendFileSync as appendFileSync5 } from "fs";
try {
  __require("fs").appendFileSync("/tmp/opencode-claude-trace.log", `LOADED pid=${process.pid} cwd=${process.cwd()} time=${new Date().toISOString()}
`);
} catch {}
var CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
var AUTH_BASE = "https://platform.claude.com";
var AUTH_URL = "https://claude.com/cai/oauth/authorize";
var TOKEN_URL = `${AUTH_BASE}/v1/oauth/token`;
var SCOPES = [
  "user:profile",
  "user:inference",
  "org:create_api_key",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload"
].join(" ");
var EXPIRY_BUFFER_MS = 5 * 60 * 1000;
var MAX_MODELS = {
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    context: 1e6,
    output: 16384,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
  },
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    context: 1e6,
    output: 16384,
    cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 }
  },
  "claude-haiku-4-5-20251001": {
    name: "Claude Haiku 4.5",
    context: 200000,
    output: 8192,
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }
  }
};
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function generateCodeVerifier() {
  return base64url(randomBytes(32));
}
function generateCodeChallenge(v) {
  return base64url(createHash("sha256").update(v).digest());
}
function generateState() {
  return base64url(randomBytes(32));
}

class CredentialManager {
  accessToken = null;
  refreshToken = null;
  expiresAt = 0;
  lastMtime = 0;
  refreshing = null;
  credPath;
  constructor(cwd) {
    const candidates = [
      join6(cwd, ".claude", ".credentials.json"),
      join6(cwd, ".credentials.json"),
      join6(homedir6(), ".claude", ".credentials.json")
    ];
    this.credPath = candidates.find((p) => existsSync3(p)) ?? join6(homedir6(), ".claude", ".credentials.json");
    this.loadFromDisk();
  }
  get token() {
    return this.accessToken;
  }
  get hasCredentials() {
    return !!this.accessToken;
  }
  loadFromDisk() {
    try {
      const raw = readFileSync3(this.credPath, "utf8");
      this.lastMtime = this.getMtime();
      const oauth = JSON.parse(raw).claudeAiOauth;
      if (!oauth?.accessToken)
        return false;
      this.accessToken = oauth.accessToken;
      this.refreshToken = oauth.refreshToken;
      this.expiresAt = oauth.expiresAt ?? 0;
      return true;
    } catch {
      return false;
    }
  }
  saveToDisk() {
    let existing = {};
    try {
      existing = JSON.parse(readFileSync3(this.credPath, "utf8"));
    } catch {}
    existing.claudeAiOauth = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt
    };
    const dir = dirname(this.credPath);
    try {
      mkdirSync4(dir, { recursive: true });
    } catch {}
    writeFileSync2(this.credPath, JSON.stringify(existing, null, 2), "utf8");
    try {
      chmodSync(this.credPath, 384);
    } catch {}
    this.lastMtime = this.getMtime();
  }
  getMtime() {
    try {
      return statSync2(this.credPath).mtimeMs;
    } catch {
      return 0;
    }
  }
  diskChanged() {
    return this.getMtime() !== this.lastMtime;
  }
  isExpired() {
    return !this.accessToken || Date.now() + EXPIRY_BUFFER_MS >= this.expiresAt;
  }
  async ensureValid() {
    if (this.diskChanged()) {
      this.loadFromDisk();
      if (!this.isExpired())
        return this.accessToken;
    }
    if (!this.isExpired())
      return this.accessToken;
    if (!this.refreshToken) {
      throw new Error("Not logged in. Run: opencode providers login -p claude-max");
    }
    if (this.refreshing) {
      await this.refreshing;
      return this.accessToken;
    }
    this.refreshing = (async () => {
      if (this.diskChanged()) {
        this.loadFromDisk();
        if (!this.isExpired())
          return;
      }
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: this.refreshToken,
          client_id: CLIENT_ID,
          scope: SCOPES
        })
      });
      if (!res.ok) {
        if (this.diskChanged()) {
          this.loadFromDisk();
          if (!this.isExpired())
            return;
        }
        throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
      }
      const data = await res.json();
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.expiresAt = Date.now() + data.expires_in * 1000;
      this.saveToDisk();
    })().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    return this.accessToken;
  }
  setCredentials(access, refresh, expiresAt) {
    this.accessToken = access;
    this.refreshToken = refresh;
    this.expiresAt = expiresAt;
    this.saveToDisk();
  }
}
var DEBUG6 = process.env.CLAUDE_MAX_DEBUG !== "0";
var LOG_FILE4 = join6(homedir6(), ".claude", "claude-max-debug.log");
function dbg6(...args) {
  if (!DEBUG6)
    return;
  try {
    appendFileSync5(LOG_FILE4, `[${new Date().toISOString()}] ${args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}
`);
  } catch {}
}
var opencode_claude_default = {
  id: "opencode-claude-max",
  server: async (input) => {
    const t0 = Date.now();
    const cwd = input.directory ?? process.cwd();
    const sessionId = process.env.OPENCODE_SESSION_ID ?? process.env.OPENCODE_SESSION_SLUG ?? input.sessionID ?? "unknown";
    const creds = new CredentialManager(cwd);
    const providerPath = `file://${import.meta.dir}`;
    dbg6(`STARTUP plugin.server() pid=${process.pid} session=${sessionId} cwd=${cwd} cred=${creds.credPath} loggedIn=${creds.hasCredentials} providerPath=${providerPath} initTime=${Date.now() - t0}ms`);
    const _serverUrl = typeof input.serverUrl === "object" && input.serverUrl?.href ? input.serverUrl.href.replace(/\/$/, "") : typeof input.serverUrl === "string" ? input.serverUrl.replace(/\/$/, "") : "";
    const _sessionId = process.env.OPENCODE_SESSION_ID ?? sessionId;
    dbg6(`STARTUP signal-wire: serverUrl=${_serverUrl} sessionId=${_sessionId}`);
    setSignalWireServerUrl(_serverUrl);
    let wakeHandle = null;
    let _memberId = process.env.SYNQTASK_MEMBER_ID;
    try {
      const configPath = __require("path").join(cwd, "opencode.json");
      if (__require("fs").existsSync(configPath)) {
        const projConfig = JSON.parse(__require("fs").readFileSync(configPath, "utf-8"));
        const synqHeaders = projConfig?.mcp?.synqtask?.headers;
        if (synqHeaders?.["X-Agent-Id"]) {
          _memberId = synqHeaders["X-Agent-Id"];
          dbg6(`WAKE memberId from opencode.json: ${_memberId}`);
        }
      }
    } catch (e) {
      dbg6(`WAKE config read failed: ${e?.message}`);
    }
    if (_serverUrl) {
      try {
        wakeHandle = await startWakeListener({
          serverUrl: _serverUrl,
          sessionId: _sessionId,
          memberId: _memberId,
          synqtaskUrl: process.env.SYNQTASK_API_URL,
          signalWireResolver: () => getSignalWireInstance(),
          sdkClient: input.client
        });
        dbg6(`WAKE listener started on port ${wakeHandle.port} token=${wakeHandle.token.slice(0, 8)}...`);
      } catch (e) {
        dbg6(`WAKE listener failed to start: ${e?.message ?? e}`);
      }
    } else {
      dbg6(`WAKE listener skipped: serverUrl=${_serverUrl} sessionId=${_sessionId}`);
    }
    if (!creds.hasCredentials) {
      dbg6("Not logged in \u2014 run: opencode providers login -p claude-max");
    }
    return {
      config: async (config) => {
        const tc = Date.now();
        if (!config.provider)
          config.provider = {};
        dbg6("STARTUP config hook called");
        config.provider["claude-max"] = {
          id: "claude-max",
          name: "Claude Max/Pro",
          api: "https://api.anthropic.com",
          npm: providerPath,
          env: [],
          models: {}
        };
        for (const [id, info] of Object.entries(MAX_MODELS)) {
          const is46 = id.includes("opus-4-6") || id.includes("sonnet-4-6");
          config.provider["claude-max"].models[id] = {
            id,
            name: `${info.name} (Max)`,
            api: { id, url: "https://api.anthropic.com", npm: providerPath },
            providerID: "claude-max",
            reasoning: is46,
            modalities: {
              input: ["text", "image", "pdf"],
              output: ["text"]
            },
            capabilities: {
              temperature: true,
              reasoning: is46,
              attachment: true,
              toolcall: true,
              input: {
                text: true,
                audio: false,
                image: true,
                video: false,
                pdf: true
              },
              output: {
                text: true,
                audio: false,
                image: false,
                video: false,
                pdf: false
              },
              interleaved: is46 ? { field: "reasoning_content" } : false
            },
            cost: { input: info.cost.input, output: info.cost.output, cache: { read: info.cost.cacheRead, write: info.cost.cacheWrite } },
            limit: { context: info.context, output: info.output },
            status: "active",
            options: {},
            headers: {},
            ...is46 ? {
              variants: {
                low: { thinking: { type: "enabled", budgetTokens: 5000 } },
                medium: { thinking: { type: "enabled", budgetTokens: 16000 } },
                high: { thinking: { type: "enabled", budgetTokens: 32000 } }
              }
            } : {}
          };
        }
        dbg6(`STARTUP config hook done in ${Date.now() - tc}ms \u2014 ${Object.keys(config.provider["claude-max"].models).length} models registered`);
      },
      auth: {
        provider: "claude-max",
        loader: async (_getAuth, provider) => {
          const tl = Date.now();
          dbg6("STARTUP auth.loader called", { providerModels: Object.keys(provider.models ?? {}), providerOptions: provider.options });
          dbg6(`STARTUP auth.loader done in ${Date.now() - tl}ms credPath=${creds.credPath}`);
          return {
            credentialsPath: creds.credPath,
            providerOptions: provider.options ?? {}
          };
        },
        methods: [
          {
            type: "oauth",
            label: "Login with Claude Max/Pro (browser)",
            prompts: [
              {
                type: "select",
                key: "credLocation",
                message: "Where to save credentials?",
                options: [
                  { label: "This project", value: "local", hint: `${cwd}/.claude/.credentials.json` },
                  { label: "Global (default)", value: "global", hint: `~/.claude/.credentials.json` }
                ]
              }
            ],
            async authorize(inputs) {
              const savePath = inputs?.credLocation === "local" ? join6(cwd, ".claude", ".credentials.json") : join6(homedir6(), ".claude", ".credentials.json");
              const codeVerifier = generateCodeVerifier();
              const codeChallenge = generateCodeChallenge(codeVerifier);
              const state = generateState();
              let resolveCode;
              let rejectCode;
              const codePromise = new Promise((resolve, reject) => {
                resolveCode = resolve;
                rejectCode = reject;
              });
              const server = Bun.serve({
                port: 0,
                fetch(req) {
                  const url = new URL(req.url);
                  if (url.pathname !== "/callback")
                    return new Response("Not found", { status: 404 });
                  const code = url.searchParams.get("code");
                  const st = url.searchParams.get("state");
                  const error = url.searchParams.get("error");
                  if (error) {
                    rejectCode(new Error(`OAuth error: ${error}`));
                    return new Response("<h1>Login failed</h1>", { status: 400, headers: { "Content-Type": "text/html" } });
                  }
                  if (!code || st !== state) {
                    rejectCode(new Error("Invalid callback"));
                    return new Response("Invalid", { status: 400 });
                  }
                  resolveCode(code);
                  return new Response(null, { status: 302, headers: { Location: `${AUTH_BASE}/oauth/code/success?app=claude-code` } });
                }
              });
              const callbackPort = server.port;
              const redirectUri = `http://localhost:${callbackPort}/callback`;
              const params = new URLSearchParams({
                client_id: CLIENT_ID,
                response_type: "code",
                redirect_uri: redirectUri,
                scope: SCOPES,
                code_challenge: codeChallenge,
                code_challenge_method: "S256",
                state,
                code: "true"
              });
              const timeout = setTimeout(() => {
                rejectCode(new Error("Login timed out (5 min)"));
                server.stop();
              }, 300000);
              return {
                url: `${AUTH_URL}?${params.toString()}`,
                instructions: "Complete the login in your browser. The page will redirect automatically.",
                method: "auto",
                async callback() {
                  try {
                    const code = await codePromise;
                    const tokenRes = await fetch(TOKEN_URL, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        grant_type: "authorization_code",
                        code,
                        redirect_uri: redirectUri,
                        client_id: CLIENT_ID,
                        code_verifier: codeVerifier,
                        state
                      })
                    });
                    if (!tokenRes.ok) {
                      const body = await tokenRes.text();
                      dbg6(`Token exchange failed (${tokenRes.status}): ${body}`);
                      return { type: "failed" };
                    }
                    const data = await tokenRes.json();
                    const exp = Date.now() + data.expires_in * 1000;
                    creds.setCredentials(data.access_token, data.refresh_token, exp);
                    return {
                      type: "success",
                      access: data.access_token,
                      refresh: data.refresh_token,
                      expires: exp
                    };
                  } finally {
                    clearTimeout(timeout);
                    server.stop();
                  }
                }
              };
            }
          }
        ]
      },
      event: async ({ event }) => {
        if (event?.type === "mcp.tools.changed") {
          dbg6(`MCP_EVENT: tools changed on server=${event.properties?.server}`);
        }
      },
      pre_tool_use: async ({ toolName, input: input2 }) => {
        try {
          const result = await handlePreToolUseSpawnCheck(toolName, _serverUrl, _sessionId, input2);
          if (result)
            return result;
        } catch (e) {
          dbg6(`pre_tool_use hook error (allowing): ${e?.message}`);
        }
        return;
      },
      "experimental.session.compacting": async (_input, output) => {
        output.context.push(`## Cache Optimization Notes
- This session uses Anthropic prompt caching with keepalive
- Cache prefix (system + tools \u224830K tokens) is shared across all sessions
- When continuing, reuse exact tool names and file paths to maximize cache hits
- Cache read is 10x cheaper than uncached input \u2014 preserving conversation structure matters`);
        const customPrompt = creds._providerOptions?.customCompaction;
        if (typeof customPrompt === "string" && customPrompt.length > 0) {
          output.prompt = customPrompt;
        }
      }
    };
  }
};
export {
  opencode_claude_default as default
};
