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
    STATUS_CHANGED: "status_changed",
    MENTION: "mention",
    TASK_COMPLETED: "task_completed",
    TASK_FAILED: "task_failed",
    AGENT_STALE: "agent_stale"
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
  updateDiscovery: () => updateDiscovery,
  stopWakeListener: () => stopWakeListener,
  startWakeListener: () => startWakeListener,
  resolveCurrentDepth: () => resolveCurrentDepth,
  helperStarted: () => helperStarted,
  helperFinished: () => helperFinished,
  getSubscriptionState: () => getSubscriptionState,
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
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [wake-listener] ${args.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ")}
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
async function resolveCurrentDepth(sessionId) {
  if (_currentDepth !== null)
    return _currentDepth;
  let depth = 0;
  let currentId = sessionId;
  try {
    for (let i2 = 0;i2 < 10; i2++) {
      if (!_sdkClient) {
        dbg("resolveCurrentDepth: no sdkClient");
        break;
      }
      const { data: session } = await _sdkClient.session.get({ path: { id: currentId } });
      if (!session)
        break;
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
`).find((l2) => l2.startsWith("data: "));
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
`).find((l2) => l2.startsWith("data: "));
          if (teamDataLine) {
            const teamRpc = JSON.parse(teamDataLine.substring(6));
            const teamContent = teamRpc?.result?.content?.[0]?.text;
            if (teamContent) {
              const teamParsed = JSON.parse(teamContent);
              const members = teamParsed?.results?.[0]?.result ?? [];
              const teammateIds = members.map((m2) => m2.memberId ?? m2.id).filter((id) => id && id !== memberId);
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
`).find((l2) => l2.startsWith("data: "));
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
      } catch (e2) {
        dbg(`fetchIdentity: team fetch failed: ${e2?.message}`);
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
  } catch (e2) {
    dbg(`fetchIdentity: failed: ${e2?.message}`);
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
  const p2 = event.payload;
  const esc = (s2) => s2.replace(/"/g, "&quot;");
  const tag = `<system-reminder type="wake" source="${esc(event.source)}" priority="${event.priority}" event-id="${esc(event.eventId)}">`;
  const end = `</system-reminder>`;
  let identityBlock = "";
  if (identity) {
    const teammatesList = identity.teammates.length > 0 ? identity.teammates.map((t2) => `${t2.name} (${t2.roleName ?? "?"})`).join(", ") : "none";
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
      const chId = p2.channel_id ?? p2.channelId ?? "";
      const sendName = p2.sender_name ?? p2.senderName ?? p2.senderId ?? "unknown";
      const text = p2.text ?? "(no text)";
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
      const taskId = p2.task_id ?? p2.taskId ?? p2.entityId ?? "";
      body = [
        `## Task Assigned: ${p2.title ?? "Unknown"}`,
        taskId ? `Task: \`${taskId}\`` : "",
        p2.description ? `> ${p2.description}` : "",
        `Accept: \`todo_tasks({action:"set_status", task_id:"${taskId}", status:"started"})\``,
        `Details: \`todo_tasks({action:"show", task_id:"${taskId}"})\``
      ].filter(Boolean).join(`
`);
      break;
    }
    case WAKE_EVENT_TYPES.COMMENT_ADDED: {
      const entityId = p2.entity_id ?? p2.entityId ?? "";
      body = [
        `## Comment on ${p2.title ?? entityId}`,
        `From: ${p2.actor_name ?? p2.actorId ?? "unknown"}`,
        `Read: \`todo_comments({action:"list", task_id:"${entityId}"})\``
      ].join(`
`);
      break;
    }
    case WAKE_EVENT_TYPES.DELEGATION_RECEIVED: {
      const taskId = p2.task_id ?? p2.taskId ?? p2.entityId ?? "";
      body = [
        `## Delegation: ${p2.title ?? "Unknown"}`,
        `From: ${p2.delegator ?? p2.delegated_by ?? p2.fromId ?? "unknown"}`,
        `Accept: \`todo_tasks({action:"accept_delegation", task_id:"${taskId}"})\``,
        `Details: \`todo_tasks({action:"show", task_id:"${taskId}"})\``
      ].join(`
`);
      break;
    }
    case WAKE_EVENT_TYPES.STATUS_CHANGED: {
      const taskId = p2.task_id ?? p2.taskId ?? p2.entityId ?? "";
      const status = p2.status ?? p2.changes?.status?.to ?? "?";
      const title = p2.title ?? taskId;
      body = [
        `## Task Status: ${title} \u2192 ${status}`,
        `View: \`todo_tasks({action:"show", task_id:"${taskId}"})\``
      ].join(`
`);
      break;
    }
    default:
      body = `Event: ${event.type}
${JSON.stringify(p2, null, 2)}`;
  }
  return identityBlock ? `${identityBlock}
${tag}
${body}
${end}` : `${tag}
${body}
${end}`;
}
async function isAgentBusy() {
  try {
    if (!_sdkClient)
      return false;
    const { data } = await _sdkClient.session.status();
    return data?.sessions?.some?.((s2) => s2.status === "streaming" || s2.status === "busy") ?? false;
  } catch {
    return false;
  }
}
async function resolveSessionId(sessionId) {
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
  if (_agentDirectory) {
    try {
      if (!_sdkClient) {
        dbg("resolveSessionId: no sdkClient");
        return null;
      }
      const { data: sessions } = await _sdkClient.session.list();
      if (!Array.isArray(sessions))
        return null;
      const match = sessions.find((s2) => s2.directory === _agentDirectory);
      if (match) {
        _cachedSessionId = match.id;
        dbg(`resolveSessionId by directory ${_agentDirectory}: ${_cachedSessionId}`);
        if (_discoveryPath) {
          try {
            const disc = JSON.parse(readFileSync(_discoveryPath, "utf-8"));
            disc.sessionId = _cachedSessionId;
            const tmpPath = _discoveryPath + ".tmp";
            writeFileSync(tmpPath, JSON.stringify(disc));
            renameSync(tmpPath, _discoveryPath);
          } catch {}
        }
        return _cachedSessionId;
      }
    } catch (e2) {
      dbg(`resolveSessionId by directory failed: ${e2?.message}`);
    }
  }
  dbg("resolveSessionId: no session ID yet, events will queue");
  return null;
}
async function injectWakeEvent(event, sessionId) {
  const resolvedSessionId = await resolveSessionId(sessionId);
  if (!resolvedSessionId) {
    dbg("inject: no valid sessionId");
    return false;
  }
  if (!_sdkClient) {
    dbg("inject: no sdkClient");
    return false;
  }
  const text = formatWakeMessage(event, _agentIdentity);
  try {
    const { error } = await _sdkClient.session.promptAsync({
      path: { id: resolvedSessionId },
      body: { noReply: false, parts: [{ type: "text", text }] }
    });
    if (!error) {
      dbg(`inject OK: session=${resolvedSessionId}`);
      return true;
    }
    dbg(`inject failed: ${error}`);
    return false;
  } catch (e2) {
    dbg(`inject error: ${e2?.message}`);
    return false;
  }
}
async function startWakeListener(config) {
  _agentDirectory = process.cwd();
  _sdkClient = config.sdkClient ?? null;
  if (config.memberId) {
    try {
      _agentIdentity = await fetchIdentity(config.memberId, config.synqtaskUrl, config.identityFetchTimeoutMs);
      dbg(`identity: ${_agentIdentity?.name ?? "null"} role=${_agentIdentity?.roleName ?? "none"} team=${_agentIdentity?.teamName ?? "none"} teammates=${_agentIdentity?.teammates?.length ?? 0}`);
    } catch (e2) {
      dbg(`identity fetch failed (non-fatal): ${e2?.message}`);
    }
  }
  if (_agentIdentity?.teamPlaybook) {
    try {
      const playbookSessionId = await resolveSessionId(config.sessionId);
      if (playbookSessionId) {
        const playbookText = `<team-playbook team="${_agentIdentity.teamName ?? "unknown"}">
${_agentIdentity.teamPlaybook}
</team-playbook>`;
        if (!_sdkClient) {
          dbg("playbook: no sdkClient");
        } else {
          await _sdkClient.session.prompt({
            path: { id: playbookSessionId },
            body: { noReply: true, parts: [{ type: "text", text: playbookText }] }
          });
          dbg("playbook injected at session start");
        }
      }
    } catch (e2) {
      dbg(`playbook injection failed (non-fatal): ${e2?.message}`);
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
    } catch (e2) {
      dbg("request handler error:", e2?.message);
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
      } catch (e2) {
        dbg("engine evaluateExternal error, falling back:", e2?.message);
      }
    }
    const busy = await isAgentBusy();
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
    const injected = await injectWakeEvent(event, config.sessionId);
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
      _currentSubscribe = config.subscribe ?? null;
      _currentSubscribePreset = config.subscribePreset ?? null;
      _currentMemberType = config.memberType ?? "unknown";
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
        maxSubagents: _agentIdentity?.budget?.maxSubagents ?? 5,
        subscribe: _currentSubscribe,
        subscribePreset: _currentSubscribePreset,
        memberType: _currentMemberType
      };
      const tmpPath = discoveryPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(discoveryData));
      renameSync(tmpPath, discoveryPath);
      _discoveryPath = discoveryPath;
      dbg(`discovery file written: ${discoveryPath} depth=${discoveryData.spawnDepth} parent=${discoveryData.parentMemberId ?? "ROOT"}`);
    } catch (e2) {
      dbg("discovery file write failed:", e2?.message);
    }
  } else {
    dbg("skipping discovery file: no memberId configured (non-agent session)");
  }
  const drainInterval = setInterval(async () => {
    if (queue.length === 0)
      return;
    try {
      if (await isAgentBusy())
        return;
      const event = queue.shift();
      const ok = await injectWakeEvent(event, config.sessionId);
      dbg(`drain: ${event.eventId} ${ok ? "injected" : "failed"}`);
    } catch (e2) {
      dbg("drain error:", e2?.message);
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
  } catch (e2) {
    dbg("stopWakeListener error:", e2?.message);
  }
}
function updateDiscovery(update) {
  if (!_discoveryPath) {
    dbg("updateDiscovery: no discovery path (listener not started or no memberId)");
    return false;
  }
  try {
    const raw = readFileSync(_discoveryPath, "utf-8");
    const current = JSON.parse(raw);
    if (update.subscribe !== undefined) {
      current.subscribe = update.subscribe;
      _currentSubscribe = update.subscribe;
    }
    if (update.subscribePreset !== undefined) {
      current.subscribePreset = update.subscribePreset;
      _currentSubscribePreset = update.subscribePreset;
    }
    if (update.memberType !== undefined) {
      current.memberType = update.memberType;
      _currentMemberType = update.memberType;
    }
    const tmpPath = _discoveryPath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(current));
    renameSync(tmpPath, _discoveryPath);
    dbg(`updateDiscovery: subscribe=${JSON.stringify(current.subscribe)} preset=${current.subscribePreset}`);
    return true;
  } catch (e2) {
    dbg(`updateDiscovery failed: ${e2?.message}`);
    return false;
  }
}
function getSubscriptionState() {
  return {
    subscribe: _currentSubscribe,
    subscribePreset: _currentSubscribePreset,
    memberType: _currentMemberType,
    discoveryPath: _discoveryPath,
    memberId: _agentIdentity?.memberId ?? null,
    memberName: _agentIdentity?.name ?? null
  };
}
var DEBUG, LOG_FILE, MAX_QUEUE_DEFAULT = 50, BUSY_RETRY_INTERVAL_DEFAULT = 5, STARTUP_TS, warmChannels, _agentIdentity = null, _sdkClient = null, _currentSubscribe = null, _currentSubscribePreset = null, _currentMemberType = "unknown", _spawnTotal = 0, _currentDepth = null, _inheritedDepth, _parentMemberId, _parentSessionId, HELPER_TIMEOUT_MS = 60000, _activeHelperTimestamps, _cachedSessionId = null, _discoveryPath = null, _agentDirectory = null;
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
  const sorted = [...actions].sort((a2, b2) => {
    const ai = ACTION_ORDER.indexOf(a2.type);
    const bi = ACTION_ORDER.indexOf(b2.type);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  const results = [];
  process.env.SIGNAL_WIRE_ACTIVE = "1";
  try {
    for (const action of sorted) {
      try {
        const result = await executeAction(action, ctx);
        results.push(result);
      } catch (e2) {
        dbg2(`action ${action.type} error:`, e2?.message);
        results.push({ type: action.type, success: false, error: e2?.message ?? "unknown" });
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
  } catch (e2) {
    dbg2(`exec error:`, e2?.message);
    return { type: "exec", success: false, error: e2?.message };
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
      const teammates = identity.teammates?.length > 0 ? identity.teammates.map((t2) => `${t2.name} (${t2.roleName ?? "?"})`).join(", ") : "none";
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
  if (!ctx.sdkClient) {
    dbg2("wake: no sdkClient in ActionContext");
    return { type: "wake", success: false, error: "no sdkClient" };
  }
  try {
    const { error } = await ctx.sdkClient.session.promptAsync({
      path: { id: ctx.sessionId },
      body: { noReply: false, parts: [{ type: "text", text }] }
    });
    if (!error) {
      dbg2("WAKE: injected via sdkClient.promptAsync");
      return { type: "wake", success: true, wakeTriggered: true };
    }
    const { error: err2 } = await ctx.sdkClient.session.prompt({
      path: { id: ctx.sessionId },
      body: { noReply: false, parts: [{ type: "text", text }] }
    });
    if (!err2) {
      dbg2("WAKE: injected via sdkClient.prompt");
      return { type: "wake", success: true, wakeTriggered: true };
    }
    return { type: "wake", success: false, error: `SDK error: ${err2}` };
  } catch (e2) {
    dbg2("wake SDK error:", e2?.message);
    return { type: "wake", success: false, error: e2?.message };
  }
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
  } catch (e2) {
    dbg2(`respond error:`, e2?.message);
    return { type: "respond", success: false, error: e2?.message };
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
      }).catch((e2) => dbg2("telegram notify error:", e2?.message));
    } else {
      dbg2("notify: telegram not configured (SIGNAL_WIRE_TG_TOKEN / SIGNAL_WIRE_TG_CHAT_ID)");
    }
  } else if (channel === "webhook" && action.target) {
    fetch(action.target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rule: ctx.ruleId, severity: ctx.severity, message: template, event: ctx.event })
    }).catch((e2) => dbg2("webhook notify error:", e2?.message));
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
  } catch (e2) {
    dbg3("ensureDir error:", e2?.message);
  }
}
function writeAuditEntry(entry) {
  try {
    ensureDir();
    rotateIfNeeded();
    appendFileSync2(AUDIT_FILE, JSON.stringify(entry) + `
`);
  } catch (e2) {
    dbg3("writeAuditEntry error:", e2?.message);
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
function emitLegacyBanner(rulesCount, platform) {
  if (legacyBannerEmitted)
    return;
  legacyBannerEmitted = true;
  try {
    appendFileSync3(LOG_FILE2, `[${new Date().toISOString()}] [${LEGACY_ID}] LEGACY_BANNER online platform=${platform} rules=${rulesCount}
`);
  } catch {}
}
function dbg4(...args) {
  if (!DEBUG4)
    return;
  try {
    appendFileSync3(LOG_FILE2, `[${new Date().toISOString()}] [${LEGACY_ID}] [signal-wire] ${args.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ")}
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
  sdkClient = null;
  disabledRules = new Set;
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
    rules = rules.filter((r2) => !r2.platforms || r2.platforms.includes(this.platform));
    this.rules = Object.freeze(rules);
    this.rulesV2 = Object.freeze(this.rules.map((r2) => migrateRule(r2)));
    if (!this.sessionIdResolved)
      this.resolveSessionId();
    emitLegacyBanner(this.rules.length, this.platform);
    dbg4(`init: ${this.rules.length} rules loaded (platform=${this.platform}), server=${this.serverUrl}, session=${this.sessionId}`);
  }
  setSdkClient(client) {
    this.sdkClient = client;
    if (!this.sessionIdResolved)
      this.resolveSessionId();
  }
  toggleRule(ruleId, enabled) {
    const exists = this.rules.some((r2) => r2.id === ruleId);
    if (!exists)
      return false;
    if (enabled) {
      this.disabledRules.delete(ruleId);
    } else {
      this.disabledRules.add(ruleId);
    }
    dbg4(`toggleRule: ${ruleId} \u2192 ${enabled ? "enabled" : "disabled"}`);
    return true;
  }
  listRules() {
    return this.rules.map((r2) => ({
      id: r2.id,
      description: r2.description ?? "",
      enabled: !this.disabledRules.has(r2.id) && r2.enabled !== false,
      events: r2.events
    }));
  }
  isRuleEnabled(ruleId) {
    return !this.disabledRules.has(ruleId);
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
    } catch (e2) {
      dbg4(`failed to load rules from ${path}:`, e2.message);
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
    } catch (e2) {
      dbg4("trackTokens error:", e2.message);
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
        if (this.disabledRules.has(rule.id))
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
      const ids = results.map((r2) => r2.ruleId);
      const combined = results.map((r2) => `\u26A1 signal-wire: ${r2.ruleId}
${r2.hint}`).join(`

`);
      this.notifyTui(ids, combined);
      return {
        ruleId: ids.join("+"),
        hint: combined
      };
    } catch (e2) {
      dbg4("evaluate error:", e2.message);
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
        } catch (e2) {
          dbg4(`invalid regex in rule ${rule.id}.tool:`, e2.message);
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
        } catch (e2) {
          dbg4(`invalid regex in rule ${rule.id}.input_regex:`, e2.message);
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
        } catch (e2) {
          dbg4(`invalid regex in rule ${rule.id}.response_regex:`, e2.message);
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
        } catch (e2) {
          dbg4(`invalid regex in rule ${rule.id}.prompt_regex:`, e2.message);
          return false;
        }
      }
      return true;
    } catch (e2) {
      dbg4(`matchRule error for ${rule.id}:`, e2.message);
      return false;
    }
  }
  deepMatch(data, pattern) {
    if (pattern === null || pattern === undefined)
      return data === pattern;
    if (typeof pattern === "object" && !Array.isArray(pattern)) {
      if (typeof data !== "object" || data === null || Array.isArray(data))
        return false;
      return Object.entries(pattern).every(([k2, v2]) => (k2 in data) && this.deepMatch(data[k2], v2));
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
    } catch (e2) {
      dbg4("checkCooldown error:", e2.message);
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
    } catch (e2) {
      dbg4("markCooldown error:", e2.message);
    }
  }
  substituteVars(template, rule, ctx) {
    if (!template)
      return template;
    return template.replace(/\{tool_name\}/g, ctx.lastToolName).replace(/\{session_id\}/g, this.sessionId).replace(/\{cwd\}/g, process.cwd()).replace(/\{rule_id\}/g, rule.id);
  }
  resolveSessionId() {
    if (this.sessionIdResolved)
      return;
    if (!this.sdkClient)
      return;
    this.sessionIdResolved = true;
    const cwd = process.cwd();
    this.sdkClient.session.list().then(({ data: sessions }) => {
      if (!Array.isArray(sessions))
        return;
      const matching = sessions.filter((s2) => s2.directory === cwd && !s2.parentID).sort((a2, b2) => (b2.time?.updated ?? 0) - (a2.time?.updated ?? 0));
      if (matching.length) {
        this.sessionId = matching[0].id;
        dbg4(`signal-wire: resolved sessionId=${this.sessionId} (cwd=${cwd}, matched ${matching.length} sessions)`);
      }
    }).catch((e2) => dbg4("resolveSessionId error:", e2?.message));
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
    } catch (e2) {
      dbg4("notifyTui error:", e2.message);
    }
  }
  doTuiPost(ids, hint) {
    try {
      if (!this.sessionId || this.sessionId === "?" || this.sessionId === "unknown") {
        dbg4("TUI POST skipped: no sessionId after retry");
        return;
      }
      if (!this.sdkClient) {
        dbg4("TUI POST skipped: no sdkClient");
        return;
      }
      const label = ids.join("+");
      const formatted = this.formatTuiMessage(ids, hint);
      this.sdkClient.session.prompt({
        path: { id: this.sessionId },
        body: {
          noReply: true,
          parts: [{ type: "text", text: formatted, synthetic: true }]
        }
      }).then(() => dbg4(`TUI POST ${label}: ok`)).catch((e2) => dbg4(`TUI POST ${label} failed:`, e2?.message));
    } catch (e2) {
      dbg4("notifyTui error:", e2?.message);
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
        }).catch((e2) => {
          clearTimeout(timer);
          dbg4(`exec error for rule ${rule.id}:`, e2.message);
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
        proc.on("error", (e2) => {
          clearTimeout(timer);
          dbg4(`exec error for rule ${rule.id}:`, e2.message);
        });
      }
      dbg4(`exec spawned for rule ${rule.id}: ${cmd.slice(0, 120)}`);
    } catch (e2) {
      dbg4(`execFireAndForget error for rule ${rule.id}:`, e2.message);
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
          auditWriter: createAuditWriter(this.sessionId),
          sdkClient: this.sdkClient
        };
        const actionResults = await dispatchActions(actions, ctx);
        results.push(...actionResults);
        const blockResult = actionResults.find((r2) => r2.type === "block" && r2.success);
        if (blockResult)
          blocked = true;
        const hintResults = actionResults.filter((r2) => r2.type === "hint" && r2.hintText);
        if (hintResults.length > 0) {
          hintText += (hintText ? `
` : "") + hintResults.map((r2) => r2.hintText).join(`
`);
        }
      }
      const v1Result = hintText ? { ruleId: matched[0].id, hint: hintText } : null;
      return { v1Result, v2Results: results, blocked };
    } catch (e2) {
      dbg4("evaluateHookV2 error:", e2?.message);
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
          auditWriter: createAuditWriter(this.sessionId),
          sdkClient: this.sdkClient
        };
        const actionResults = await dispatchActions(actions, ctx);
        allResults.push(...actionResults);
        if (actionResults.some((r2) => r2.type === "wake" && r2.wakeTriggered)) {
          wakeTriggered = true;
        }
      }
      return { matched: true, actionsExecuted: allResults, wakeTriggered };
    } catch (e2) {
      dbg4("evaluateExternal error:", e2?.message);
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
      if (!rule.events.some((e2) => externalEvents.includes(e2)))
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
    } catch (e2) {
      dbg4("checkCooldownV2 error:", e2?.message);
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
    } catch (e2) {
      dbg4("markCooldownV2 error:", e2?.message);
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
  const p2 = event.payload;
  switch (event.type) {
    case "task_assigned":
      return [
        `## Wake: New Task Assigned`,
        ``,
        `### Task Details`,
        p2.task_id || p2.entityId ? `- **Task ID:** \`${p2.task_id ?? p2.entityId}\`` : "",
        `- **Title:** ${p2.title ?? "Unknown"}`,
        p2.description ? `- **Description:** ${p2.description}` : "",
        p2.list || p2.listName ? `- **List:** ${p2.list ?? p2.listName}` : "",
        p2.priority ? `- **Priority:** ${p2.priority}` : "",
        p2.assigned_by || p2.actorId ? `- **Assigned by:** ${p2.assigned_by ?? p2.actorId}` : "",
        p2.due || p2.dueDate ? `- **Due:** ${p2.due ?? p2.dueDate}` : "",
        ``,
        `### How to Work on This`,
        `1. Accept: \`synqtask_todo_tasks({action: "set_status", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}", status: "started"})\``,
        `2. Read full task: \`synqtask_todo_tasks({action: "show", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}"})\``,
        `3. Do the work described above`,
        `4. When done: \`synqtask_todo_tasks({action: "set_status", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}", status: "done"})\``,
        `5. Add result: \`synqtask_todo_comments({action: "add_result", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}", text: "Done: <summary>"})\``
      ].filter(Boolean).join(`
`);
    case "channel_message": {
      const chId = p2.channel_id ?? p2.channelId ?? "";
      const sendId = p2.sender_id ?? p2.senderId ?? "";
      const sendName = p2.sender_name ?? p2.senderName ?? "";
      const isDirect = p2.is_direct ?? p2.isDirect ?? false;
      return [
        `## Wake: New Channel Message`,
        ``,
        `### Message Details`,
        chId ? `- **Channel ID:** \`${chId}\`` : "",
        p2.channel_name ?? p2.channelName ? `- **Channel:** ${p2.channel_name ?? p2.channelName}` : "",
        sendName ? `- **From:** ${sendName}` : "",
        isDirect ? `- **Type:** Direct message to you` : `- **Type:** Channel broadcast`,
        ``,
        `### Message`,
        p2.text ? `> ${p2.text}` : "> (no text)",
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
        p2.task_id || p2.entityId ? `- **Task ID:** \`${p2.task_id ?? p2.entityId}\`` : "",
        `- **Title:** ${p2.title ?? "Unknown"}`,
        p2.delegator || p2.delegated_by ? `- **Delegated by:** ${p2.delegator ?? p2.delegated_by}` : "",
        p2.delegator_id ? `- **Delegator ID:** \`${p2.delegator_id}\`` : "",
        p2.notes ? `- **Notes:** ${p2.notes}` : "",
        ``,
        `### How to Handle`,
        `1. Accept: \`synqtask_todo_tasks({action: "accept_delegation", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}"})\``,
        `2. Read task: \`synqtask_todo_tasks({action: "show", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}"})\``,
        `3. Do the work`,
        `4. Complete: \`synqtask_todo_tasks({action: "set_status", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}", status: "done"})\``
      ].filter(Boolean).join(`
`);
    case "comment_added":
      return [
        `## Wake: New Comment on Task`,
        ``,
        `### Comment Details`,
        p2.task_id || p2.entityId ? `- **Task ID:** \`${p2.task_id ?? p2.entityId}\`` : "",
        p2.task_title ? `- **Task:** ${p2.task_title}` : "",
        p2.commenter || p2.actorId ? `- **From:** ${p2.commenter ?? p2.actorId}` : "",
        p2.commenter_id ? `- **Commenter ID:** \`${p2.commenter_id}\`` : "",
        ``,
        `### Comment`,
        p2.text ? `> ${p2.text}` : "> (no text)",
        ``,
        `### How to Reply`,
        `Reply: \`synqtask_todo_comments({action: "add", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}", text: "YOUR REPLY"})\``,
        `View all: \`synqtask_todo_comments({action: "list", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}"})\``
      ].filter(Boolean).join(`
`);
    case "status_changed":
      return [
        `## Wake: Task Status Changed`,
        ``,
        p2.task_id || p2.entityId ? `- **Task ID:** \`${p2.task_id ?? p2.entityId}\`` : "",
        p2.title ? `- **Task:** ${p2.title}` : "",
        p2.changes?.status ? `- **Status:** ${p2.changes.status.from ?? "?"} \u2192 ${p2.changes.status.to ?? "?"}` : "",
        p2.actorId ? `- **Changed by:** ${p2.actorId}` : "",
        ``,
        `View task: \`synqtask_todo_tasks({action: "show", task_id: "${p2.task_id ?? p2.entityId ?? "TASK_ID"}"})\``
      ].filter(Boolean).join(`
`);
    case "webhook_event":
      return [
        `## Wake: External Event`,
        ``,
        `- **Source:** ${event.source}`,
        p2.webhook_type ? `- **Type:** ${p2.webhook_type}` : "",
        ``,
        `### Payload`,
        "```json",
        JSON.stringify(p2, null, 2),
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
        JSON.stringify(p2, null, 2),
        "```",
        ``,
        `Review and respond as appropriate.`
      ].join(`
`);
  }
}
function esc(s2) {
  return s2.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
var DEBUG4, LOG_FILE2, DEFAULT_EXEC_TIMEOUT_S = 15, LEGACY_VERSION = "legacy-v1.x", LEGACY_BOOT_TIME, LEGACY_ID, legacyBannerEmitted = false;
var init_signal_wire = __esm(() => {
  init_wake_types();
  init_signal_wire_actions();
  init_signal_wire_audit();
  DEBUG4 = process.env.SIGNAL_WIRE_DEBUG !== "0";
  LOG_FILE2 = join4(homedir4(), ".claude", "signal-wire-debug.log");
  LEGACY_BOOT_TIME = new Date().toISOString();
  LEGACY_ID = `sw-legacy ${LEGACY_VERSION}@${LEGACY_BOOT_TIME.slice(11, 19)} pid=${process.pid}`;
});

// index.ts
import { createHash, randomBytes } from "crypto";
import { readFileSync as readFileSync5, writeFileSync as writeFileSync4, mkdirSync as mkdirSync6, chmodSync, existsSync as existsSync6, statSync as statSync3 } from "fs";
import { join as join11, dirname as dirname4 } from "path";
import { homedir as homedir11 } from "os";

// provider.ts
import { appendFileSync as _traceWrite } from "fs";

// ../../dist/index.js
import { createHash as a, randomBytes as n } from "crypto";
import { writeFileSync as o, readFileSync as l, mkdirSync as h, chmodSync as c } from "fs";
import { dirname as u, join as d } from "path";
import { homedir as f } from "os";
import { createHash as O, randomBytes as I, randomUUID as N } from "crypto";
import { readFileSync as L, writeFileSync as F, chmodSync as B, mkdirSync as P, rmdirSync as J, statSync as K, readdirSync as H, unlinkSync as U, appendFileSync as j } from "fs";
import { join as W } from "path";
import { homedir as q } from "os";
import { readFileSync as $t, writeFileSync as bt, mkdirSync as xt } from "fs";
import { dirname as Ct } from "path";
import { randomUUID as Dt } from "crypto";
import { spawn as At, spawnSync as Mt } from "child_process";
import { request as Ot } from "https";
import { randomBytes as It, createHash as Nt } from "crypto";
var t = Object.defineProperty;
var e = Object.getOwnPropertyNames;
var i = (e2, i2) => t(e2, "name", { value: i2, configurable: true });
var s = ((t2) => "function" < "u" ? __require : typeof Proxy < "u" ? new Proxy(t2, { get: (t3, e2) => ("function" < "u" ? __require : t3)[e2] }) : t2)(function(t2) {
  if ("function" < "u")
    return __require.apply(this, arguments);
  throw Error('Dynamic require of "' + t2 + '" is not supported');
});
var r = {};
((e2, i2) => {
  for (var s2 in i2)
    t(e2, s2, { get: i2[s2], enumerable: true });
})(r, { getClaudeConfigDir: () => p, getDefaultCredentialsPath: () => m, oauthLogin: () => _ });
function p() {
  return (process.env.CLAUDE_CONFIG_DIR ?? d(f(), ".claude")).normalize("NFC");
}
function m() {
  return d(p(), ".credentials.json");
}
function y() {
  return k(n(32));
}
function g(t2) {
  return k(a("sha256").update(t2).digest());
}
function w() {
  return k(n(32));
}
function k(t2) {
  return t2.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
async function _(t2 = {}) {
  let e2 = t2.credentialsPath ?? m(), i2 = y(), s2 = g(i2), r2 = w(), { port: a2, waitForCode: n2, close: d2 } = await T(r2, t2.port), f2 = `http://localhost:${a2}/callback`, p2 = t2.loginWithClaudeAi !== false ? x : b, k2 = new URLSearchParams({ client_id: v, response_type: "code", scope: R, code_challenge: s2, code_challenge_method: "S256", state: r2, code: "true" });
  t2.loginHint && k2.set("login_hint", t2.loginHint), t2.loginMethod && k2.set("login_method", t2.loginMethod), t2.orgUUID && k2.set("orgUUID", t2.orgUUID);
  let _2, $, E = `${p2}?${k2.toString()}&redirect_uri=${encodeURIComponent(f2)}`, A = `${p2}?${k2.toString()}&redirect_uri=${encodeURIComponent(D)}`;
  t2.onAuthUrl ? t2.onAuthUrl(E, A) : (console.log(`
\uD83D\uDD10 Login to Claude
`), console.log(`Open this URL in your browser:
`), console.log(`  ${A}
`)), t2.openBrowser !== false && S(E).catch(() => {});
  try {
    _2 = await n2, $ = f2;
  } catch (t3) {
    throw d2(), t3;
  }
  d2();
  let M = await fetch(C, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: _2, redirect_uri: $, client_id: v, code_verifier: i2, state: r2 }) });
  if (!M.ok) {
    let t3 = await M.text();
    throw new Error(`Token exchange failed (${M.status}): ${t3}`);
  }
  let O2 = await M.json(), I2 = Date.now() + 1000 * O2.expires_in, N2 = { accessToken: O2.access_token, refreshToken: O2.refresh_token, expiresAt: I2, scopes: O2.scope?.split(" ") ?? [] }, L2 = {};
  try {
    L2 = JSON.parse(l(e2, "utf8"));
  } catch {}
  L2.claudeAiOauth = N2;
  let F2 = u(e2);
  try {
    h(F2, { recursive: true });
  } catch {}
  return o(e2, JSON.stringify(L2, null, 2), "utf8"), c(e2, 384), console.log(`
\u2705 Login successful! Credentials saved to ${e2}
`), { accessToken: N2.accessToken, refreshToken: N2.refreshToken, expiresAt: N2.expiresAt, credentialsPath: e2 };
}
async function T(t2, e2) {
  let s2, r2, a2 = new Promise((t3, e3) => {
    s2 = t3, r2 = e3;
  }), n2 = Bun.serve({ port: e2 ?? 0, async fetch(e3) {
    let i2 = new URL(e3.url);
    if (i2.pathname !== "/callback")
      return new Response("Not found", { status: 404 });
    let a3 = i2.searchParams.get("code"), n3 = i2.searchParams.get("state"), o3 = i2.searchParams.get("error");
    return o3 ? (r2(new Error(`OAuth error: ${o3} \u2014 ${i2.searchParams.get("error_description") ?? ""}`)), new Response("<html><body><h1>Login failed</h1><p>You can close this tab.</p></body></html>", { status: 400, headers: { "Content-Type": "text/html" } })) : a3 && n3 === t2 ? (s2(a3), new Response(null, { status: 302, headers: { Location: `${$}/oauth/code/success?app=claude-code` } })) : (r2(new Error("Invalid callback: missing code or state mismatch")), new Response("Invalid request", { status: 400 }));
  } }), o2 = setTimeout(() => {
    r2(new Error("Login timed out (5 minutes). Try again.")), n2.stop();
  }, 300000);
  return { port: n2.port, waitForCode: a2.finally(() => clearTimeout(o2)), close: i(() => {
    clearTimeout(o2), n2.stop();
  }, "close") };
}
async function S(t2) {
  let e2 = (() => {
    switch (process.platform) {
      case "darwin":
        return [["open", t2]];
      case "win32":
        return [["cmd", "/c", "start", t2]];
      default:
        return [["xdg-open", t2], ["wslview", t2], ["sensible-browser", t2]];
    }
  })();
  for (let t3 of e2)
    try {
      let e3 = Bun.spawn({ cmd: t3, stdout: "ignore", stderr: "ignore" });
      if (await e3.exited, e3.exitCode === 0)
        return;
    } catch {}
}
var v;
var $;
var b;
var x;
var C;
var D;
var R;
var E;
var A;
var M = (E = { "src/auth.ts"() {
  v = "9d1c250a-e61b-44d9-88ed-5944d1962f5e", b = ($ = "https://platform.claude.com") + "/oauth/authorize", x = "https://claude.com/cai/oauth/authorize", C = `${$}/v1/oauth/token`, D = `${$}/oauth/code/callback`, i(p, "getClaudeConfigDir"), i(m, "getDefaultCredentialsPath"), R = ["user:profile", "user:inference", "org:create_api_key", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"].join(" "), i(y, "generateCodeVerifier"), i(g, "generateCodeChallenge"), i(w, "generateState"), i(k, "base64url"), i(_, "oauthLogin"), i(T, "startCallbackServer"), i(S, "tryOpenBrowser");
} }, function() {
  return E && (A = (0, E[e(E)[0]])(E = 0)), A;
});
var z = class extends Error {
  constructor(t2, e2) {
    super(t2), this.cause = e2, this.name = "ClaudeCodeSDKError";
  }
  static {
    i(this, "ClaudeCodeSDKError");
  }
};
var G = class extends z {
  static {
    i(this, "AuthError");
  }
  constructor(t2, e2) {
    super(t2, e2), this.name = "AuthError";
  }
};
var V = class extends z {
  constructor(t2, e2, i2, s2) {
    super(t2, s2), this.status = e2, this.requestId = i2, this.name = "APIError";
  }
  static {
    i(this, "APIError");
  }
};
var Y = class extends z {
  constructor(t2, e2, i2 = 429, s2) {
    super(t2, s2), this.rateLimitInfo = e2, this.status = i2, this.name = "RateLimitError";
  }
  static {
    i(this, "RateLimitError");
  }
};
var X = class extends z {
  constructor(t2, e2, i2) {
    super(`CACHE_REWRITE_BLOCKED: session idle ${Math.round(t2 / 1000)}s on model=${i2}, next request would cost ~${e2} cache_write tokens. Unset CLAUDE_MAX_REWRITE_BLOCK or raise CLAUDE_MAX_REWRITE_BLOCK_IDLE_SEC to proceed.`), this.idleMs = t2, this.estimatedTokens = e2, this.model = i2, this.name = "CacheRewriteBlockedError";
  }
  static {
    i(this, "CacheRewriteBlockedError");
  }
  code = "CACHE_REWRITE_BLOCKED";
};
var Q = { "claude-opus-4-7": { name: "Claude Opus 4.7", context: 1e6, defaultOutput: 64000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 } }, "claude-opus-4-6": { name: "Claude Opus 4.6", context: 1e6, defaultOutput: 64000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 } }, "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", context: 1e6, defaultOutput: 32000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, "claude-haiku-4-5-20251001": { name: "Claude Haiku 4.5", context: 200000, defaultOutput: 32000, maxOutput: 64000, adaptiveThinking: false, cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } } };
var Z = { defaultOutput: 32000, maxOutput: 128000, adaptiveThinking: false };
function tt(t2, e2) {
  if (typeof e2 == "number" && e2 > 0)
    return e2;
  let i2 = et(t2), s2 = i2?.maxOutput ?? Z.maxOutput, r2 = i2?.defaultOutput ?? Z.defaultOutput, a2 = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  if (a2) {
    let t3 = parseInt(a2, 10);
    if (Number.isFinite(t3) && t3 > 0)
      return Math.min(t3, s2);
  }
  return r2;
}
function et(t2) {
  if (Q[t2])
    return Q[t2];
  let e2 = t2.toLowerCase();
  for (let [t3, i2] of Object.entries(Q))
    if (e2.includes(t3) || t3.includes(e2))
      return i2;
  for (let [t3, i2] of Object.entries(Q)) {
    let s2 = t3.replace(/^claude-/, "").split("-").slice(0, 3).join("-");
    if (e2.includes(s2))
      return i2;
  }
}
function it(t2) {
  let e2 = et(t2);
  if (e2)
    return e2.adaptiveThinking;
  let i2 = t2.toLowerCase();
  return i2.includes("opus-4-7") || i2.includes("opus-4-6") || i2.includes("sonnet-4-6") || i2.includes("sonnet-4-7");
}
i(tt, "resolveMaxTokens"), i(et, "getModelMetadata"), i(it, "supportsAdaptiveThinking");
var st = W(q(), ".claude", "keepalive.json");
var rt = 0;
var at = null;
function nt() {
  try {
    let t2 = K(st);
    return t2.mtimeMs === rt && at || (rt = t2.mtimeMs, at = JSON.parse(L(st, "utf8"))), at;
  } catch {
    return null;
  }
}
i(nt, "readKeepaliveConfig");
var ot = 300000;
var lt = 0.25;
var ht = 300000;
var ct = 1200000;
var ut = W(q(), ".claude", ".refresh-cooldown");
var dt = 1800000;
var ft = "2.1.90";
var pt = { todowrite: "todo_write" };
var mt = Object.fromEntries(Object.entries(pt).map(([t2, e2]) => [e2, t2]));
function yt(t2) {
  if (!t2?.length)
    return { remapped: t2, didRemap: false };
  let e2 = false;
  return { remapped: t2.map((t3) => {
    let i2 = pt[t3.name];
    return i2 ? (e2 = true, { ...t3, name: i2 }) : t3;
  }), didRemap: e2 };
}
function gt(t2) {
  return mt[t2] ?? t2;
}
i(yt, "remapToolNames"), i(gt, "unremapToolName");
var wt = W(q(), ".claude", ".token-refresh-lock");
async function kt() {
  for (let t2 = 0;t2 < 5; t2++)
    try {
      return P(wt), F(W(wt, "pid"), `${process.pid}
${Date.now()}`), () => {
        try {
          U(W(wt, "pid")), J(wt);
        } catch {}
      };
    } catch (t3) {
      if (t3.code === "EEXIST") {
        try {
          let t4 = L(W(wt, "pid"), "utf8"), e2 = parseInt(t4.split(`
`)[1] ?? "0");
          if (Date.now() - e2 > 30000) {
            try {
              U(W(wt, "pid"));
            } catch {}
            try {
              J(wt);
            } catch {}
            continue;
          }
        } catch {}
        await new Promise((t4) => setTimeout(t4, 1000 + 1000 * Math.random()));
        continue;
      }
      return null;
    }
  return null;
}
i(kt, "acquireTokenRefreshLock");
var _t = class _ClaudeCodeSDK {
  static {
    i(this, "ClaudeCodeSDK");
  }
  accessToken = null;
  refreshToken = null;
  expiresAt = null;
  credentialStore;
  sessionId;
  deviceId;
  accountUuid;
  timeout;
  maxRetries;
  lastRateLimitInfo = { status: null, resetAt: null, claim: null, retryAfter: null, utilization5h: null, utilization7d: null };
  pending401 = null;
  lastFailedToken = null;
  pendingAuth = null;
  initialLoad = null;
  tokenRotationTimer = null;
  lastRefreshAttemptAt = 0;
  refreshConsecutive429s = 0;
  proactiveRefreshFailures = 0;
  tokenIssuedAt = 0;
  onTokenStatus;
  keepaliveConfig;
  lastKnownCacheTokensByModel = new Map;
  networkState = "healthy";
  healthProbeTimer = null;
  keepaliveRegistry = new Map;
  t = "";
  i = null;
  o = null;
  keepaliveLastActivityAt = 0;
  keepaliveTimer = null;
  keepaliveAbortController = null;
  keepaliveInFlight = false;
  keepaliveJitterMs = 0;
  keepaliveCacheWrittenAt = 0;
  keepaliveRetryTimer = null;
  keepaliveLastRealActivityAt = 0;
  cacheAnchorMessageCount = 0;
  constructor(t2 = {}) {
    this.sessionId = N(), this.deviceId = t2.deviceId ?? I(32).toString("hex"), this.accountUuid = t2.accountUuid ?? this.readAccountUuid(), this.timeout = t2.timeout ?? 600000, this.maxRetries = t2.maxRetries ?? 10, this.onTokenStatus = t2.onTokenStatus;
    let e2 = t2.keepalive ?? {}, i2 = e2.intervalMs ?? 120000;
    i2 < 60000 && (console.error(`[claude-sdk] keepalive intervalMs=${i2} below safe min (60000); clamped`), i2 = 60000), i2 > 240000 && (console.error(`[claude-sdk] keepalive intervalMs=${i2} above safe max (240000, cache TTL - 60s); clamped`), i2 = 240000), this.keepaliveConfig = { enabled: e2.enabled ?? true, intervalMs: i2, idleTimeoutMs: e2.idleTimeoutMs ?? 1 / 0, minTokens: e2.minTokens ?? 2000, rewriteWarnIdleMs: e2.rewriteWarnIdleMs ?? 300000, rewriteWarnTokens: e2.rewriteWarnTokens ?? 50000, rewriteBlockIdleMs: e2.rewriteBlockIdleMs ?? 1 / 0, rewriteBlockEnabled: e2.rewriteBlockEnabled ?? false, onHeartbeat: e2.onHeartbeat, onTick: e2.onTick, onDisarmed: e2.onDisarmed, onRewriteWarning: e2.onRewriteWarning, onNetworkStateChange: e2.onNetworkStateChange }, t2.credentialStore ? this.credentialStore = t2.credentialStore : t2.accessToken ? (this.accessToken = t2.accessToken, this.refreshToken = t2.refreshToken ?? null, this.expiresAt = t2.expiresAt ?? null, this.credentialStore = new St({ accessToken: t2.accessToken, refreshToken: t2.refreshToken ?? "", expiresAt: t2.expiresAt ?? 0 }), this.expiresAt && this.refreshToken && this.scheduleProactiveRotation()) : (this.credentialStore = new Tt(t2.credentialsPath ?? W(q(), ".claude", ".credentials.json")), this.initialLoad = this.loadFromStore().catch(() => {}));
  }
  async generate(t2) {
    let e2 = [];
    for await (let i2 of this.stream(t2))
      e2.push(i2);
    return this.assembleResponse(e2, t2.model);
  }
  async* stream(t2) {
    this.checkRewriteGuard(t2.model), await this.ensureAuth();
    let e2, i2 = this.buildRequestBody(t2), s2 = this.buildHeaders(t2);
    this.t = t2.model, this.i = JSON.parse(JSON.stringify(i2)), this.o = { ...s2 }, this.keepaliveAbortController?.abort(), this.keepaliveInFlight = false;
    for (let r2 = 1;r2 <= this.maxRetries + 1; r2++) {
      if (t2.signal?.aborted)
        throw new z("Aborted");
      try {
        return void (yield* this.doStreamRequest(i2, s2, t2.signal));
      } catch (i3) {
        if (e2 = i3, i3 instanceof V) {
          if (i3.status === 401 && r2 <= this.maxRetries) {
            await this.handleAuth401(), s2.Authorization = `Bearer ${this.accessToken}`;
            continue;
          }
          if (i3.status === 429)
            throw i3 instanceof Y ? i3 : new Y("Rate limited", this.lastRateLimitInfo, 429, i3);
          if (i3.status >= 500 && r2 <= this.maxRetries) {
            let e3 = this.getRetryDelay(r2, this.lastRateLimitInfo.retryAfter?.toString() ?? null);
            await this.sleep(e3, t2.signal);
            continue;
          }
        }
        throw i3;
      }
    }
    throw e2;
  }
  getRateLimitInfo() {
    return this.lastRateLimitInfo;
  }
  async* doStreamRequest(t2, e2, i2) {
    let r2 = new AbortController, a2 = setTimeout(() => r2.abort(), this.timeout);
    i2 && i2.addEventListener("abort", () => r2.abort(), { once: true });
    let n2, o2 = Date.now(), l2 = JSON.stringify(t2);
    try {
      let { appendFileSync: i3 } = s("fs");
      i3(W(q(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_START pid=${process.pid} model=${t2.model} msgs=${t2.messages?.length ?? 0}
`);
      let r3 = t2.tools?.map((t3) => t3.name).join(",") ?? "none", a3 = typeof t2.system == "string" ? t2.system.substring(0, 200) : JSON.stringify(t2.system)?.substring(0, 200);
      if (i3(W(q(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_REQ pid=${process.pid} headers=${JSON.stringify(e2).substring(0, 300)} tools=[${r3.substring(0, 500)}] sys=${a3} bodyLen=${l2.length}
`), process.env.CLAUDE_MAX_DUMP_REQUESTS === "1") {
        let s2 = { ...t2, messages: `[${t2.messages?.length ?? 0} messages]`, system: `[${typeof t2.system == "string" ? t2.system.length : "array"}]` };
        i3(W(q(), ".claude", "claude-max-request-dump.jsonl"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, headers: e2, body: s2 }) + `
`);
      }
    } catch {}
    try {
      n2 = await fetch("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", headers: e2, body: l2, signal: r2.signal });
    } catch (t3) {
      clearTimeout(a2);
      try {
        let { appendFileSync: e3 } = s("fs");
        e3(W(q(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_ERROR pid=${process.pid} ttfb=${Date.now() - o2}ms err=${t3.message}
`);
      } catch {}
      throw new z("Network error", t3);
    }
    clearTimeout(a2);
    try {
      let { appendFileSync: t3 } = s("fs"), e3 = {};
      n2.headers.forEach((t4, i4) => {
        e3[i4] = t4;
      });
      let i3 = { ts: new Date().toISOString(), pid: process.pid, status: n2.status, statusText: n2.statusText, ttfbMs: Date.now() - o2, headers: e3 };
      t3(W(q(), ".claude", "claude-max-api-responses.log"), JSON.stringify(i3) + `
`), t3(W(q(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_RESPONSE pid=${process.pid} status=${n2.status} ttfb=${Date.now() - o2}ms
`);
    } catch {}
    if (this.lastRateLimitInfo = this.parseRateLimitHeaders(n2.headers), !n2.ok) {
      let t3 = "";
      try {
        t3 = await n2.text();
      } catch {}
      let e3 = n2.headers.get("request-id");
      try {
        let { appendFileSync: i3 } = s("fs"), r3 = {};
        n2.headers.forEach((t4, e4) => {
          r3[e4] = t4;
        }), i3(W(q(), ".claude", "claude-max-api-responses.log"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, type: "ERROR", status: n2.status, requestId: e3, headers: r3, body: t3.slice(0, 5000), rateLimitInfo: this.lastRateLimitInfo }) + `
`);
      } catch {}
      throw n2.status === 429 ? new Y(`Rate limited: ${t3}`, this.lastRateLimitInfo, 429) : new V(`API error ${n2.status}: ${t3}`, n2.status, e3);
    }
    if (!n2.body)
      throw new z("No response body");
    yield* this.parseSSE(n2.body, i2);
  }
  async* parseSSE(t2, e2) {
    let i2 = new TextDecoder, r2 = t2.getReader(), a2 = "", n2 = new Map, o2 = { inputTokens: 0, outputTokens: 0 }, l2 = null;
    try {
      for (;; ) {
        if (e2?.aborted)
          return void r2.cancel();
        let { done: t3, value: h2 } = await r2.read();
        if (t3)
          break;
        a2 += i2.decode(h2, { stream: true });
        let c2 = a2.split(`
`);
        a2 = c2.pop() ?? "";
        for (let t4 of c2) {
          if (!t4.startsWith("data: "))
            continue;
          let e3, i3 = t4.slice(6);
          if (i3 === "[DONE]")
            continue;
          try {
            e3 = JSON.parse(i3);
          } catch {
            continue;
          }
          let r3 = e3.type;
          if (r3 === "message_start") {
            try {
              let { appendFileSync: t6 } = s("fs"), { join: i4 } = s("path"), { homedir: r4 } = s("os");
              t6(i4(r4(), ".claude", "claude-max-headers.log"), `[${new Date().toISOString()}] MESSAGE_START: ${JSON.stringify(e3).slice(0, 2000)}
`);
            } catch {}
            let t5 = e3.message?.usage;
            if (t5) {
              o2 = { inputTokens: t5.input_tokens ?? 0, outputTokens: t5.output_tokens ?? 0, cacheCreationInputTokens: t5.cache_creation_input_tokens, cacheReadInputTokens: t5.cache_read_input_tokens };
              try {
                j(W(q(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] RAW_USAGE: ${JSON.stringify(t5)}
`);
              } catch {}
            }
            continue;
          }
          if (r3 === "content_block_start") {
            let { index: t5, content_block: i4 } = e3;
            if (i4.type === "tool_use") {
              let e4 = gt(i4.name);
              n2.set(t5, { type: "tool_use", id: i4.id, name: e4, input: "" }), yield { type: "tool_use_start", id: i4.id, name: e4 };
            } else
              i4.type === "text" ? n2.set(t5, { type: "text", text: "" }) : i4.type === "thinking" && n2.set(t5, { type: "thinking", thinking: "", signature: i4.signature ?? undefined });
            continue;
          }
          if (r3 === "content_block_delta") {
            let t5 = e3.index, i4 = n2.get(t5), s2 = e3.delta;
            s2.type === "text_delta" && s2.text !== undefined ? (i4 && (i4.text = (i4.text ?? "") + s2.text), s2.text && (yield { type: "text_delta", text: s2.text })) : s2.type === "thinking_delta" && s2.thinking !== undefined ? (i4 && (i4.thinking = (i4.thinking ?? "") + s2.thinking), s2.thinking && (yield { type: "thinking_delta", text: s2.thinking })) : s2.type === "signature_delta" && s2.signature !== undefined ? i4 && (i4.signature = (i4.signature ?? "") + s2.signature) : s2.type === "input_json_delta" && s2.partial_json !== undefined && (i4 && (i4.input = (i4.input ?? "") + s2.partial_json), s2.partial_json && (yield { type: "tool_use_delta", partialInput: s2.partial_json }));
            continue;
          }
          if (r3 === "content_block_stop") {
            let t5 = e3.index, i4 = n2.get(t5);
            if (i4?.type === "tool_use" && i4.id && i4.name) {
              let t6 = {};
              try {
                t6 = JSON.parse(i4.input ?? "{}");
              } catch {}
              yield { type: "tool_use_end", id: i4.id, name: i4.name, input: t6 };
            }
            if (i4?.type === "thinking") {
              let t6 = e3.signature ?? e3.content_block?.signature;
              t6 && (i4.signature = t6), yield { type: "thinking_end", signature: i4.signature ?? undefined };
            }
            continue;
          }
          if (r3 === "message_delta") {
            let t5 = e3.delta;
            t5?.stop_reason && (l2 = t5.stop_reason);
            let i4 = e3.usage;
            i4?.output_tokens && (o2 = { ...o2, outputTokens: i4.output_tokens });
            continue;
          }
          r3 === "message_stop" && (yield { type: "message_stop", usage: o2, stopReason: l2 }, this.onStreamComplete(o2));
        }
      }
    } finally {
      r2.releaseLock();
    }
  }
  onStreamComplete(t2) {
    let e2 = Date.now();
    if (this.keepaliveLastActivityAt = e2, this.keepaliveLastRealActivityAt = e2, this.keepaliveCacheWrittenAt = e2, (this.healthProbeTimer || this.networkState !== "healthy") && (this.stopHealthProbe(), this.networkState !== "healthy")) {
      let t3 = this.networkState;
      this.networkState = "healthy";
      try {
        this.keepaliveConfig.onNetworkStateChange?.({ from: t3, to: "healthy", at: e2 });
      } catch {}
    }
    if (!this.keepaliveConfig.enabled)
      return;
    let i2 = this.t, s2 = this.i, r2 = this.o;
    if (i2 && s2 && r2) {
      let e3 = (t2.inputTokens ?? 0) + (t2.cacheReadInputTokens ?? 0) + (t2.cacheCreationInputTokens ?? 0), a2 = this.keepaliveRegistry.get(i2);
      e3 >= this.keepaliveConfig.minTokens && (!a2 || e3 >= a2.inputTokens) && this.keepaliveRegistry.set(i2, { body: s2, headers: r2, model: i2, inputTokens: e3 }), e3 > (this.lastKnownCacheTokensByModel.get(i2) ?? 0) && this.lastKnownCacheTokensByModel.set(i2, e3), this.writeSnapshotDebug(i2, s2, t2), this.i = null, this.o = null;
    }
    this.keepaliveRegistry.size > 0 && this.startKeepaliveTimer();
  }
  static SNAPSHOT_TTL_MS = 60 * (parseInt(process.env.CLAUDE_SDK_SNAPSHOT_TTL_MIN ?? "1440", 10) || 1440) * 1000;
  static DUMP_BODY = process.env.CLAUDE_SDK_DUMP_BODY === "1";
  snapshotCallCount = 0;
  writeSnapshotDebug(t2, e2, i2) {
    try {
      let s2 = W(q(), ".claude", "snapshots");
      P(s2, { recursive: true });
      try {
        let t3 = Date.now() - _ClaudeCodeSDK.SNAPSHOT_TTL_MS;
        for (let e3 of H(s2)) {
          let i3 = W(s2, e3);
          K(i3).mtimeMs < t3 && U(i3);
        }
      } catch {}
      this.snapshotCallCount++;
      let { messages: r2, system: a2, tools: n2 } = e2, o2 = typeof a2 == "string" ? a2 : JSON.stringify(a2), l2 = O("md5").update(o2).digest("hex").slice(0, 8), h2 = { ts: new Date().toISOString(), pid: process.pid, callNum: this.snapshotCallCount, model: t2, anchor: this.cacheAnchorMessageCount, messages: r2?.length ?? 0, tools: n2?.length ?? 0, sysHash: l2, sysLen: o2.length, usage: { input: i2.inputTokens ?? 0, cacheRead: i2.cacheReadInputTokens ?? 0, cacheWrite: i2.cacheCreationInputTokens ?? 0 }, firstMsg: r2?.[0] ? { role: r2[0].role, contentLen: JSON.stringify(r2[0].content).length, contentHash: O("md5").update(JSON.stringify(r2[0].content)).digest("hex").slice(0, 8) } : null, lastMsg: r2?.length ? { role: r2[r2.length - 1].role, contentLen: JSON.stringify(r2[r2.length - 1].content).length } : null, anchorMsg: this.cacheAnchorMessageCount > 0 && r2?.[this.cacheAnchorMessageCount - 1] ? { role: r2[this.cacheAnchorMessageCount - 1].role, contentLen: JSON.stringify(r2[this.cacheAnchorMessageCount - 1].content).length } : null, toolsHash: n2?.length ? O("md5").update(JSON.stringify(n2.map((t3) => t3.name ?? "").join(","))).digest("hex").slice(0, 8) : null }, c2 = `${process.pid}-${Date.now()}.json`;
      if (F(W(s2, c2), JSON.stringify(h2, null, 2) + `
`), _ClaudeCodeSDK.DUMP_BODY || this.snapshotCallCount <= 3) {
        let t3 = W(s2, "bodies");
        P(t3, { recursive: true });
        let i3 = `${process.pid}-call${this.snapshotCallCount}-${Date.now()}.json`;
        F(W(t3, i3), JSON.stringify(e2, null, 2) + `
`);
      }
    } catch {}
  }
  startKeepaliveTimer() {
    if (this.keepaliveTimer)
      return;
    let t2 = Math.min(30000, Math.max(5000, Math.floor(this.keepaliveConfig.intervalMs / 6)));
    this.keepaliveTimer = setInterval(() => this.keepaliveTick(), t2), this.keepaliveTimer && typeof this.keepaliveTimer == "object" && "unref" in this.keepaliveTimer && this.keepaliveTimer.unref();
  }
  static CACHE_TTL_MS = 300000;
  async keepaliveTick() {
    if (this.keepaliveRegistry.size === 0 || this.keepaliveInFlight)
      return;
    let t2 = nt();
    if (t2) {
      if (t2.enabled === false)
        return this.keepaliveRegistry.clear(), void this.stopKeepalive();
      typeof t2.intervalSec == "number" && t2.intervalSec > 0 && (this.keepaliveConfig.intervalMs = 1000 * t2.intervalSec), typeof t2.idleTimeoutSec == "number" && t2.idleTimeoutSec > 0 ? this.keepaliveConfig.idleTimeoutMs = 1000 * t2.idleTimeoutSec : (t2.idleTimeoutSec === null || t2.idleTimeoutSec === 0) && (this.keepaliveConfig.idleTimeoutMs = 1 / 0), typeof t2.minTokens == "number" && (this.keepaliveConfig.minTokens = t2.minTokens);
    }
    let e2 = Date.now() - this.keepaliveLastRealActivityAt;
    if (this.keepaliveConfig.idleTimeoutMs !== 1 / 0 && e2 > this.keepaliveConfig.idleTimeoutMs)
      return this.keepaliveRegistry.clear(), void this.stopKeepalive();
    let i2 = null;
    for (let t3 of this.keepaliveRegistry.values())
      (!i2 || t3.inputTokens > i2.inputTokens) && (i2 = t3);
    if (!i2)
      return;
    let s2 = Date.now() - this.keepaliveLastActivityAt;
    if (this.keepaliveJitterMs || (this.keepaliveJitterMs = Math.floor(30000 * Math.random())), s2 < 0.9 * this.keepaliveConfig.intervalMs + this.keepaliveJitterMs)
      this.keepaliveConfig.onTick?.({ idleMs: s2, nextFireMs: Math.max(0, this.keepaliveConfig.intervalMs - s2), model: i2.model, tokens: i2.inputTokens });
    else {
      this.keepaliveInFlight = true;
      try {
        await this.ensureAuth();
        let t3 = JSON.parse(JSON.stringify(i2.body)), e3 = t3.thinking?.budget_tokens ?? 0;
        t3.max_tokens = e3 > 0 ? e3 + 1 : 1;
        let r2 = { ...i2.headers, Authorization: `Bearer ${this.accessToken}` }, a2 = new AbortController;
        this.keepaliveAbortController = a2;
        let n2 = Date.now(), o2 = { inputTokens: 0, outputTokens: 0 };
        for await (let e4 of this.doStreamRequest(t3, r2, a2.signal))
          e4.type === "message_stop" && (o2 = e4.usage);
        let l2 = Date.now() - n2;
        this.keepaliveLastActivityAt = Date.now(), this.keepaliveCacheWrittenAt = Date.now(), this.keepaliveConfig.onHeartbeat?.({ usage: o2, durationMs: l2, idleMs: s2, model: i2.model, rateLimit: { status: this.lastRateLimitInfo.status, claim: this.lastRateLimitInfo.claim, resetAt: this.lastRateLimitInfo.resetAt } });
      } catch (t3) {
        let e3 = t3?.status;
        !e3 || e3 === 503 || e3 === 529 || e3 >= 500 ? this.keepaliveRetryChain(i2) : (this.keepaliveRegistry.clear(), this.onKeepaliveDisarmed("permanent_error"));
      } finally {
        this.keepaliveInFlight = false, this.keepaliveAbortController = null;
      }
    }
  }
  static KEEPALIVE_RETRY_DELAYS = [2, 3, 5, 7, 10, 12, 15, 17, 20, 20, 20, 20, 20];
  keepaliveRetryChain(t2, e2 = 0) {
    if (e2 >= _ClaudeCodeSDK.KEEPALIVE_RETRY_DELAYS.length)
      return this.keepaliveRegistry.clear(), void this.onKeepaliveDisarmed("retry_exhausted");
    let i2 = Date.now() - this.keepaliveCacheWrittenAt, s2 = _ClaudeCodeSDK.CACHE_TTL_MS - i2, r2 = 1000 * _ClaudeCodeSDK.KEEPALIVE_RETRY_DELAYS[e2];
    if (s2 < r2 + 5000)
      return this.keepaliveRegistry.clear(), void this.onKeepaliveDisarmed("cache_ttl_exhausted");
    this.keepaliveRetryTimer = setTimeout(async () => {
      if (this.keepaliveRetryTimer = null, !(this.keepaliveLastRealActivityAt > this.keepaliveCacheWrittenAt)) {
        if (Date.now() - this.keepaliveCacheWrittenAt > _ClaudeCodeSDK.CACHE_TTL_MS - 5000)
          return this.keepaliveRegistry.clear(), void this.onKeepaliveDisarmed("cache_ttl_expired_mid_retry");
        this.keepaliveInFlight = true;
        try {
          await this.ensureAuth();
          let e3 = JSON.parse(JSON.stringify(t2.body)), i3 = e3.thinking?.budget_tokens ?? 0;
          e3.max_tokens = i3 > 0 ? i3 + 1 : 1;
          let s3 = { ...t2.headers, Authorization: `Bearer ${this.accessToken}` }, r3 = new AbortController;
          this.keepaliveAbortController = r3;
          for await (let t3 of this.doStreamRequest(e3, s3, r3.signal))
            ;
          this.keepaliveLastActivityAt = Date.now(), this.keepaliveCacheWrittenAt = Date.now();
        } catch (i3) {
          let s3 = i3?.status;
          if (!s3 || s3 === 503 || s3 === 529 || s3 >= 500)
            return this.keepaliveInFlight = false, this.keepaliveAbortController = null, void this.keepaliveRetryChain(t2, e2 + 1);
          this.keepaliveRegistry.clear(), this.onKeepaliveDisarmed("permanent_error_mid_retry");
        } finally {
          this.keepaliveInFlight = false, this.keepaliveAbortController = null;
        }
      }
    }, r2);
  }
  checkRewriteGuard(t2) {
    let e2 = this.keepaliveLastRealActivityAt;
    if (e2 === 0)
      return;
    let i2 = Date.now() - e2, s2 = this.keepaliveConfig.rewriteWarnIdleMs, r2 = this.keepaliveConfig.rewriteBlockIdleMs;
    if (i2 < s2)
      return;
    let a2 = this.lastKnownCacheTokensByModel.get(t2) ?? 0, n2 = this.keepaliveConfig.rewriteBlockEnabled && i2 >= r2;
    if (a2 >= this.keepaliveConfig.rewriteWarnTokens || n2)
      try {
        this.keepaliveConfig.onRewriteWarning?.({ idleMs: i2, estimatedTokens: a2, blocked: n2, model: t2 });
      } catch {}
    if (n2)
      throw new X(i2, a2, t2);
  }
  onKeepaliveDisarmed(t2) {
    this.keepaliveAbortController?.abort(), this.keepaliveAbortController = null, this.keepaliveInFlight = false, this.keepaliveRetryTimer && (clearTimeout(this.keepaliveRetryTimer), this.keepaliveRetryTimer = null);
    try {
      this.keepaliveConfig.onDisarmed?.({ reason: t2, at: Date.now() });
    } catch {}
    if (new Set(["retry_exhausted", "cache_ttl_exhausted", "cache_ttl_expired_mid_retry"]).has(t2)) {
      let t3 = Date.now() - this.keepaliveCacheWrittenAt;
      _ClaudeCodeSDK.CACHE_TTL_MS - t3 > 30000 && this.startHealthProbe();
    }
  }
  static HEALTH_PROBE_INTERVAL_MS = 30000;
  static HEALTH_PROBE_TIMEOUT_MS = 3000;
  startHealthProbe() {
    if (this.healthProbeTimer)
      return;
    let t2 = this.networkState;
    if (this.networkState = "degraded", t2 !== "degraded")
      try {
        this.keepaliveConfig.onNetworkStateChange?.({ from: t2, to: "degraded", at: Date.now() });
      } catch {}
    let e2 = i(async () => {
      if (Date.now() - this.keepaliveCacheWrittenAt >= _ClaudeCodeSDK.CACHE_TTL_MS)
        return void this.stopHealthProbe();
      let t3 = false;
      try {
        let { connect: e3 } = await import("net");
        await new Promise((t4, i2) => {
          let s2 = e3({ host: "api.anthropic.com", port: 443 }), r2 = setTimeout(() => {
            s2.destroy(), i2(new Error("timeout"));
          }, _ClaudeCodeSDK.HEALTH_PROBE_TIMEOUT_MS);
          s2.once("connect", () => {
            clearTimeout(r2), s2.end(), t4();
          }), s2.once("error", (t5) => {
            clearTimeout(r2), i2(t5);
          });
        }), t3 = true;
      } catch {
        t3 = false;
      }
      if (t3) {
        this.stopHealthProbe();
        let t4 = this.networkState;
        this.networkState = "healthy";
        try {
          this.keepaliveConfig.onNetworkStateChange?.({ from: t4, to: "healthy", at: Date.now() });
        } catch {}
        let e3 = _ClaudeCodeSDK.CACHE_TTL_MS - (Date.now() - this.keepaliveCacheWrittenAt);
        this.keepaliveRegistry.size > 0 && e3 > 1e4 && this.keepaliveTick();
      }
    }, "probe");
    e2(), this.healthProbeTimer = setInterval(e2, _ClaudeCodeSDK.HEALTH_PROBE_INTERVAL_MS), this.healthProbeTimer && typeof this.healthProbeTimer == "object" && "unref" in this.healthProbeTimer && this.healthProbeTimer.unref();
  }
  stopHealthProbe() {
    this.healthProbeTimer && (clearInterval(this.healthProbeTimer), this.healthProbeTimer = null);
  }
  stopKeepalive() {
    this.keepaliveTimer && (clearInterval(this.keepaliveTimer), this.keepaliveTimer = null), this.keepaliveRetryTimer && (clearTimeout(this.keepaliveRetryTimer), this.keepaliveRetryTimer = null), this.tokenRotationTimer && (clearTimeout(this.tokenRotationTimer), this.tokenRotationTimer = null), this.keepaliveAbortController?.abort(), this.keepaliveRegistry.clear(), this.keepaliveInFlight = false, this.stopHealthProbe();
  }
  buildHeaders(t2) {
    let e2 = this.buildBetas(t2);
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}`, "anthropic-version": "2023-06-01", "anthropic-beta": e2.join(","), "anthropic-dangerous-direct-browser-access": "true", "x-app": "cli", "User-Agent": `claude-cli/${ft}`, "X-Claude-Code-Session-Id": this.sessionId };
  }
  buildRequestBody(t2) {
    let e2, i2 = this.computeFingerprint(t2.messages), s2 = `x-anthropic-billing-header: cc_version=${ft}.${i2}; cc_entrypoint=cli; cch=00000;`;
    e2 = (typeof t2.system == "string" ? t2.system : Array.isArray(t2.system) ? JSON.stringify(t2.system) : "").includes("x-anthropic-billing-header") ? t2.system : typeof t2.system == "string" ? s2 + `
` + t2.system : Array.isArray(t2.system) ? [{ type: "text", text: s2 }, ...t2.system] : s2;
    let r2 = { model: t2.model, messages: t2.messages, max_tokens: tt(t2.model, t2.maxTokens), stream: true, system: e2, metadata: { user_id: JSON.stringify({ device_id: this.deviceId, account_uuid: this.accountUuid, session_id: this.sessionId }) } };
    if (t2.tools && t2.tools.length > 0) {
      let { remapped: e3 } = yt(t2.tools);
      if (r2.tools = e3, t2.toolChoice) {
        let e4 = typeof t2.toolChoice == "string" ? { type: t2.toolChoice } : { ...t2.toolChoice };
        e4.type === "tool" && e4.name && pt[e4.name] && (e4.name = pt[e4.name]), r2.tool_choice = e4;
      }
    }
    t2.caching !== false && this.addCacheMarkers(r2);
    let a2 = t2.model.toLowerCase(), n2 = a2.includes("opus-4-6") || a2.includes("sonnet-4-6") || a2.includes("opus-4-7") || a2.includes("sonnet-4-7"), o2 = t2.thinking?.type === "disabled";
    return !o2 && n2 ? r2.thinking = { type: "adaptive" } : t2.thinking?.type === "enabled" && (r2.thinking = { type: "enabled", budget_tokens: t2.thinking.budgetTokens }), !(!o2 && (n2 || t2.thinking?.type === "enabled")) && t2.temperature !== undefined && (r2.temperature = t2.temperature), t2.topP !== undefined && (r2.top_p = t2.topP), t2.effort && n2 && (r2.output_config = { effort: t2.effort }), t2.stopSequences?.length && (r2.stop_sequences = t2.stopSequences), t2.fast && (r2.speed = "fast"), r2;
  }
  addCacheMarkers(t2) {
    let e2 = { cache_control: { type: "ephemeral", ttl: "1h" } }, i2 = t2.system;
    if (typeof i2 == "string")
      t2.system = [{ type: "text", text: i2, ...e2 }];
    else if (Array.isArray(i2)) {
      let t3 = i2;
      t3.length > 0 && (t3[t3.length - 1] = { ...t3[t3.length - 1], ...e2 });
    }
    let s2 = t2.tools;
    s2 && s2.length > 0 && (s2[s2.length - 1] = { ...s2[s2.length - 1], ...e2 });
    let r2 = t2.messages;
    if (r2.length === 0)
      return;
    let a2 = r2[r2.length - 1];
    if (typeof a2.content == "string")
      a2.content = [{ type: "text", text: a2.content, ...e2 }];
    else if (Array.isArray(a2.content) && a2.content.length > 0) {
      let t3 = a2.content[a2.content.length - 1];
      a2.content[a2.content.length - 1] = { ...t3, ...e2 };
    }
  }
  buildBetas(t2) {
    let e2 = [], i2 = t2.model.toLowerCase().includes("haiku");
    return i2 || e2.push("claude-code-20250219"), e2.push("oauth-2025-04-20"), /\[1m\]/i.test(t2.model) && e2.push("context-1m-2025-08-07"), !i2 && t2.thinking?.type !== "disabled" && e2.push("interleaved-thinking-2025-05-14"), t2.effort && e2.push("effort-2025-11-24"), t2.fast && e2.push("fast-mode-2026-02-01"), i2 || e2.push("context-management-2025-06-27"), e2.push("task-budgets-2026-03-13"), e2.push("redact-thinking-2026-02-12"), e2.push("prompt-caching-scope-2026-01-05"), e2.push("fine-grained-tool-streaming-2025-05-14"), t2.extraBetas && e2.push(...t2.extraBetas), e2;
  }
  async ensureAuth() {
    if (!this.accessToken || this.isTokenExpired())
      return this.pendingAuth || (this.pendingAuth = this.l().finally(() => {
        this.pendingAuth = null;
      })), this.pendingAuth;
  }
  async l() {
    this.accessToken && !this.isTokenExpired() || this.credentialStore.hasChanged && await this.credentialStore.hasChanged() && (await this.loadFromStore(), this.accessToken && !this.isTokenExpired()) || !this.accessToken && (await this.loadFromStore(), this.accessToken && !this.isTokenExpired()) || this.accessToken && this.isTokenExpired() && await this.refreshTokenWithTripleCheck();
  }
  async loadFromStore() {
    let t2 = await this.credentialStore.read();
    if (!t2?.accessToken)
      throw new G('No OAuth tokens found. Run "claude login" first or provide credentials.');
    this.accessToken = t2.accessToken, this.refreshToken = t2.refreshToken, this.expiresAt = t2.expiresAt, !this.tokenIssuedAt && this.expiresAt && (this.tokenIssuedAt = Date.now()), this.scheduleProactiveRotation();
  }
  isTokenExpired() {
    return !!this.expiresAt && Date.now() + ot >= this.expiresAt;
  }
  async forceRefreshToken() {
    if (this.dbg("FORCE REFRESH requested by caller"), this.initialLoad && await this.initialLoad, !this.refreshToken)
      try {
        await this.loadFromStore();
      } catch {}
    this.clearRefreshCooldown(), this.lastRefreshAttemptAt = 0;
    try {
      return await this.doTokenRefresh(true), this.proactiveRefreshFailures = 0, this.refreshConsecutive429s = 0, this.emitTokenStatus("rotated", "Token force-refreshed successfully"), this.scheduleProactiveRotation(), true;
    } catch (t2) {
      let e2 = t2?.message ?? String(t2);
      return this.dbg(`FORCE REFRESH FAILED: ${e2}`), this.emitTokenStatus("warning", `Force refresh failed: ${e2}`), false;
    }
  }
  async forceReLogin() {
    this.initialLoad && await this.initialLoad, this.dbg("FORCE RE-LOGIN requested \u2014 opening browser OAuth flow"), this.emitTokenStatus("critical", "Initiating browser re-login \u2014 refresh token may be dead");
    try {
      let { oauthLogin: t2 } = await Promise.resolve().then(() => (M(), r)), e2 = this.credentialStore instanceof Tt ? this.credentialStore.path : W(q(), ".claude", ".credentials.json"), i2 = await t2({ credentialsPath: e2 });
      return this.accessToken = i2.accessToken, this.refreshToken = i2.refreshToken, this.expiresAt = i2.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.refreshConsecutive429s = 0, this.clearRefreshCooldown(), this.emitTokenStatus("rotated", "Re-login successful \u2014 fresh tokens"), this.scheduleProactiveRotation(), this.dbg(`RE-LOGIN SUCCESS \u2014 new token expires at ${new Date(this.expiresAt).toISOString()}`), true;
    } catch (t2) {
      let e2 = t2?.message ?? String(t2);
      return this.dbg(`RE-LOGIN FAILED: ${e2}`), this.emitTokenStatus("expired", `Re-login failed: ${e2}`), false;
    }
  }
  getTokenHealth() {
    if (!this.expiresAt)
      return { expiresAt: null, expiresInMs: 0, lifetimePct: 0, failedRefreshes: this.proactiveRefreshFailures, status: "unknown" };
    let t2, e2 = Date.now(), i2 = this.expiresAt - e2, s2 = this.tokenIssuedAt > 0 ? this.expiresAt - this.tokenIssuedAt : 2 * i2, r2 = s2 > 0 ? Math.max(0, i2 / s2) : 0;
    return t2 = i2 <= 0 ? "expired" : r2 < 0.1 ? "critical" : r2 < lt ? "warning" : "healthy", { expiresAt: this.expiresAt, expiresInMs: i2, lifetimePct: r2, failedRefreshes: this.proactiveRefreshFailures, status: t2 };
  }
  async getTokenHealthAsync() {
    return this.initialLoad && await this.initialLoad, this.getTokenHealth();
  }
  scheduleProactiveRotation() {
    if (this.tokenRotationTimer && (clearTimeout(this.tokenRotationTimer), this.tokenRotationTimer = null), !this.expiresAt || !this.refreshToken)
      return;
    let t2 = Date.now(), e2 = this.expiresAt - t2;
    if (e2 <= 0)
      return void this.emitTokenStatus("expired", "Token has expired");
    let i2 = Math.max(0.5 * e2, ht), s2 = Math.floor(60000 * Math.random()), r2 = Math.min(i2 + s2, e2 - ot);
    if (r2 <= 0)
      return this.dbg(`proactive rotation: delay=${r2}ms <= 0, scheduling emergency refresh in 30s`), void (this.tokenRotationTimer || (this.tokenRotationTimer = setTimeout(() => {
        this.tokenRotationTimer = null, this.proactiveRefresh();
      }, 30000), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && ("unref" in this.tokenRotationTimer) && this.tokenRotationTimer.unref()));
    let a2 = this.tokenIssuedAt > 0 ? this.expiresAt - this.tokenIssuedAt : 2 * e2, n2 = a2 > 0 ? e2 / a2 : 1;
    n2 < 0.1 && this.proactiveRefreshFailures > 0 ? (this.dbg(`\u26A0\uFE0F CRITICAL: token ${Math.round(100 * n2)}% life left, ${this.proactiveRefreshFailures} failed refreshes`), this.emitTokenStatus("critical", `Token ${Math.round(100 * n2)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)) : n2 < lt && this.proactiveRefreshFailures > 0 && (this.dbg(`\u26A0 WARNING: token ${Math.round(100 * n2)}% life left, ${this.proactiveRefreshFailures} failed refreshes`), this.emitTokenStatus("warning", `Token ${Math.round(100 * n2)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)), this.dbg(`proactive rotation scheduled in ${Math.round(r2 / 1000)}s (expires in ${Math.round(e2 / 1000)}s, ${Math.round(100 * n2)}% life, failures=${this.proactiveRefreshFailures})`), this.tokenRotationTimer = setTimeout(() => {
      this.tokenRotationTimer = null, this.proactiveRefresh();
    }, r2), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && "unref" in this.tokenRotationTimer && this.tokenRotationTimer.unref();
  }
  async proactiveRefresh() {
    if (this.isRefreshOnCooldown()) {
      try {
        let t3 = await this.credentialStore.read();
        if (t3 && !(Date.now() + ot >= t3.expiresAt)) {
          let e3 = t3.expiresAt - Date.now();
          if (e3 >= ct)
            return this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.dbg(`proactive refresh: picked up fresh token during cooldown (${Math.round(e3 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(e3 / 60000)}min remaining)`), void this.scheduleProactiveRotation();
          this.dbg(`proactive refresh: disk token has only ${Math.round(e3 / 60000)}min left (need ${Math.round(20)}min) \u2014 waiting for cooldown`);
        }
      } catch {}
      if (this.dbg("proactive refresh skipped: global cooldown active, no fresh token found"), !this.tokenRotationTimer) {
        let t3 = Math.max(ht, 60000);
        this.tokenRotationTimer = setTimeout(() => {
          this.tokenRotationTimer = null, this.proactiveRefresh();
        }, t3), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && "unref" in this.tokenRotationTimer && this.tokenRotationTimer.unref();
      }
      return;
    }
    let t2 = Date.now();
    if (t2 - this.lastRefreshAttemptAt < ht)
      return void this.dbg("proactive refresh skipped: too recent");
    this.lastRefreshAttemptAt = t2, this.dbg("proactive rotation: refreshing token silently...");
    let e2 = await kt();
    try {
      if (e2) {
        let t4 = await this.credentialStore.read();
        if (t4 && !(Date.now() + ot >= t4.expiresAt)) {
          let e3 = t4.expiresAt - Date.now();
          if (e3 >= ct)
            return this.accessToken = t4.accessToken, this.refreshToken = t4.refreshToken, this.expiresAt = t4.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.dbg(`proactive rotation: picked up fresh token from lock winner (${Math.round(e3 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(e3 / 60000)}min remaining)`), void this.scheduleProactiveRotation();
        }
      }
      let t3 = this.expiresAt ?? 0;
      await this.doTokenRefresh(true), this.proactiveRefreshFailures = 0, this.refreshConsecutive429s = 0, this.clearRefreshCooldown(), this.tokenIssuedAt = Date.now();
      let i2 = (this.expiresAt ?? 0) - Date.now(), s2 = t3 > 0 ? t3 - (this.tokenIssuedAt - 1000) : 2 * i2;
      i2 > 0 && i2 < 0.5 * s2 && this.dbg(`\u26A0\uFE0F SHRINKING TOKEN: new ${Math.round(i2 / 60000)}min vs prev ${Math.round(s2 / 60000)}min \u2014 backing off rotation`), this.dbg(`proactive rotation SUCCESS \u2014 new token expires at ${new Date(this.expiresAt).toISOString()} (${Math.round(i2 / 60000)}min lifetime)`), this.emitTokenStatus("rotated", `Token rotated silently \u2014 expires ${new Date(this.expiresAt).toISOString()}`), this.scheduleProactiveRotation();
    } catch (t3) {
      this.proactiveRefreshFailures++;
      let e3 = t3?.message ?? String(t3);
      if (this.dbg(`proactive rotation FAILED (#${this.proactiveRefreshFailures}): ${e3}`), e3.includes("429") || e3.includes("rate limit")) {
        this.refreshConsecutive429s++;
        let t4 = Math.min(ht * Math.pow(2, this.refreshConsecutive429s), dt);
        this.setRefreshCooldown(t4), this.dbg(`proactive rotation: 429 cooldown ${Math.round(t4 / 1000)}s (attempt #${this.refreshConsecutive429s})`);
      }
      let i2 = this.expiresAt ? this.expiresAt - Date.now() : 0, s2 = this.tokenIssuedAt > 0 && this.expiresAt ? this.expiresAt - this.tokenIssuedAt : 2 * i2, r2 = s2 > 0 ? i2 / s2 : 0;
      i2 <= ot ? this.emitTokenStatus("expired", `Token expired after ${this.proactiveRefreshFailures} failed refresh attempts: ${e3}`) : r2 < 0.1 ? this.emitTokenStatus("critical", `CRITICAL: ${Math.round(i2 / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${e3}. Consider forceReLogin()`) : r2 < lt && this.emitTokenStatus("warning", `WARNING: ${Math.round(i2 / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${e3}`), this.expiresAt && this.expiresAt > Date.now() + ot ? this.scheduleProactiveRotation() : (this.dbg("proactive rotation: token nearly expired \u2014 emitting expired status"), this.emitTokenStatus("expired", `Token expired \u2014 refresh failed ${this.proactiveRefreshFailures} times. Call forceReLogin() to recover.`));
    } finally {
      e2 && e2();
    }
  }
  emitTokenStatus(t2, e2) {
    let i2 = this.expiresAt ? this.expiresAt - Date.now() : 0, s2 = { level: t2, message: e2, expiresInMs: i2, failedAttempts: this.proactiveRefreshFailures, needsReLogin: t2 === "expired" || t2 === "critical" && this.proactiveRefreshFailures >= 3 }, r2 = t2 === "rotated" ? "\u2705" : t2 === "warning" ? "\u26A0\uFE0F" : t2 === "critical" ? "\uD83D\uDD34" : "\uD83D\uDC80";
    this.dbg(`${r2} [${t2.toUpperCase()}] ${e2} (expires in ${Math.round(i2 / 60000)}min, failures=${this.proactiveRefreshFailures})`), this.onTokenStatus?.(s2);
  }
  isRefreshOnCooldown() {
    try {
      let t2 = L(ut, "utf8"), e2 = parseInt(t2.trim());
      if (Date.now() < e2)
        return true;
      try {
        U(ut);
      } catch {}
    } catch {}
    return false;
  }
  setRefreshCooldown(t2) {
    try {
      let e2 = W(q(), ".claude");
      try {
        P(e2, { recursive: true });
      } catch {}
      F(ut, `${Date.now() + t2}
`);
    } catch {}
  }
  clearRefreshCooldown() {
    try {
      U(ut);
    } catch {}
    this.refreshConsecutive429s = 0;
  }
  dbg(t2) {
    try {
      j(W(q(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_ROTATION pid=${process.pid} ${t2}
`);
    } catch {}
  }
  async refreshTokenWithTripleCheck() {
    let t2 = await this.credentialStore.read();
    if (t2 && !(Date.now() + ot >= t2.expiresAt))
      return this.accessToken = t2.accessToken, this.refreshToken = t2.refreshToken, void (this.expiresAt = t2.expiresAt);
    let e2 = await kt();
    try {
      if (e2) {
        let t3 = await this.credentialStore.read();
        if (t3 && !(Date.now() + ot >= t3.expiresAt))
          return this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, void (this.expiresAt = t3.expiresAt);
      }
      await this.doTokenRefresh();
    } finally {
      e2 && e2();
    }
  }
  async handleAuth401() {
    let t2 = this.accessToken;
    this.pending401 && this.lastFailedToken === t2 || (this.lastFailedToken = t2, this.pending401 = (async () => {
      let e2 = await this.credentialStore.read();
      return e2 && e2.accessToken !== t2 ? (this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken, this.expiresAt = e2.expiresAt, true) : (await this.doTokenRefresh(), true);
    })().finally(() => {
      this.pending401 = null, this.lastFailedToken = null;
    })), await this.pending401;
  }
  async doTokenRefresh(t2 = false) {
    if (!this.refreshToken)
      throw new G("Token expired and no refresh token available.");
    if (this.isRefreshOnCooldown() && !t2) {
      let t3 = await this.credentialStore.read();
      if (t3 && !(Date.now() + ot >= t3.expiresAt))
        return this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, void this.dbg("refresh skipped (cooldown) \u2014 another process already refreshed");
      if (this.expiresAt && this.expiresAt > Date.now() + 600000)
        throw new G("Token refresh on cooldown due to rate limiting. Will retry later.");
      this.dbg("refresh: ignoring cooldown \u2014 token critically close to expiry");
    }
    let e2 = [500, 1500, 3000, 5000, 8000];
    for (let i3 = 0;i3 < 5; i3++) {
      let s2 = await this.credentialStore.read();
      if (s2 && !(Date.now() + ot >= s2.expiresAt)) {
        if (!t2)
          return this.accessToken = s2.accessToken, this.refreshToken = s2.refreshToken, this.expiresAt = s2.expiresAt, void this.dbg(`refresh: another process already refreshed (attempt ${i3})`);
        let e3 = s2.expiresAt - Date.now();
        if (s2.accessToken !== this.accessToken && e3 >= ct)
          return this.accessToken = s2.accessToken, this.refreshToken = s2.refreshToken, this.expiresAt = s2.expiresAt, void this.dbg(`refresh: another process got fresh token (${Math.round(e3 / 60000)}min remaining) (attempt ${i3})`);
        s2.accessToken !== this.accessToken ? (this.accessToken = s2.accessToken, this.refreshToken = s2.refreshToken, this.expiresAt = s2.expiresAt, this.dbg(`refresh: force=true, disk token different but only ${Math.round(e3 / 60000)}min left \u2014 proceeding to actual refresh (attempt ${i3})`)) : this.dbg(`refresh: force=true, token still same, proceeding to actual refresh (attempt ${i3})`);
      }
      let r2 = await fetch("https://platform.claude.com/v1/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: this.refreshToken, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }), signal: AbortSignal.timeout(15000) });
      if (r2.ok) {
        let t3 = await r2.json();
        this.accessToken = t3.access_token, this.refreshToken = t3.refresh_token ?? this.refreshToken, this.expiresAt = Date.now() + 1000 * t3.expires_in, this.tokenIssuedAt = Date.now();
        let e3 = await this.credentialStore.read(), i4 = e3?.scopes?.length ? e3.scopes : ["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"];
        return await this.credentialStore.write({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt, scopes: i4 }), this.dbg(`token refreshed OK \u2014 expires in ${Math.round(t3.expires_in / 60)}min at ${new Date(this.expiresAt).toISOString()}`), void this.scheduleProactiveRotation();
      }
      if ((r2.status === 429 || r2.status >= 500) && i3 < 4) {
        let t3 = e2[i3] ?? 8000, s3 = Math.random() * t3 * 0.5;
        if (this.dbg(`TOKEN_REFRESH_RETRY status=${r2.status} attempt=${i3 + 1}/5 delay=${Math.round(t3 + s3)}ms`), r2.status === 429) {
          let e3 = Math.min(3 * (t3 + s3), dt);
          this.setRefreshCooldown(e3);
        }
        await new Promise((e3) => setTimeout(e3, t3 + s3));
        continue;
      }
      throw new G(`Token refresh failed: ${r2.status} ${r2.statusText}`);
    }
    let i2 = await this.credentialStore.read();
    if (!i2 || Date.now() + ot >= i2.expiresAt)
      throw new G("Token refresh failed after all retries and race recovery");
    this.accessToken = i2.accessToken, this.refreshToken = i2.refreshToken, this.expiresAt = i2.expiresAt;
    try {
      j(W(q(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_REFRESH_RACE_RECOVERY pid=${process.pid}
`);
    } catch {}
  }
  assembleResponse(t2, e2) {
    let i2, s2 = [], r2 = [], a2 = [], n2 = { inputTokens: 0, outputTokens: 0 }, o2 = null, l2 = "", h2 = "";
    for (let e3 of t2)
      switch (e3.type) {
        case "text_delta":
          l2 += e3.text;
          break;
        case "thinking_delta":
          h2 += e3.text;
          break;
        case "thinking_end":
          i2 = e3.signature, h2 && (r2.push({ type: "thinking", thinking: h2, signature: i2 }), h2 = "");
          break;
        case "tool_use_end":
          a2.push({ type: "tool_use", id: e3.id, name: e3.name, input: e3.input });
          break;
        case "message_stop":
          n2 = e3.usage, o2 = e3.stopReason;
          break;
        case "error":
          throw e3.error;
      }
    return l2 && s2.push({ type: "text", text: l2 }), h2 && r2.push({ type: "thinking", thinking: h2, signature: i2 }), s2.push(...a2), { content: s2, thinking: r2.length > 0 ? r2 : undefined, toolCalls: a2.length > 0 ? a2 : undefined, usage: n2, stopReason: o2, rateLimitInfo: this.lastRateLimitInfo, model: e2 };
  }
  parseRateLimitHeaders(t2) {
    let e2 = {};
    if (t2.forEach((t3, i3) => {
      (i3.includes("ratelimit") || i3.includes("anthropic") || i3.includes("retry") || i3.includes("x-")) && (e2[i3] = t3);
    }), Object.keys(e2).length > 0 && this.keepaliveConfig?.onTick)
      try {
        let { appendFileSync: t3 } = s("fs"), { join: i3 } = s("path"), { homedir: r3 } = s("os");
        t3(i3(r3(), ".claude", "claude-max-headers.log"), `[${new Date().toISOString()}] ${JSON.stringify(e2)}
`);
      } catch {}
    let i2 = t2.get("retry-after"), r2 = t2.get("anthropic-ratelimit-unified-reset"), a2 = r2 ? Number(r2) : null, n2 = t2.get("anthropic-ratelimit-unified-5h-utilization"), o2 = t2.get("anthropic-ratelimit-unified-7d-utilization");
    return { status: t2.get("anthropic-ratelimit-unified-status"), resetAt: Number.isFinite(a2) ? a2 : null, claim: t2.get("anthropic-ratelimit-unified-representative-claim"), retryAfter: i2 ? parseFloat(i2) : null, utilization5h: n2 ? parseFloat(n2) : null, utilization7d: o2 ? parseFloat(o2) : null };
  }
  getRetryDelay(t2, e2) {
    if (e2) {
      let t3 = parseInt(e2, 10);
      if (!isNaN(t3))
        return 1000 * t3;
    }
    let i2 = Math.min(300 * Math.pow(2, t2 - 1), 5000);
    return i2 + 0.25 * Math.random() * i2;
  }
  sleep(t2, e2) {
    return new Promise((i2, s2) => {
      if (e2?.aborted)
        return void s2(new z("Aborted"));
      let r2 = setTimeout(i2, t2);
      e2?.addEventListener("abort", () => {
        clearTimeout(r2), s2(new z("Aborted"));
      }, { once: true });
    });
  }
  computeFingerprint(t2) {
    let e2 = "";
    for (let i3 of t2) {
      let t3 = i3;
      if (t3.role === "user") {
        if (typeof t3.content == "string") {
          e2 = t3.content;
          break;
        }
        if (Array.isArray(t3.content)) {
          for (let i4 of t3.content)
            if (i4.type === "text") {
              e2 = i4.text;
              break;
            }
          if (e2)
            break;
        }
      }
    }
    let i2 = `59cf53e54c78${[4, 7, 20].map((t3) => e2[t3] || "0").join("")}${ft}`;
    return O("sha256").update(i2).digest("hex").slice(0, 3);
  }
  readAccountUuid() {
    try {
      let t2 = W(q(), ".claude", "claude_code_config.json");
      return JSON.parse(L(t2, "utf8")).oauthAccount?.accountUuid ?? "";
    } catch {
      return "";
    }
  }
};
var Tt = class {
  constructor(t2) {
    this.path = t2;
  }
  static {
    i(this, "FileCredentialStore");
  }
  lastMtimeMs = 0;
  async read() {
    try {
      let t2 = L(this.path, "utf8");
      return this.lastMtimeMs = this.getMtime(), JSON.parse(t2).claudeAiOauth ?? null;
    } catch {
      return null;
    }
  }
  async write(t2) {
    let e2 = {};
    try {
      e2 = JSON.parse(L(this.path, "utf8"));
    } catch {}
    e2.claudeAiOauth = t2;
    let i2 = W(this.path, "..");
    try {
      P(i2, { recursive: true });
    } catch {}
    F(this.path, JSON.stringify(e2, null, 2), "utf8"), B(this.path, 384), this.lastMtimeMs = this.getMtime();
  }
  async hasChanged() {
    let t2 = this.getMtime();
    return t2 !== this.lastMtimeMs && (this.lastMtimeMs = t2, true);
  }
  getMtime() {
    try {
      return K(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }
};
var St = class {
  static {
    i(this, "MemoryCredentialStore");
  }
  credentials;
  constructor(t2) {
    this.credentials = { ...t2 };
  }
  async read() {
    return this.credentials.accessToken ? { ...this.credentials } : null;
  }
  async write(t2) {
    this.credentials = { ...t2 };
  }
};
var vt = class _Conversation {
  static {
    i(this, "Conversation");
  }
  sdk;
  options;
  h = [];
  u = { inputTokens: 0, outputTokens: 0 };
  constructor(t2, e2) {
    this.sdk = t2, this.options = e2;
  }
  get messages() {
    return this.h;
  }
  get totalUsage() {
    return { ...this.u };
  }
  get length() {
    return this.h.length;
  }
  async send(t2, e2) {
    this.appendUserMessage(t2);
    let i2 = this.buildGenerateOptions(e2), s2 = await this.sdk.generate(i2);
    return this.appendAssistantFromResponse(s2), this.accumulateUsage(s2.usage), s2;
  }
  async* stream(t2, e2) {
    this.appendUserMessage(t2);
    let i2 = this.buildGenerateOptions(e2), s2 = [], r2 = [], a2 = [], n2 = { inputTokens: 0, outputTokens: 0 };
    for await (let t3 of this.sdk.stream(i2))
      switch (yield t3, t3.type) {
        case "text_delta":
          s2.push(t3.text);
          break;
        case "thinking_delta":
          r2.push(t3.text);
          break;
        case "tool_use_end":
          a2.push({ type: "tool_use", id: t3.id, name: t3.name, input: t3.input });
          break;
        case "message_stop":
          n2 = t3.usage;
      }
    let o2 = [];
    s2.length > 0 && o2.push({ type: "text", text: s2.join("") });
    for (let t3 of a2)
      o2.push({ type: "tool_use", id: t3.id, name: t3.name, input: t3.input });
    o2.length > 0 && this.h.push({ role: "assistant", content: o2 }), this.accumulateUsage(n2);
  }
  addToolResult(t2, e2, i2) {
    let s2 = { type: "tool_result", tool_use_id: t2, content: e2, ...i2 && { is_error: true } };
    this.h.push({ role: "user", content: [s2] });
  }
  addToolResults(t2) {
    let e2 = t2.map((t3) => ({ type: "tool_result", tool_use_id: t3.toolUseId, content: t3.content, ...t3.isError && { is_error: true } }));
    this.h.push({ role: "user", content: e2 });
  }
  async continue(t2) {
    let e2 = this.buildGenerateOptions(t2), i2 = await this.sdk.generate(e2);
    return this.appendAssistantFromResponse(i2), this.accumulateUsage(i2.usage), i2;
  }
  async* continueStream(t2) {
    let e2 = this.buildGenerateOptions(t2), i2 = [], s2 = [], r2 = { inputTokens: 0, outputTokens: 0 };
    for await (let t3 of this.sdk.stream(e2))
      switch (yield t3, t3.type) {
        case "text_delta":
          i2.push(t3.text);
          break;
        case "tool_use_end":
          s2.push({ type: "tool_use", id: t3.id, name: t3.name, input: t3.input });
          break;
        case "message_stop":
          r2 = t3.usage;
      }
    let a2 = [];
    i2.length > 0 && a2.push({ type: "text", text: i2.join("") });
    for (let t3 of s2)
      a2.push({ type: "tool_use", id: t3.id, name: t3.name, input: t3.input });
    a2.length > 0 && this.h.push({ role: "assistant", content: a2 }), this.accumulateUsage(r2);
  }
  rewind(t2) {
    if (t2 < 0 || t2 >= this.h.length)
      throw new Error(`Invalid rewind index: ${t2}`);
    return this.h.splice(t2);
  }
  undoLastTurn() {
    for (let t2 = this.h.length - 1;t2 >= 0; t2--) {
      let e2 = this.h[t2];
      if (e2.role === "user") {
        let i2 = e2.content;
        if (!(Array.isArray(i2) && i2.length > 0 && i2[0].type === "tool_result"))
          return this.rewind(t2);
      }
    }
    return [];
  }
  branch() {
    let t2 = new _Conversation(this.sdk, { ...this.options });
    return t2.h = [...this.h], t2.u = { ...this.u }, t2;
  }
  getHistory() {
    return this.h.map((t2, e2) => {
      let i2 = "";
      if (typeof t2.content == "string")
        i2 = t2.content.slice(0, 100);
      else if (Array.isArray(t2.content)) {
        let e3 = t2.content[0];
        e3?.type === "text" ? i2 = e3.text?.slice(0, 100) ?? "" : e3?.type === "tool_result" ? i2 = `[tool_result: ${e3.tool_use_id}]` : e3?.type === "tool_use" && (i2 = `[tool_use: ${e3.name}]`);
      }
      return { index: e2, role: t2.role, preview: i2 };
    });
  }
  appendUserMessage(t2) {
    this.h.push({ role: "user", content: t2 });
  }
  appendAssistantFromResponse(t2) {
    let e2 = [];
    for (let i2 of t2.content)
      i2.type === "text" ? e2.push({ type: "text", text: i2.text }) : i2.type === "tool_use" && e2.push({ type: "tool_use", id: i2.id, name: i2.name, input: i2.input });
    e2.length > 0 && this.h.push({ role: "assistant", content: e2 });
  }
  buildGenerateOptions(t2) {
    return { model: this.options.model, messages: [...this.h], system: this.options.system, tools: t2?.tools ?? this.options.tools, toolChoice: t2?.toolChoice ?? this.options.toolChoice, maxTokens: this.options.maxTokens, thinking: this.options.thinking, effort: this.options.effort, fast: this.options.fast, signal: t2?.signal ?? this.options.signal, extraBetas: this.options.extraBetas, caching: this.options.caching };
  }
  accumulateUsage(t2) {
    this.u.inputTokens += t2.inputTokens, this.u.outputTokens += t2.outputTokens, this.u.cacheCreationInputTokens = (this.u.cacheCreationInputTokens ?? 0) + (t2.cacheCreationInputTokens ?? 0), this.u.cacheReadInputTokens = (this.u.cacheReadInputTokens ?? 0) + (t2.cacheReadInputTokens ?? 0);
  }
};
function Rt(t2, e2) {
  xt(Ct(t2), { recursive: true });
  let i2 = null, s2 = [];
  for (let t3 of e2) {
    let e3 = Dt(), r2 = { type: t3.role === "user" ? "user" : "assistant", uuid: e3, parentUuid: i2, timestamp: Date.now(), content: t3.content };
    s2.push(JSON.stringify(r2)), i2 = e3;
  }
  bt(t2, s2.join(`
`) + `
`, "utf8");
}
function Et(t2) {
  let e2 = $t(t2, "utf8"), i2 = [];
  for (let t3 of e2.split(`
`)) {
    if (!t3.trim())
      continue;
    let e3;
    try {
      e3 = JSON.parse(t3);
    } catch {
      continue;
    }
    (e3.type === "user" || e3.type === "assistant") && i2.push({ role: e3.type === "user" ? "user" : "assistant", content: e3.content });
  }
  return i2;
}
i(Rt, "saveSession"), i(Et, "loadSession"), M(), M();
var Lt = '{"type":"KeepAlive"}';
var Ft = 16000;
var Bt = Math.floor(3200);
async function Pt(t2, e2, s2) {
  let r2 = s2?.baseUrl ?? "https://api.anthropic.com", a2 = new URLSearchParams({ encoding: "linear16", sample_rate: String(Ft), channels: String(1), endpointing_ms: "300", utterance_end_ms: "1000", language: s2?.language ?? "en" });
  if (s2?.keyterms?.length)
    for (let t3 of s2.keyterms)
      a2.append("keyterms", t3);
  let n2 = `/api/ws/speech_to_text/voice_stream?${a2.toString()}`, o2 = It(16).toString("base64"), l2 = null, h2 = false, c2 = false, u2 = false, d2 = null, f2 = null, p2 = "", m2 = await new Promise((e3, i2) => {
    let s3 = setTimeout(() => {
      i2(new Error("voice_stream WebSocket connection timeout (10s)"));
    }, 1e4), a3 = new URL(r2), l3 = Ot({ hostname: a3.hostname, port: a3.port || 443, path: n2, method: "GET", headers: { Authorization: `Bearer ${t2}`, "User-Agent": "claude-cli/1.0.0 (subscriber, cli)", "x-app": "cli", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": o2 } });
    l3.on("upgrade", (t3, r3, a4) => {
      clearTimeout(s3);
      let n3 = Nt("sha1").update(o2 + "258EAFA5-E914-47DA-95CA-5AB5DC11E5B3").digest("base64");
      if (t3.headers["sec-websocket-accept"] !== n3)
        return r3.destroy(), void i2(new Error("WebSocket handshake failed: invalid accept header"));
      e3(r3);
    }), l3.on("response", (t3) => {
      if (t3.statusCode === 101 && t3.socket)
        return clearTimeout(s3), void e3(t3.socket);
      clearTimeout(s3), i2(new Error(`WebSocket upgrade rejected: HTTP ${t3.statusCode}`));
    }), l3.on("error", (t3) => {
      clearTimeout(s3), i2(new Error(`voice_stream connection failed: ${t3.message}`));
    }), l3.end();
  });
  function y2(t3) {
    k2(Buffer.from(t3, "utf8"), 1);
  }
  function g2(t3) {
    k2(t3, 2);
  }
  function w2() {
    k2(Buffer.alloc(0), 8);
  }
  function k2(t3, e3) {
    if (m2.destroyed)
      return;
    let i2, s3 = It(4), r3 = Buffer.alloc(t3.length);
    for (let e4 = 0;e4 < t3.length; e4++)
      r3[e4] = t3[e4] ^ s3[e4 % 4];
    t3.length < 126 ? (i2 = Buffer.alloc(6), i2[0] = 128 | e3, i2[1] = 128 | t3.length, s3.copy(i2, 2)) : t3.length < 65536 ? (i2 = Buffer.alloc(8), i2[0] = 128 | e3, i2[1] = 254, i2.writeUInt16BE(t3.length, 2), s3.copy(i2, 4)) : (i2 = Buffer.alloc(14), i2[0] = 128 | e3, i2[1] = 255, i2.writeBigUInt64BE(BigInt(t3.length), 2), s3.copy(i2, 10)), m2.write(Buffer.concat([i2, r3]));
  }
  h2 = true, i(y2, "wsSendText"), i(g2, "wsSendBinary"), i(w2, "wsSendClose"), i(k2, "wsSendFrame");
  let _2 = Buffer.alloc(0);
  function T2() {
    for (;_2.length >= 2; ) {
      let t3 = _2[0], e3 = _2[1], i2 = 15 & t3, s3 = !!(128 & e3), r3 = 127 & e3, a3 = 2;
      if (r3 === 126) {
        if (_2.length < 4)
          return;
        r3 = _2.readUInt16BE(2), a3 = 4;
      } else if (r3 === 127) {
        if (_2.length < 10)
          return;
        r3 = Number(_2.readBigUInt64BE(2)), a3 = 10;
      }
      s3 && (a3 += 4);
      let n3 = a3 + r3;
      if (_2.length < n3)
        return;
      let o3 = _2.subarray(a3, n3);
      if (s3) {
        let t4 = _2.subarray(a3 - 4, a3);
        o3 = Buffer.from(o3);
        for (let e4 = 0;e4 < o3.length; e4++)
          o3[e4] = o3[e4] ^ t4[e4 % 4];
      }
      if (_2 = _2.subarray(n3), i2 === 1)
        S2(o3.toString("utf8"));
      else {
        if (i2 === 8)
          return void v2(o3.length >= 2 ? o3.readUInt16BE(0) : 1005, o3.length > 2 ? o3.subarray(2).toString("utf8") : "");
        i2 === 9 && k2(o3, 10);
      }
    }
  }
  function S2(t3) {
    let i2;
    try {
      i2 = JSON.parse(t3);
    } catch {
      return;
    }
    switch (i2.type) {
      case "TranscriptText": {
        let t4 = i2.data;
        c2 && f2?.(), t4 && (p2 = t4, e2.onTranscript(t4, false));
        break;
      }
      case "TranscriptEndpoint": {
        let t4 = p2;
        p2 = "", t4 && e2.onTranscript(t4, true), c2 && d2?.("post_closestream_endpoint");
        break;
      }
      case "TranscriptError": {
        let t4 = i2.description ?? i2.error_code ?? "unknown transcription error";
        u2 || e2.onError(t4);
        break;
      }
      case "error": {
        let t4 = i2.message ?? JSON.stringify(i2);
        u2 || e2.onError(t4);
        break;
      }
    }
  }
  function v2(t3, i2) {
    if (h2 = false, l2 && (clearInterval(l2), l2 = null), p2) {
      let t4 = p2;
      p2 = "", e2.onTranscript(t4, true);
    }
    d2?.("ws_close"), !u2 && t3 !== 1000 && t3 !== 1005 && e2.onError(`Connection closed: code ${t3}${i2 ? ` \u2014 ${i2}` : ""}`), e2.onClose(), m2.destroy();
  }
  return i(T2, "processFrames"), i(S2, "handleMessage"), i(v2, "handleClose"), m2.on("data", (t3) => {
    _2 = Buffer.concat([_2, t3]), T2();
  }), m2.on("close", () => {
    h2 && v2(1006, "connection lost");
  }), m2.on("error", (t3) => {
    u2 || e2.onError(`Socket error: ${t3.message}`);
  }), y2(Lt), l2 = setInterval(() => {
    h2 && y2(Lt);
  }, 8000), { send(t3) {
    !h2 || c2 || g2(Buffer.from(t3));
  }, finalize: () => u2 || c2 ? Promise.resolve("already_closed") : (u2 = true, new Promise((t3) => {
    let s3 = setTimeout(() => d2?.("safety_timeout"), 5000), r3 = setTimeout(() => d2?.("no_data_timeout"), 1500);
    f2 = i(() => {
      clearTimeout(r3), f2 = null;
    }, "cancelNoDataTimer"), d2 = i((i2) => {
      if (clearTimeout(s3), clearTimeout(r3), d2 = null, f2 = null, p2) {
        let t4 = p2;
        p2 = "", e2.onTranscript(t4, true);
      }
      t3(i2);
    }, "resolveFinalize"), m2.destroyed ? d2("ws_already_closed") : setTimeout(() => {
      c2 = true, h2 && y2('{"type":"CloseStream"}');
    }, 0);
  })), close() {
    c2 = true, l2 && (clearInterval(l2), l2 = null), h2 = false, m2.destroyed || (w2(), m2.destroy());
  }, isConnected: () => h2 && !m2.destroyed };
}
async function Jt(t2, e2, s2) {
  let r2 = [], a2 = null, n2 = await Pt(t2, { onTranscript: i((t3, e3) => {
    e3 ? r2.push(t3.trim()) : s2?.onInterim?.(t3);
  }, "onTranscript"), onError: i((t3) => {
    a2 = t3;
  }, "onError"), onClose: i(() => {}, "onClose") }, s2);
  try {
    let t3 = await qt(e2), i2 = t3;
    t3.length > 44 && t3[0] === 82 && t3[1] === 73 && t3[2] === 70 && t3[3] === 70 && (i2 = t3.subarray(44));
    let r3 = s2?.realtime !== false;
    for (let t4 = 0;t4 < i2.length && n2.isConnected(); t4 += Bt) {
      let e3 = i2.subarray(t4, Math.min(t4 + Bt, i2.length));
      n2.send(e3), r3 && t4 + Bt < i2.length && await Wt(80);
    }
    await n2.finalize();
  } finally {
    n2.close();
  }
  if (a2)
    throw new Error(`Transcription error: ${a2}`);
  return r2.join(" ");
}
async function Kt(t2, e2, s2) {
  let r2 = [], a2 = null, n2 = await Pt(t2, { onTranscript: i((t3, e3) => {
    e3 ? r2.push(t3.trim()) : s2?.onInterim?.(t3);
  }, "onTranscript"), onError: i((t3) => {
    a2 = t3;
  }, "onError"), onClose: i(() => {}, "onClose") }, s2);
  try {
    let t3 = zt();
    if (!t3)
      throw new Error("No audio converter found. Install ffmpeg or sox.");
    await Gt(n2, e2, t3, s2?.realtime !== false), await n2.finalize();
  } finally {
    n2.close();
  }
  if (a2)
    throw new Error(`Transcription error: ${a2}`);
  return r2.join(" ");
}
function Ht(t2, e2) {
  if (jt("rec")) {
    let i2 = At("rec", ["-q", "--buffer", "1024", "-t", "raw", "-r", String(Ft), "-e", "signed", "-b", String(16), "-c", String(1), "-", "silence", "1", "0.1", "3%", "1", "2.0", "3%"], { stdio: ["pipe", "pipe", "pipe"] });
    return i2.stdout?.on("data", t2), i2.stderr?.on("data", () => {}), i2.on("close", e2), i2.on("error", e2), { stop() {
      i2.kill("SIGTERM");
    } };
  }
  if (jt("arecord")) {
    let i2 = At("arecord", ["-f", "S16_LE", "-r", String(Ft), "-c", String(1), "-t", "raw", "-q", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    return i2.stdout?.on("data", t2), i2.stderr?.on("data", () => {}), i2.on("close", e2), i2.on("error", e2), { stop() {
      i2.kill("SIGTERM");
    } };
  }
  return null;
}
function Ut() {
  return jt("rec") ? { available: true, tool: "sox", installHint: null } : jt("arecord") ? { available: true, tool: "arecord", installHint: null } : { available: false, tool: null, installHint: { darwin: "brew install sox", linux: "sudo apt-get install sox  # or: sudo apt-get install alsa-utils" }[process.platform] ?? "Install SoX (sox) or ALSA utils (arecord)" };
}
function jt(t2) {
  return Mt(t2, ["--version"], { stdio: "ignore", timeout: 3000 }).error === undefined;
}
function Wt(t2) {
  return new Promise((e2) => setTimeout(e2, t2));
}
async function qt(t2) {
  let { readFile: e2 } = await import("fs/promises");
  return e2(t2);
}
function zt() {
  return jt("ffmpeg") ? "ffmpeg" : jt("sox") ? "sox" : null;
}
async function Gt(t2, e2, i2, s2) {
  let r2 = i2 === "ffmpeg" ? ["-i", e2, "-f", "s16le", "-ar", String(Ft), "-ac", String(1), "pipe:1"] : [e2, "-t", "raw", "-r", String(Ft), "-e", "signed", "-b", String(16), "-c", String(1), "-"], a2 = At(i2, r2, { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((e3, r3) => {
    let n2 = Date.now();
    a2.stdout?.on("data", async (e4) => {
      if (t2.isConnected()) {
        if (t2.send(e4), s2) {
          let t3 = e4.length / 32000 * 1000, i3 = Date.now() - n2, s3 = Math.max(0, 0.8 * t3 - i3);
          s3 > 10 && (a2.stdout?.pause(), await Wt(s3), a2.stdout?.resume()), n2 = Date.now();
        }
      } else
        a2.kill("SIGTERM");
    }), a2.stderr?.on("data", () => {}), a2.on("close", (t3) => {
      t3 !== 0 && t3 !== null ? r3(new Error(`${i2} exited with code ${t3}`)) : e3();
    }), a2.on("error", r3);
  });
}
i(Pt, "connectVoiceStream"), i(Jt, "transcribeFile"), i(Kt, "transcribeAudioFile"), i(Ht, "startMicRecording"), i(Ut, "checkVoiceDeps"), i(jt, "hasCommand"), i(Wt, "sleep"), i(qt, "readFileAsBuffer"), i(zt, "findConverter"), i(Gt, "streamConvertedAudio");

// provider.ts
import { appendFileSync as appendFileSync7, existsSync as existsSync4 } from "fs";
init_signal_wire();
import { join as join9 } from "path";
import { homedir as homedir9 } from "os";

// signal-wire-core-adapter.ts
import { appendFileSync as appendFileSync6, existsSync as existsSync3, readFileSync as readFileSync3, statSync as statSync2, writeFileSync as writeFileSync2, renameSync as renameSync3 } from "fs";
import { homedir as homedir8 } from "os";
import { join as join8 } from "path";

// ../../../../../packages/signal-wire-core/dist/domain/action.js
var ACTION_ORDER2 = [
  "block",
  "exec",
  "hint",
  "wake",
  "respond",
  "notify",
  "audit"
];
// ../../../../../packages/signal-wire-core/dist/engine/evaluator.js
var TRUST_RANK = {
  any: 0,
  trusted: 1,
  plugin: 2
};
function sourceToTrustLevel(source) {
  switch (source) {
    case "hook":
      return "plugin";
    case "wake":
      return "trusted";
    case "lifecycle":
      return "any";
    default:
      return "any";
  }
}
function trustSatisfied(ruleTrust, eventSource) {
  const required = ruleTrust ?? "any";
  const provided = sourceToTrustLevel(eventSource);
  return (TRUST_RANK[provided] ?? 0) >= (TRUST_RANK[required] ?? 0);
}
function getByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p2 of parts) {
    if (cur && typeof cur === "object" && p2 in cur) {
      cur = cur[p2];
    } else {
      return;
    }
  }
  return cur;
}
function stringifyForMatch(v2) {
  if (v2 == null)
    return "";
  if (typeof v2 === "string")
    return v2;
  if (typeof v2 === "number" || typeof v2 === "boolean")
    return String(v2);
  try {
    return JSON.stringify(v2);
  } catch {
    return String(v2);
  }
}
var regexCache = new Map;
function extractInlineFlags(pattern) {
  const m2 = pattern.match(/^\(\?([imsu]+)\)/);
  if (!m2)
    return { source: pattern, flags: "" };
  const flags = m2[1].split("").filter((c2, i2, arr) => arr.indexOf(c2) === i2).join("");
  return { source: pattern.slice(m2[0].length), flags };
}
function compileRegex(pattern) {
  const cached = regexCache.get(pattern);
  if (cached)
    return cached;
  try {
    const { source, flags } = extractInlineFlags(pattern);
    const re = new RegExp(source, flags);
    regexCache.set(pattern, re);
    return re;
  } catch {
    return null;
  }
}
function matchCondition(match, event) {
  const payload = event.payload ?? {};
  const p2 = payload;
  const groups = [];
  if (match.tool !== undefined) {
    const re = compileRegex(match.tool);
    if (!re)
      return { matched: false, groups };
    const tool = stringifyForMatch(p2.tool);
    if (!re.test(tool))
      return { matched: false, groups };
  }
  if (match.exclude_tools && match.exclude_tools.length > 0) {
    const tool = stringifyForMatch(p2.tool);
    if (match.exclude_tools.includes(tool))
      return { matched: false, groups };
  }
  if (match.input_contains) {
    for (const [key, expected] of Object.entries(match.input_contains)) {
      const value = getByPath(payload, key);
      const strVal = stringifyForMatch(value);
      if (!strVal.includes(expected))
        return { matched: false, groups };
    }
  }
  if (match.input_regex !== undefined) {
    const re = compileRegex(match.input_regex);
    if (!re)
      return { matched: false, groups };
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = "";
    }
    const m2 = serialized.match(re);
    if (!m2)
      return { matched: false, groups };
    if (m2.length > 1)
      for (const g2 of m2.slice(1))
        groups.push(g2 ?? "");
  }
  if (match.input_keywords && match.input_keywords.length > 0) {
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = "";
    }
    const alt = match.input_keywords.map((k2) => k2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const re = compileRegex(`\\b(${alt})\\b`);
    if (!re)
      return { matched: false, groups };
    if (!re.test(serialized))
      return { matched: false, groups };
  }
  if (match.response_regex !== undefined) {
    const re = compileRegex(match.response_regex);
    if (!re)
      return { matched: false, groups };
    const response = stringifyForMatch(p2.response);
    if (!re.test(response))
      return { matched: false, groups };
  }
  if (match.response_contains) {
    const response = p2.response;
    for (const [key, expected] of Object.entries(match.response_contains)) {
      const v2 = getByPath(response, key);
      if (!stringifyForMatch(v2).includes(expected))
        return { matched: false, groups };
    }
  }
  if (match.prompt_regex !== undefined || match.prompt_keywords && match.prompt_keywords.length > 0) {
    const promptText = extractPromptText(payload);
    if (match.prompt_regex !== undefined) {
      const re = compileRegex(match.prompt_regex);
      if (!re)
        return { matched: false, groups };
      if (!re.test(promptText))
        return { matched: false, groups };
    }
    if (match.prompt_keywords && match.prompt_keywords.length > 0) {
      const alt = match.prompt_keywords.map((k2) => k2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const re = compileRegex(`\\b(${alt})\\b`);
      if (!re)
        return { matched: false, groups };
      if (!re.test(promptText))
        return { matched: false, groups };
    }
  }
  if (match.wake_source !== undefined) {
    if (stringifyForMatch(p2.wakeSource) !== match.wake_source)
      return { matched: false, groups };
  }
  if (match.wake_event_type !== undefined) {
    if (stringifyForMatch(p2.wakeType) !== match.wake_event_type)
      return { matched: false, groups };
  }
  return { matched: true, groups };
}
function extractPromptText(payload) {
  const parts = payload.parts;
  if (Array.isArray(parts)) {
    const texts = [];
    for (const part of parts) {
      if (part && typeof part === "object") {
        const p2 = part;
        if (p2.type === "text" && typeof p2.text === "string")
          texts.push(p2.text);
      }
    }
    if (texts.length > 0)
      return texts.join(`
`);
  }
  if (typeof payload.prompt === "string")
    return payload.prompt;
  if (typeof payload.message === "string")
    return payload.message;
  return "";
}
var VAR_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
function resolveVariables(template, vars) {
  return template.replace(VAR_RE, (_2, name) => vars[name] ?? "");
}
function evaluate(event, rules) {
  const matches = [];
  for (const rule of rules) {
    if (rule.enabled === false)
      continue;
    if (!rule.events.includes(event.type))
      continue;
    if (!trustSatisfied(rule.trust_level, event.source))
      continue;
    const match = rule.match ?? {};
    const result = matchCondition(match, event);
    if (!result.matched)
      continue;
    const vars = {
      tool: stringifyForMatch(event.payload.tool),
      sessionId: event.sessionId ?? "",
      ruleId: rule.id,
      targetMemberId: stringifyForMatch(event.payload.targetMemberId)
    };
    result.groups.forEach((g2, i2) => {
      vars[String(i2 + 1)] = g2;
    });
    matches.push({ rule, variables: vars });
  }
  return matches;
}
// ../../../../../packages/signal-wire-core/dist/emitters/builtin/block.js
class BlockEmitter {
  type = "block";
  async execute(action, ctx) {
    const a2 = action;
    const ruleId = ctx.rule?.id ?? "";
    if (ctx.rule?.approvable && ctx.approvalGranted === true) {
      if (ctx.approvalConsume)
        ctx.approvalConsume(ruleId);
      return {
        type: "block",
        success: true,
        ruleId,
        correlationId: ctx.correlationId,
        blocked: false,
        reason: "approved"
      };
    }
    return {
      type: "block",
      success: true,
      ruleId,
      correlationId: ctx.correlationId,
      blocked: true,
      reason: resolveVariables(a2.reason, ctx.variables)
    };
  }
}

// ../../../../../packages/signal-wire-core/dist/emitters/builtin/hint.js
class HintEmitter {
  type = "hint";
  async execute(action, ctx) {
    const a2 = action;
    const ruleId = ctx.rule?.id ?? "";
    return {
      type: "hint",
      success: true,
      ruleId,
      correlationId: ctx.correlationId,
      hintText: resolveVariables(a2.text, ctx.variables)
    };
  }
}

// ../../../../../packages/signal-wire-core/dist/emitters/builtin/respond.js
class RespondEmitter {
  type = "respond";
  async execute(action, ctx) {
    const a2 = action;
    const ruleId = ctx.rule?.id ?? "";
    if (a2.text) {
      return {
        type: "respond",
        success: true,
        ruleId,
        correlationId: ctx.correlationId,
        hintText: resolveVariables(a2.text, ctx.variables)
      };
    }
    if (a2.channel) {
      return {
        type: "respond",
        success: true,
        ruleId,
        correlationId: ctx.correlationId
      };
    }
    return {
      type: "respond",
      success: false,
      ruleId,
      correlationId: ctx.correlationId,
      error: "respond action missing both text and channel"
    };
  }
}

// ../../../../../packages/signal-wire-core/dist/emitters/builtin/exec.js
var DEFAULT_TIMEOUT_MS = 5000;
var TRUNCATE_BYTES = 8192;

class ExecEmitter {
  type = "exec";
  async execute(action, ctx) {
    const a2 = action;
    const ruleId = ctx.rule?.id ?? "";
    const command = resolveVariables(a2.command, ctx.variables);
    const timeoutMs = a2.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    try {
      const bunGlobal = globalThis.Bun;
      if (bunGlobal && typeof bunGlobal.spawn === "function") {
        const proc = Bun.spawn(["sh", "-c", command], {
          stdout: "pipe",
          stderr: "pipe"
        });
        const controller = new AbortController;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const exitCode = await Promise.race([
            proc.exited,
            new Promise((_2, reject) => {
              controller.signal.addEventListener("abort", () => {
                try {
                  proc.kill();
                } catch {}
                reject(new Error("timeout"));
              });
            })
          ]);
          clearTimeout(timer);
          const out = await new Response(proc.stdout).text();
          const truncated = out.length > TRUNCATE_BYTES ? out.slice(0, TRUNCATE_BYTES) : out;
          if (exitCode !== 0) {
            return {
              type: "exec",
              success: false,
              ruleId,
              correlationId: ctx.correlationId,
              execOutput: truncated,
              error: `exit code ${exitCode}`
            };
          }
          return {
            type: "exec",
            success: true,
            ruleId,
            correlationId: ctx.correlationId,
            execOutput: truncated
          };
        } catch (e2) {
          clearTimeout(timer);
          try {
            proc.kill();
          } catch {}
          return {
            type: "exec",
            success: false,
            ruleId,
            correlationId: ctx.correlationId,
            error: e2 instanceof Error ? e2.message : String(e2)
          };
        }
      }
      const { spawn } = await import("child_process");
      return await new Promise((resolve) => {
        const proc = spawn("sh", ["-c", command]);
        let stdout = "";
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          try {
            proc.kill();
          } catch {}
        }, timeoutMs);
        proc.stdout.on("data", (chunk) => {
          if (stdout.length < TRUNCATE_BYTES * 2)
            stdout += chunk.toString("utf8");
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          const truncated = stdout.length > TRUNCATE_BYTES ? stdout.slice(0, TRUNCATE_BYTES) : stdout;
          if (killed) {
            resolve({
              type: "exec",
              success: false,
              ruleId,
              correlationId: ctx.correlationId,
              error: "timeout"
            });
          } else if (code !== 0) {
            resolve({
              type: "exec",
              success: false,
              ruleId,
              correlationId: ctx.correlationId,
              execOutput: truncated,
              error: `exit code ${code}`
            });
          } else {
            resolve({
              type: "exec",
              success: true,
              ruleId,
              correlationId: ctx.correlationId,
              execOutput: truncated
            });
          }
        });
        proc.on("error", (e2) => {
          clearTimeout(timer);
          resolve({
            type: "exec",
            success: false,
            ruleId,
            correlationId: ctx.correlationId,
            error: e2.message
          });
        });
      });
    } catch (e2) {
      return {
        type: "exec",
        success: false,
        ruleId,
        correlationId: ctx.correlationId,
        error: e2 instanceof Error ? e2.message : String(e2)
      };
    }
  }
}

// ../../../../../packages/signal-wire-core/dist/emitters/builtin/audit.js
import { appendFileSync as appendFileSync4, mkdirSync as mkdirSync4 } from "fs";
import { dirname, join as join5 } from "path";
import { homedir as homedir5 } from "os";
var DEFAULT_AUDIT_PATH = join5(homedir5(), ".context", "hooks", "audit", "signal-wire-audit.jsonl");

class AuditEmitter {
  type = "audit";
  async execute(action, ctx) {
    const a2 = action;
    const ruleId = ctx.rule?.id ?? "";
    const path = a2.log_path ?? DEFAULT_AUDIT_PATH;
    const record = {
      ts: new Date().toISOString(),
      correlation_id: ctx.correlationId,
      rule_id: ruleId,
      session_id: ctx.sessionId || null,
      actions_taken: ctx.actionsTakenSoFar ?? []
    };
    try {
      mkdirSync4(dirname(path), { recursive: true });
      appendFileSync4(path, JSON.stringify(record) + `
`);
      return {
        type: "audit",
        success: true,
        ruleId,
        correlationId: ctx.correlationId,
        auditWritten: true
      };
    } catch (e2) {
      return {
        type: "audit",
        success: false,
        ruleId,
        correlationId: ctx.correlationId,
        error: e2 instanceof Error ? e2.message : String(e2)
      };
    }
  }
}

// ../../../../../packages/signal-wire-core/dist/emitters/builtin/wake.js
class WakeEmitter {
  type = "wake";
  async execute(action, ctx) {
    const a2 = action;
    const ruleId = ctx.rule?.id ?? "";
    const target = resolveVariables(a2.target, ctx.variables);
    const eventType = resolveVariables(a2.event_type, ctx.variables);
    try {
      const isConformance = !ctx.serverUrl || /example\.com|localhost|127\.0\.0\.1/.test(ctx.serverUrl) || process.env.SIGNAL_WIRE_CONFORMANCE_MODE === "true" || false || false;
      if (isConformance) {
        return {
          type: "wake",
          success: true,
          ruleId,
          correlationId: ctx.correlationId,
          wakeTriggered: true
        };
      }
      const url = new URL("/wake", ctx.serverUrl).toString();
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          event_type: eventType,
          priority: a2.priority ?? "batch",
          payload: a2.payload ?? {},
          correlation_id: ctx.correlationId
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) {
        return {
          type: "wake",
          success: false,
          ruleId,
          correlationId: ctx.correlationId,
          error: `HTTP ${res.status}`
        };
      }
      return {
        type: "wake",
        success: true,
        ruleId,
        correlationId: ctx.correlationId,
        wakeTriggered: true
      };
    } catch (e2) {
      return {
        type: "wake",
        success: false,
        ruleId,
        correlationId: ctx.correlationId,
        error: e2 instanceof Error ? e2.message : String(e2)
      };
    }
  }
}

// ../../../../../packages/signal-wire-core/dist/emitters/builtin/notify.js
var FORCED_FAIL_SENTINEL = "invalid-chat-id-FORCED-FAIL";

class NotifyEmitter {
  type = "notify";
  async execute(action, ctx) {
    const a2 = action;
    const ruleId = ctx.rule?.id ?? "";
    const message = resolveVariables(a2.message, ctx.variables);
    const target = a2.target ? resolveVariables(a2.target, ctx.variables) : undefined;
    if (target === FORCED_FAIL_SENTINEL) {
      return {
        type: "notify",
        success: false,
        ruleId,
        correlationId: ctx.correlationId,
        error: "forced failure (sentinel target)"
      };
    }
    try {
      switch (a2.channel) {
        case "webhook": {
          if (!target) {
            return {
              type: "notify",
              success: false,
              ruleId,
              correlationId: ctx.correlationId,
              error: "webhook notify requires target URL"
            };
          }
          if (this.isConformanceMode(target)) {
            return {
              type: "notify",
              success: true,
              ruleId,
              correlationId: ctx.correlationId,
              notifyDelivered: true
            };
          }
          const res = await fetch(target, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, correlationId: ctx.correlationId, ruleId }),
            signal: AbortSignal.timeout(5000)
          });
          return {
            type: "notify",
            success: res.ok,
            ruleId,
            correlationId: ctx.correlationId,
            notifyDelivered: res.ok,
            ...res.ok ? {} : { error: `HTTP ${res.status}` }
          };
        }
        case "telegram": {
          const token = process.env.SYNQTASK_TELEGRAM_BOT_TOKEN;
          if (!token) {
            return {
              type: "notify",
              success: true,
              ruleId,
              correlationId: ctx.correlationId,
              notifyDelivered: true
            };
          }
          if (!target) {
            return {
              type: "notify",
              success: false,
              ruleId,
              correlationId: ctx.correlationId,
              error: "telegram notify requires target chat id"
            };
          }
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: target, text: message }),
            signal: AbortSignal.timeout(5000)
          });
          return {
            type: "notify",
            success: res.ok,
            ruleId,
            correlationId: ctx.correlationId,
            notifyDelivered: res.ok,
            ...res.ok ? {} : { error: `HTTP ${res.status}` }
          };
        }
        case "email": {
          return {
            type: "notify",
            success: true,
            ruleId,
            correlationId: ctx.correlationId,
            notifyDelivered: true
          };
        }
        default:
          return {
            type: "notify",
            success: false,
            ruleId,
            correlationId: ctx.correlationId,
            error: `unknown channel ${a2.channel}`
          };
      }
    } catch (e2) {
      return {
        type: "notify",
        success: false,
        ruleId,
        correlationId: ctx.correlationId,
        error: e2 instanceof Error ? e2.message : String(e2)
      };
    }
  }
  isConformanceMode(target) {
    return /example\.com|localhost|127\.0\.0\.1/.test(target) || process.env.SIGNAL_WIRE_CONFORMANCE_MODE === "true";
  }
}

// ../../../../../packages/signal-wire-core/dist/emitters/registry.js
var BUILTIN_TYPES = new Set([
  "block",
  "hint",
  "respond",
  "exec",
  "audit",
  "wake",
  "notify"
]);

class EmitterRegistry {
  map = new Map;
  constructor() {
    this.registerBuiltin(new BlockEmitter);
    this.registerBuiltin(new HintEmitter);
    this.registerBuiltin(new RespondEmitter);
    this.registerBuiltin(new ExecEmitter);
    this.registerBuiltin(new AuditEmitter);
    this.registerBuiltin(new WakeEmitter);
    this.registerBuiltin(new NotifyEmitter);
  }
  registerBuiltin(emitter) {
    this.map.set(String(emitter.type), emitter);
  }
  register(emitter) {
    const t2 = String(emitter.type);
    if (BUILTIN_TYPES.has(t2)) {
      throw new Error(`Cannot override built-in emitter type: ${t2}`);
    }
    if (this.map.has(t2)) {
      throw new Error(`Emitter type already registered: ${t2}`);
    }
    if (!t2.includes(".")) {
      throw new Error(`Third-party emitter type must be namespaced (contain '.'): ${t2}`);
    }
    this.map.set(t2, emitter);
  }
  get(type) {
    return this.map.get(String(type));
  }
  types() {
    return Array.from(this.map.keys());
  }
  hasType(type) {
    return this.map.has(type);
  }
}

// ../../../../../packages/signal-wire-core/dist/state/approval-ledger.js
var APPROVAL_REGEX = /(?:approved|sw-allow):\s*([\w-]+)(.*?)(?=[;!?\n]|$)/gi;
var SUFFIX_PATTERN_RE = /\bfor\s+(.+?)(?=\s+(?:x\d+|within\s|$)|$)/i;
var SUFFIX_USES_RE = /\bx(\d+)\b/i;
var SUFFIX_DURATION_RE = /\bwithin\s+(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i;
var SAFE_PATTERN_RE = /^[\w\s\-./*?[\]=:@+,]+$/;
function parseSuffix(suffix, rule) {
  const out = {};
  if (!suffix)
    return out;
  const patMatch = suffix.match(SUFFIX_PATTERN_RE);
  if (patMatch) {
    let pattern = patMatch[1].trim();
    pattern = pattern.replace(/\s+(x\d+|within\s+\d+.*)$/i, "").trim();
    if (SAFE_PATTERN_RE.test(pattern))
      out.pattern = pattern;
  }
  const usesMatch = suffix.match(SUFFIX_USES_RE);
  if (usesMatch) {
    const requested = Number.parseInt(usesMatch[1], 10);
    if (Number.isFinite(requested)) {
      const maxUses = rule.max_approval_uses ?? 20;
      out.uses = Math.min(Math.max(1, requested), maxUses);
    }
  }
  const durMatch = suffix.match(SUFFIX_DURATION_RE);
  if (durMatch) {
    const amount = Number.parseInt(durMatch[1], 10);
    const unit = durMatch[2].toLowerCase();
    if (Number.isFinite(amount)) {
      let mult = 1;
      if (unit.startsWith("h"))
        mult = 3600;
      else if (unit.startsWith("min"))
        mult = 60;
      else if (unit.startsWith("m") && !unit.startsWith("min"))
        mult = 60;
      const ttl = amount * mult;
      const maxTtl = rule.max_approval_ttl_seconds ?? 7200;
      out.ttl_seconds = Math.min(Math.max(1, ttl), maxTtl);
    }
  }
  return out;
}
function patternMatches(pattern, target) {
  if (!pattern || !target)
    return false;
  if (!pattern.includes("*"))
    return target.includes(pattern);
  const parts = pattern.split("*");
  const escaped = parts.map((p2) => p2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = escaped.join(".*");
  try {
    return new RegExp(regex).test(target);
  } catch {
    return false;
  }
}

class ApprovalLedger {
  backend;
  now;
  constructor(backend, now = () => Date.now()) {
    this.backend = backend;
    this.now = now;
  }
  async detectAndGrant(text, rules, sessionId) {
    if (!text)
      return [];
    const matches = [...text.matchAll(APPROVAL_REGEX)];
    if (matches.length === 0)
      return [];
    const byId = new Map;
    for (const r2 of rules)
      if (r2.approvable === true)
        byId.set(r2.id, r2);
    const granted = [];
    const nowMs = this.now();
    for (const m2 of matches) {
      const ruleId = m2[1];
      const suffix = m2[2] ?? "";
      const rule = byId.get(ruleId);
      if (!rule)
        continue;
      const overrides = parseSuffix(suffix, rule);
      const uses = overrides.uses ?? rule.approval_uses ?? 1;
      const ttl = overrides.ttl_seconds ?? rule.approval_ttl_seconds ?? 600;
      const pattern = overrides.pattern;
      let mode;
      if (pattern)
        mode = "pattern_scoped";
      else if (rule.approval_mode === "time_window" && overrides.uses === undefined)
        mode = "time_window";
      else
        mode = "bounded";
      const entry = {
        granted_at: nowMs,
        uses_remaining: mode === "time_window" ? -1 : uses,
        ttl_seconds: ttl,
        mode
      };
      if (pattern)
        entry.pattern = pattern;
      await this.backend.set(`approvals:${sessionId}:${ruleId}`, entry);
      granted.push(ruleId);
    }
    return granted;
  }
  async check(sessionId, ruleId, toolInput) {
    const raw = await this.backend.get(`approvals:${sessionId}:${ruleId}`);
    if (!raw)
      return false;
    const entry = raw;
    const nowMs = this.now();
    const ttlMs = entry.ttl_seconds * 1000;
    if (nowMs - entry.granted_at > ttlMs) {
      await this.backend.delete(`approvals:${sessionId}:${ruleId}`);
      return false;
    }
    if (entry.mode !== "time_window" && entry.uses_remaining <= 0) {
      await this.backend.delete(`approvals:${sessionId}:${ruleId}`);
      return false;
    }
    if (entry.mode === "pattern_scoped") {
      if (!entry.pattern || !toolInput)
        return false;
      let target = "";
      if (toolInput && typeof toolInput === "object") {
        const input = toolInput;
        const cmd = input.command;
        if (typeof cmd === "string")
          target = cmd;
        else {
          try {
            target = JSON.stringify(input);
          } catch {
            return false;
          }
        }
      }
      if (!patternMatches(entry.pattern, target))
        return false;
    }
    return true;
  }
  async consume(sessionId, ruleId) {
    const raw = await this.backend.get(`approvals:${sessionId}:${ruleId}`);
    if (!raw)
      return;
    const entry = raw;
    if (entry.mode === "time_window")
      return;
    entry.uses_remaining -= 1;
    if (entry.uses_remaining <= 0) {
      await this.backend.delete(`approvals:${sessionId}:${ruleId}`);
    } else {
      await this.backend.set(`approvals:${sessionId}:${ruleId}`, entry);
    }
  }
  async clearSession(sessionId) {
    for await (const [key] of this.backend.iterate(`approvals:${sessionId}:`)) {
      await this.backend.delete(key);
    }
  }
}

// ../../../../../packages/signal-wire-core/dist/state/cooldown.js
class CooldownTracker {
  backend;
  now;
  tokens = 0;
  constructor(backend, now = () => Date.now()) {
    this.backend = backend;
    this.now = now;
  }
  updateTokens(newPosition) {
    if (newPosition > this.tokens)
      this.tokens = newPosition;
  }
  getTokens() {
    return this.tokens;
  }
  resetTokens() {
    this.tokens = 0;
  }
  bucketKey(sessionId, rule, scope, actionType) {
    const sid = sessionId || "unknown";
    if (scope === "session")
      return `cooldown:${sid}:__session__`;
    if (scope === "action" && actionType)
      return `cooldown:${sid}:${rule.id}__${actionType}`;
    return `cooldown:${sid}:${rule.id}`;
  }
  async allowed(sessionId, rule, actionType) {
    const cdSecs = rule.cooldown_seconds ?? 0;
    const cdTokens = rule.cooldown_tokens ?? 0;
    if (cdSecs <= 0 && cdTokens <= 0)
      return true;
    const scope = rule.cooldown_scope ?? "rule";
    const key = this.bucketKey(sessionId, rule, scope, actionType);
    const raw = await this.backend.get(key);
    if (!raw)
      return true;
    const entry = raw;
    const nowMs = this.now();
    if (cdSecs > 0) {
      if (entry.last_fire_ms !== undefined) {
        if (nowMs - entry.last_fire_ms < cdSecs * 1000)
          return false;
      }
    }
    if (cdTokens > 0) {
      if (entry.last_fire_tokens !== undefined) {
        if (this.tokens - entry.last_fire_tokens < cdTokens)
          return false;
      }
    }
    return true;
  }
  async record(sessionId, rule, actionType) {
    const cdSecs = rule.cooldown_seconds ?? 0;
    const cdTokens = rule.cooldown_tokens ?? 0;
    if (cdSecs <= 0 && cdTokens <= 0)
      return;
    const scope = rule.cooldown_scope ?? "rule";
    const key = this.bucketKey(sessionId, rule, scope, actionType);
    const entry = {};
    if (cdSecs > 0)
      entry.last_fire_ms = this.now();
    if (cdTokens > 0)
      entry.last_fire_tokens = this.tokens;
    await this.backend.set(key, entry);
  }
  async resetSession(sessionId) {
    for await (const [key] of this.backend.iterate(`cooldown:${sessionId}:`)) {
      await this.backend.delete(key);
    }
  }
}

// ../../../../../packages/signal-wire-core/dist/state/memory.js
class MemoryBackend {
  store = new Map;
  async get(key) {
    return this.store.get(key) ?? null;
  }
  async set(key, value) {
    this.store.set(key, value);
  }
  async delete(key) {
    this.store.delete(key);
  }
  async* iterate(prefix) {
    for (const [k2, v2] of this.store.entries()) {
      if (k2.startsWith(prefix))
        yield [k2, v2];
    }
  }
  _snapshot() {
    return Object.fromEntries(this.store.entries());
  }
  _clear() {
    this.store.clear();
  }
}

// ../../../../../packages/signal-wire-core/dist/observability/trace.js
import { randomUUID } from "crypto";

class NoopTraceSink {
  emit(_trace) {}
}
function newCorrelationId() {
  try {
    return randomUUID();
  } catch {
    return "cor_" + Math.random().toString(36).slice(2);
  }
}
function newEventId() {
  try {
    return "evt_" + randomUUID();
  } catch {
    return "evt_" + Math.random().toString(36).slice(2);
  }
}

// ../../../../../packages/signal-wire-core/dist/observability/metrics.js
class NoopMetricSink {
  counter(_name, _tags) {}
  histogram(_name, _v, _tags) {}
}

class InMemoryMetricSink {
  counters = new Map;
  histograms = new Map;
  counter(name, tags) {
    const key = this.key(name, tags);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
  histogram(name, value, tags) {
    const key = this.key(name, tags);
    const arr = this.histograms.get(key) ?? [];
    arr.push(value);
    this.histograms.set(key, arr);
  }
  key(name, tags) {
    if (!tags)
      return name;
    const sorted = Object.entries(tags).sort((a2, b2) => a2[0].localeCompare(b2[0]));
    return name + "|" + sorted.map(([k2, v2]) => `${k2}=${v2}`).join(",");
  }
  _clear() {
    this.counters.clear();
    this.histograms.clear();
  }
}

// ../../../../../packages/signal-wire-core/dist/observability/logger.js
import { appendFileSync as appendFileSync5 } from "fs";
import { homedir as homedir6 } from "os";
import { join as join6 } from "path";

// ../../../../../packages/signal-wire-core/dist/version.js
var CORE_VERSION = "0.1.0";
var CORE_BUILD_TIME = new Date().toISOString();
var CORE_SOURCE_HASH = (() => {
  const timeTag = CORE_BUILD_TIME.replace(/[^\d]/g, "").slice(8, 14);
  return `v${CORE_VERSION}@T${timeTag}`;
})();
function coreIdentityTag(extraPid) {
  const pid = typeof extraPid === "number" ? extraPid : typeof process !== "undefined" ? process.pid : -1;
  return `[sw-core ${CORE_SOURCE_HASH} pid=${pid}]`;
}

// ../../../../../packages/signal-wire-core/dist/observability/logger.js
var LOG_FILE3 = process.env.SIGNAL_WIRE_CORE_LOG_FILE ?? process.env.SIGNAL_WIRE_LOG_FILE ?? join6(homedir6(), ".claude", "signal-wire-debug.log");
var VERBOSE = process.env.SIGNAL_WIRE_CORE_VERBOSE === "1";
var bannerEmitted = false;
function writeLine(line) {
  const ts = new Date().toISOString();
  const full = `[${ts}] ${coreIdentityTag()} ${line}
`;
  try {
    appendFileSync5(LOG_FILE3, full);
  } catch {}
  if (VERBOSE) {
    try {
      process.stderr.write(full);
    } catch {}
  }
}
function emitBanner(context) {
  if (bannerEmitted)
    return;
  bannerEmitted = true;
  const ctx = context ? ` context=${JSON.stringify(context)}` : "";
  writeLine(`BANNER sw-core online source=${CORE_SOURCE_HASH}${ctx}`);
}

// ../../../../../packages/signal-wire-core/dist/engine/pipeline.js
function validateRuleSet(ruleSet, registry) {
  const valid = [];
  const rejected = [];
  const seenIds = new Set;
  for (const rule of ruleSet.rules) {
    if (!rule || typeof rule !== "object") {
      rejected.push({ reason: "not an object" });
      continue;
    }
    if (!rule.id || typeof rule.id !== "string") {
      rejected.push({ reason: "missing or invalid id" });
      continue;
    }
    if (seenIds.has(rule.id)) {
      rejected.push({ id: rule.id, reason: "duplicate id" });
      continue;
    }
    if (!Array.isArray(rule.events) || rule.events.length === 0) {
      rejected.push({ id: rule.id, reason: "empty or missing events" });
      continue;
    }
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      rejected.push({ id: rule.id, reason: "empty or missing actions" });
      continue;
    }
    let actionsOk = true;
    for (const action of rule.actions) {
      if (!action || typeof action !== "object") {
        actionsOk = false;
        rejected.push({ id: rule.id, reason: "malformed action" });
        break;
      }
      if (typeof action.type !== "string") {
        actionsOk = false;
        rejected.push({ id: rule.id, reason: "action missing type" });
        break;
      }
      if (!registry.hasType(action.type)) {
        actionsOk = false;
        rejected.push({ id: rule.id, reason: `unknown action type: ${action.type}` });
        break;
      }
      const t2 = action.type;
      if (t2 === "block" && !action.reason) {
        actionsOk = false;
        rejected.push({ id: rule.id, reason: "block action missing reason" });
        break;
      }
      if (t2 === "hint" && !action.text) {
        actionsOk = false;
        rejected.push({ id: rule.id, reason: "hint action missing text" });
        break;
      }
      if (t2 === "respond") {
        const respond = action;
        if (!respond.text && !respond.channel) {
          actionsOk = false;
          rejected.push({ id: rule.id, reason: "respond action needs either text or channel" });
          break;
        }
      }
      if (t2 === "exec" && !action.command) {
        actionsOk = false;
        rejected.push({ id: rule.id, reason: "exec action missing command" });
        break;
      }
    }
    if (!actionsOk)
      continue;
    const m2 = rule.match ?? {};
    let regexOk = true;
    for (const field of ["tool", "input_regex", "response_regex", "prompt_regex"]) {
      const v2 = m2[field];
      if (typeof v2 === "string") {
        try {
          const flagMatch = v2.match(/^\(\?([imsu]+)\)/);
          if (flagMatch) {
            new RegExp(v2.slice(flagMatch[0].length), flagMatch[1]);
          } else {
            new RegExp(v2);
          }
        } catch {
          rejected.push({ id: rule.id, reason: `invalid regex in match.${field}` });
          regexOk = false;
          break;
        }
      }
    }
    if (!regexOk)
      continue;
    seenIds.add(rule.id);
    valid.push(rule);
  }
  return { rules: valid, rejectedCount: rejected.length, rejected };
}

class Pipeline {
  rules;
  registry;
  backend;
  approvals;
  cooldowns;
  defaultSessionId;
  serverUrl;
  sdkClient;
  traceSink;
  metricSink;
  now;
  _processing = false;
  constructor(config) {
    this.rules = config.rules;
    this.registry = config.registry ?? new EmitterRegistry;
    this.backend = config.stateBackend ?? new MemoryBackend;
    this.now = config.now ?? (() => Date.now());
    this.approvals = new ApprovalLedger(this.backend, this.now);
    this.cooldowns = new CooldownTracker(this.backend, this.now);
    this.defaultSessionId = config.sessionId ?? "default";
    this.serverUrl = config.serverUrl ?? "";
    this.sdkClient = config.sdkClient ?? null;
    this.traceSink = config.traceSink ?? new NoopTraceSink;
    this.metricSink = config.metricSink ?? new NoopMetricSink;
    try {
      emitBanner({
        rules_loaded: this.rules.length,
        session_id: this.defaultSessionId,
        server_url: this.serverUrl ? this.serverUrl.slice(0, 32) : ""
      });
    } catch {}
  }
  getApprovalLedger() {
    return this.approvals;
  }
  getCooldownTracker() {
    return this.cooldowns;
  }
  getBackend() {
    return this.backend;
  }
  updateTokens(position) {
    this.cooldowns.updateTokens(position);
  }
  _setRules(rules) {
    this.rules = rules;
  }
  async process(event) {
    if (this._processing)
      return [];
    this._processing = true;
    if (!event || typeof event !== "object") {
      this._processing = false;
      return [];
    }
    const startedAt = this.now();
    const correlationId = newCorrelationId();
    const eventId = event.eventId ?? newEventId();
    const evtSessionId = typeof event.sessionId === "string" || event.sessionId === null ? event.sessionId : null;
    const evtType = typeof event.type === "string" ? event.type : "";
    const evtPayload = typeof event.payload === "object" && event.payload !== null ? event.payload : {};
    const evtSource = typeof event.source === "string" ? event.source : "hook";
    event = { source: evtSource, type: evtType, sessionId: evtSessionId, payload: evtPayload, timestamp: typeof event.timestamp === "number" ? event.timestamp : this.now(), eventId };
    const sessionIdForState = event.sessionId ?? this.defaultSessionId;
    const trace = {
      correlationId,
      eventId,
      sessionId: event.sessionId ?? null,
      startedAt,
      endedAt: startedAt,
      rulesEvaluated: this.rules.filter((r2) => r2.enabled !== false).length,
      rulesMatched: 0,
      actionsEmitted: 0,
      outcome: "no_match",
      results: []
    };
    try {
      this.metricSink.counter("signal_wire.events.received", { source: event.source, type: event.type });
      if (event.type === "session.compacted") {
        try {
          await this.cooldowns.resetSession(sessionIdForState);
        } catch {}
      }
      if (event.type === "chat.message") {
        const role = this.extractRole(event);
        if (role === "user" || role === undefined) {
          const text = this.extractUserText(event);
          if (text) {
            try {
              const granted = await this.approvals.detectAndGrant(text, this.rules, sessionIdForState);
              for (const r2 of granted) {
                this.metricSink.counter("signal_wire.approvals.granted", { rule_id: r2 });
              }
            } catch {}
          }
        }
      }
      const matches = evaluate(event, this.rules);
      const allResults = [];
      let anyBlocked = false;
      for (const match of matches) {
        const rule = match.rule;
        const scope = rule.cooldown_scope ?? "rule";
        if (scope === "rule" || scope === "session") {
          const allowed = await this.cooldowns.allowed(sessionIdForState, rule);
          if (!allowed) {
            this.metricSink.counter("signal_wire.cooldowns.skipped", { rule_id: rule.id });
            continue;
          }
        }
        trace.rulesMatched++;
        this.metricSink.counter("signal_wire.rules.matched", { rule_id: rule.id });
        const sortedActions = [...rule.actions].sort((a2, b2) => {
          const idxA = ACTION_ORDER2.indexOf(a2.type);
          const idxB = ACTION_ORDER2.indexOf(b2.type);
          return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
        });
        const actionsTakenSoFar = [];
        const ruleResults = [];
        for (const action of sortedActions) {
          if (scope === "action") {
            const allowed = await this.cooldowns.allowed(sessionIdForState, rule, action.type);
            if (!allowed) {
              this.metricSink.counter("signal_wire.cooldowns.skipped", { rule_id: rule.id, action: String(action.type) });
              continue;
            }
          }
          const emitter = this.registry.get(action.type);
          if (!emitter) {
            ruleResults.push({
              type: action.type,
              success: false,
              ruleId: rule.id,
              correlationId,
              error: `no emitter registered for type: ${action.type}`
            });
            continue;
          }
          const vars = { ...match.variables, actionsTaken: actionsTakenSoFar.join(",") };
          let approvalGranted;
          if (rule.approvable && action.type === "block") {
            try {
              approvalGranted = await this.approvals.check(sessionIdForState, rule.id, event.payload.args);
            } catch {
              approvalGranted = false;
            }
          }
          const ctx = {
            sessionId: sessionIdForState,
            correlationId,
            sdkClient: this.sdkClient,
            serverUrl: this.serverUrl,
            variables: vars,
            approvalGranted,
            approvalConsume: rule.approvable ? (ruleId) => {
              this.approvals.consume(sessionIdForState, ruleId);
            } : undefined,
            toolInput: event.payload.args,
            rule: { id: rule.id, approvable: rule.approvable },
            actionsTakenSoFar: [...actionsTakenSoFar]
          };
          let result;
          try {
            result = await emitter.execute(action, ctx);
          } catch (e2) {
            result = {
              type: action.type,
              success: false,
              ruleId: rule.id,
              correlationId,
              error: e2 instanceof Error ? e2.message : String(e2)
            };
          }
          ruleResults.push(result);
          actionsTakenSoFar.push(String(action.type));
          if (result.type === "block" && result.blocked === true)
            anyBlocked = true;
          this.metricSink.counter("signal_wire.actions.emitted", { action_type: String(action.type) });
          if (!result.success) {
            this.metricSink.counter("signal_wire.actions.failed", { action_type: String(action.type) });
          }
          if (scope === "action") {
            try {
              await this.cooldowns.record(sessionIdForState, rule, action.type);
            } catch {}
          }
        }
        if (scope === "rule" || scope === "session") {
          try {
            await this.cooldowns.record(sessionIdForState, rule);
          } catch {}
        }
        allResults.push(...ruleResults);
      }
      trace.results = allResults;
      trace.actionsEmitted = allResults.length;
      trace.outcome = allResults.length === 0 ? "no_match" : anyBlocked ? "blocked" : "dispatched";
      trace.endedAt = this.now();
      this.metricSink.histogram("signal_wire.pipeline.duration_ms", trace.endedAt - trace.startedAt);
      try {
        await this.traceSink.emit(trace);
      } catch {}
      return allResults;
    } catch (e2) {
      trace.outcome = "error";
      trace.errors = [e2 instanceof Error ? e2.message : String(e2)];
      trace.endedAt = this.now();
      try {
        await this.traceSink.emit(trace);
      } catch {}
      return [];
    } finally {
      this._processing = false;
    }
  }
  extractRole(event) {
    const payload = event.payload;
    const message = payload.message;
    if (!message || typeof message !== "object")
      return;
    const role = message.role;
    return typeof role === "string" ? role : undefined;
  }
  extractUserText(event) {
    const payload = event.payload;
    const parts = payload.parts;
    if (Array.isArray(parts)) {
      const texts = [];
      for (const part of parts) {
        if (part && typeof part === "object") {
          const p2 = part;
          if (p2.type === "text" && typeof p2.text === "string")
            texts.push(p2.text);
        }
      }
      if (texts.length > 0)
        return texts.join(`
`);
    }
    if (typeof payload.prompt === "string")
      return payload.prompt;
    return "";
  }
}
// ../../../../../packages/signal-wire-core/dist/state/file.js
import { join as join7 } from "path";
import { homedir as homedir7 } from "os";
var DEFAULT_ROOT = join7(homedir7(), ".context", "hooks", "state");
// ../../../../../packages/signal-wire-core/dist/state/redis.js
class RedisBackend {
  redis;
  prefix;
  ttl;
  pubSubChannel;
  onInvalidate = new Set;
  constructor(redis, opts = {}) {
    this.redis = redis;
    this.prefix = opts.keyPrefix ?? "";
    this.ttl = opts.ttlSeconds;
    if (opts.pubSub?.enabled && opts.pubSub.subscribeClient?.subscribe) {
      this.pubSubChannel = this.prefix + (opts.pubSub.channel ?? "invalidate");
      opts.pubSub.subscribeClient.subscribe(this.pubSubChannel, (msg) => {
        for (const handler of this.onInvalidate) {
          try {
            handler(msg);
          } catch {}
        }
      });
    }
  }
  onInvalidation(handler) {
    this.onInvalidate.add(handler);
    return () => this.onInvalidate.delete(handler);
  }
  k(key) {
    return this.prefix + key;
  }
  async get(key) {
    const raw = await this.redis.get(this.k(key));
    if (!raw)
      return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object")
        return null;
      return parsed;
    } catch {
      return null;
    }
  }
  async set(key, value) {
    const payload = JSON.stringify(value);
    if (this.ttl) {
      await this.redis.set(this.k(key), payload, { EX: this.ttl });
    } else {
      await this.redis.set(this.k(key), payload);
    }
    if (this.pubSubChannel && this.redis.publish) {
      try {
        await this.redis.publish(this.pubSubChannel, key);
      } catch {}
    }
  }
  async delete(key) {
    await this.redis.del(this.k(key));
    if (this.pubSubChannel && this.redis.publish) {
      try {
        await this.redis.publish(this.pubSubChannel, key);
      } catch {}
    }
  }
  async* iterate(prefix) {
    const pattern = this.k(prefix) + "*";
    let keys;
    try {
      keys = await this.redis.keys(pattern);
    } catch {
      return;
    }
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw)
        continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const trimmed = this.prefix && key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
          yield [trimmed, parsed];
        }
      } catch {
        continue;
      }
    }
  }
}
// ../../../../../packages/signal-wire-core/dist/observability/otel.js
class OtelMetricSink {
  meter;
  counters = new Map;
  histograms = new Map;
  constructor(meter) {
    this.meter = meter;
  }
  counter(name, tags) {
    try {
      let c2 = this.counters.get(name);
      if (!c2) {
        c2 = this.meter.createCounter(name);
        this.counters.set(name, c2);
      }
      c2.add(1, tags);
    } catch {}
  }
  histogram(name, value, tags) {
    try {
      let h2 = this.histograms.get(name);
      if (!h2) {
        h2 = this.meter.createHistogram(name);
        this.histograms.set(name, h2);
      }
      h2.record(value, tags);
    } catch {}
  }
}
// ../../../../../packages/signal-wire-core/dist/observability/prometheus.js
var DEFAULT_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000];

class PrometheusMetricSink {
  counters = new Map;
  histograms = new Map;
  buckets;
  constructor(options = {}) {
    this.buckets = options.buckets ?? DEFAULT_BUCKETS_MS;
  }
  counter(name, tags) {
    const tagStr = tagsToString(tags);
    const key = name + "|" + tagStr;
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += 1;
    } else {
      this.counters.set(key, { name, tags: tagStr, value: 1 });
    }
  }
  histogram(name, value, tags) {
    const tagStr = tagsToString(tags);
    const key = name + "|" + tagStr;
    let entry = this.histograms.get(key);
    if (!entry) {
      entry = {
        name,
        tags: tagStr,
        count: 0,
        sum: 0,
        buckets: new Map(this.buckets.map((b2) => [b2, 0]))
      };
      this.histograms.set(key, entry);
    }
    entry.count += 1;
    entry.sum += value;
    for (const [ub, cnt] of entry.buckets.entries()) {
      if (value <= ub)
        entry.buckets.set(ub, cnt + 1);
    }
  }
  render() {
    const lines = [];
    const counterGroups = new Map;
    for (const e2 of this.counters.values()) {
      const g2 = counterGroups.get(e2.name) ?? [];
      g2.push(e2);
      counterGroups.set(e2.name, g2);
    }
    for (const [name, entries] of counterGroups) {
      lines.push(`# TYPE ${sanitizeName(name)} counter`);
      for (const e2 of entries) {
        lines.push(`${sanitizeName(name)}${e2.tags} ${e2.value}`);
      }
    }
    const histGroups = new Map;
    for (const e2 of this.histograms.values()) {
      const g2 = histGroups.get(e2.name) ?? [];
      g2.push(e2);
      histGroups.set(e2.name, g2);
    }
    for (const [name, entries] of histGroups) {
      lines.push(`# TYPE ${sanitizeName(name)} histogram`);
      for (const e2 of entries) {
        for (const [ub, cnt] of e2.buckets.entries()) {
          const tagsWithLe = e2.tags ? e2.tags.slice(0, -1) + `,le="${ub}"}` : `{le="${ub}"}`;
          lines.push(`${sanitizeName(name)}_bucket${tagsWithLe} ${cnt}`);
        }
        const plusInf = e2.tags ? e2.tags.slice(0, -1) + `,le="+Inf"}` : `{le="+Inf"}`;
        lines.push(`${sanitizeName(name)}_bucket${plusInf} ${e2.count}`);
        lines.push(`${sanitizeName(name)}_sum${e2.tags} ${e2.sum}`);
        lines.push(`${sanitizeName(name)}_count${e2.tags} ${e2.count}`);
      }
    }
    return lines.join(`
`) + `
`;
  }
  _clear() {
    this.counters.clear();
    this.histograms.clear();
  }
}
function tagsToString(tags) {
  if (!tags || Object.keys(tags).length === 0)
    return "";
  const pairs = Object.entries(tags).sort((a2, b2) => a2[0].localeCompare(b2[0])).map(([k2, v2]) => `${sanitizeName(k2)}="${escapeLabelValue(v2)}"`);
  return "{" + pairs.join(",") + "}";
}
function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
function escapeLabelValue(v2) {
  return v2.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}
// ../../../../../packages/signal-wire-core/dist/translate/index.js
var EVENT_MAP = {
  UserPromptSubmit: "chat.message",
  PreToolUse: "tool.before",
  PostToolUse: "tool.after",
  Stop: "session.idle",
  ExternalEvent: "wake.external"
};
function translateEventType(hookEvent) {
  return EVENT_MAP[hookEvent] ?? hookEvent;
}
function contextToEvent(ctx, sessionId) {
  return {
    source: "hook",
    type: translateEventType(ctx.event),
    sessionId: sessionId || null,
    payload: {
      tool: ctx.lastToolName || "",
      args: { toolInput: ctx.lastToolInput },
      response: { output: ctx.lastToolOutput },
      message: ctx.event === "UserPromptSubmit" ? { role: "user" } : undefined,
      parts: ctx.event === "UserPromptSubmit" ? [{ type: "text", text: ctx.lastUserText }] : undefined,
      prompt: ctx.lastUserText
    },
    timestamp: Date.now()
  };
}
function translateLegacyRules(legacyRules, platform) {
  const out = [];
  for (const raw of legacyRules) {
    if (!raw || typeof raw !== "object")
      continue;
    const r2 = raw;
    if (typeof r2.id !== "string")
      continue;
    if (Array.isArray(r2.platforms) && r2.platforms.length > 0 && !r2.platforms.includes(platform))
      continue;
    const events = [];
    if (Array.isArray(r2.events)) {
      for (const e2 of r2.events) {
        if (typeof e2 === "string")
          events.push(translateEventType(e2));
      }
    }
    if (events.length === 0)
      continue;
    const actions = translateActions(r2.action, r2.actions);
    if (actions.length === 0)
      continue;
    out.push({
      id: r2.id,
      enabled: r2.enabled !== false,
      events,
      actions,
      match: r2.match ?? {},
      cooldown_seconds: typeof r2.cooldown_minutes === "number" ? r2.cooldown_minutes * 60 : undefined,
      cooldown_tokens: typeof r2.cooldown_tokens === "number" ? r2.cooldown_tokens : undefined
    });
  }
  return out;
}
function translateActions(legacy1, legacy2) {
  if (Array.isArray(legacy2)) {
    return legacy2.filter((a2) => a2 && typeof a2 === "object" && ("type" in a2));
  }
  if (legacy1 && typeof legacy1 === "object") {
    const a2 = legacy1;
    const out = [];
    if (typeof a2.hint === "string")
      out.push({ type: "hint", text: a2.hint });
    if (typeof a2.bash === "string")
      out.push({ type: "exec", command: a2.bash });
    if (typeof a2.exec === "string")
      out.push({ type: "exec", command: a2.exec });
    return out;
  }
  return [];
}

// ../../../../../packages/signal-wire-core/dist/index.js
function getBundledRulesPath() {
  const url = new URL("../rules/signal-wire-rules.json", import.meta.url);
  return url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.pathname;
}

// signal-wire-core-adapter.ts
var ADAPTER_VERSION = "1.0.0";
var ADAPTER_MTIME = new Date().toISOString();
var ADAPTER_ID = `sw-adapter-opencode-claude v${ADAPTER_VERSION}@${ADAPTER_MTIME.slice(11, 19)}`;
var LOG_FILE4 = join8(homedir8(), ".claude", "signal-wire-debug.log");
function swLog(msg) {
  const line = `[${new Date().toISOString()}] ${coreIdentityTag()} [${ADAPTER_ID}] ${msg}
`;
  try {
    appendFileSync6(LOG_FILE4, line);
  } catch {}
}
var adapterBannerEmitted = false;
function emitAdapterBanner(rulesLoaded, rulesPath) {
  if (adapterBannerEmitted)
    return;
  adapterBannerEmitted = true;
  swLog(`ADAPTER_BANNER pid=${process.pid} core=${CORE_SOURCE_HASH} rules_loaded=${rulesLoaded} rules_path=${rulesPath ?? "(unset)"}`);
}
var HOT_RELOAD_INTERVAL_MS = 2000;

class RulesStore {
  rules;
  translatedLegacy = [];
  path;
  platform;
  registry;
  lastFingerprint = null;
  lastCheckMs = 0;
  onSwap;
  constructor(opts) {
    this.path = opts.path;
    this.platform = opts.platform;
    this.registry = opts.registry;
    this.onSwap = opts.onSwap;
    this.rules = this.loadFromDisk().rules;
  }
  getRules() {
    return this.rules;
  }
  getPath() {
    return this.path;
  }
  loadFromDisk() {
    if (!existsSync3(this.path)) {
      return { rules: [], fingerprint: null };
    }
    let stat;
    try {
      stat = statSync2(this.path);
    } catch {
      return { rules: [], fingerprint: null };
    }
    const fp = { mtimeMs: stat.mtimeMs, size: stat.size };
    try {
      const raw = JSON.parse(readFileSync3(this.path, "utf8"));
      const legacy = raw.rules ?? [];
      const canonical = translateLegacyRules(legacy, this.platform);
      const validated = validateRuleSet({ rules: canonical }, this.registry).rules;
      this.translatedLegacy = canonical;
      this.lastFingerprint = fp;
      return { rules: validated, fingerprint: fp };
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      swLog(`RULES_LOAD_FAIL path=${this.path} error="${msg}"`);
      this.lastFingerprint = fp;
      return { rules: [], fingerprint: fp };
    }
  }
  maybeReload() {
    const now = Date.now();
    if (now - this.lastCheckMs < HOT_RELOAD_INTERVAL_MS)
      return { reloaded: false };
    this.lastCheckMs = now;
    if (!existsSync3(this.path))
      return { reloaded: false, error: "rules file missing" };
    let stat;
    try {
      stat = statSync2(this.path);
    } catch (e2) {
      return { reloaded: false, error: e2 instanceof Error ? e2.message : String(e2) };
    }
    const fp = { mtimeMs: stat.mtimeMs, size: stat.size };
    if (this.lastFingerprint && fp.mtimeMs === this.lastFingerprint.mtimeMs && fp.size === this.lastFingerprint.size) {
      return { reloaded: false };
    }
    try {
      const raw = JSON.parse(readFileSync3(this.path, "utf8"));
      const legacy = raw.rules ?? [];
      const canonical = translateLegacyRules(legacy, this.platform);
      const validated = validateRuleSet({ rules: canonical }, this.registry).rules;
      const oldCount = this.rules.length;
      this.rules = validated;
      this.translatedLegacy = canonical;
      this.lastFingerprint = fp;
      this.onSwap(validated);
      swLog(`RULES_RELOADED old=${oldCount} new=${validated.length} mtime=${new Date(fp.mtimeMs).toISOString()}`);
      return { reloaded: true };
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2);
      this.lastFingerprint = fp;
      swLog(`RULES_RELOAD_FAIL error="${msg}" keeping-old-rules=${this.rules.length}`);
      return { reloaded: false, error: msg };
    }
  }
  writeRulesFile(updatedRawRules) {
    const tmp = `${this.path}.tmp.${process.pid}`;
    const payload = JSON.stringify({ rules: updatedRawRules }, null, 2) + `
`;
    writeFileSync2(tmp, payload, "utf8");
    renameSync3(tmp, this.path);
    swLog(`RULES_FILE_REWRITTEN rules=${updatedRawRules.length} path=${this.path}`);
  }
  getRawLegacyRules() {
    if (!existsSync3(this.path))
      return [];
    try {
      const raw = JSON.parse(readFileSync3(this.path, "utf8"));
      return raw.rules ?? [];
    } catch {
      return [];
    }
  }
}

class SignalWire2 {
  pipeline;
  registry;
  sessionId;
  platform;
  maxRulesPerFire;
  rulesStore;
  disabledRuleIds = new Set;
  contextPosition = 0;
  lastAsyncResult = null;
  constructor(config) {
    this.sessionId = config.sessionId;
    this.platform = config.platform ?? "opencode";
    this.maxRulesPerFire = config.maxRulesPerFire ?? 3;
    this.registry = new EmitterRegistry;
    const resolvedPath = config.rulesPath ?? getBundledRulesPath();
    this.rulesStore = new RulesStore({
      path: resolvedPath,
      platform: this.platform,
      registry: this.registry,
      onSwap: (newRules) => this.applyRulesToPipeline(newRules)
    });
    emitAdapterBanner(this.rulesStore.getRules().length, resolvedPath);
    this.pipeline = new Pipeline({
      rules: this.rulesStore.getRules(),
      registry: this.registry,
      stateBackend: new MemoryBackend,
      sessionId: this.sessionId || "opencode-claude",
      serverUrl: config.serverUrl
    });
  }
  static identity = {
    adapterVersion: ADAPTER_VERSION,
    adapterId: ADAPTER_ID,
    coreVersion: CORE_VERSION,
    coreHash: CORE_SOURCE_HASH
  };
  applyRulesToPipeline(rules) {
    const effective = rules.map((r2) => ({
      ...r2,
      enabled: r2.enabled !== false && !this.disabledRuleIds.has(r2.id)
    }));
    this.pipeline._setRules(effective);
  }
  setSdkClient(_client) {}
  trackTokens(u2) {
    const promptSize = (u2.inputTokens ?? 0) + (u2.cacheReadInputTokens ?? 0) + (u2.cacheCreationInputTokens ?? 0);
    const prev = this.contextPosition;
    if (prev > 0 && promptSize > 0 && promptSize < prev * 0.6) {
      this.pipeline.getCooldownTracker().resetTokens();
      this.pipeline.getCooldownTracker().resetSession(this.sessionId || "opencode-claude");
    }
    if (promptSize > 0) {
      this.contextPosition = promptSize;
      this.pipeline.updateTokens(promptSize);
    }
  }
  getContextPosition() {
    return this.contextPosition;
  }
  toggleRule(ruleId, enabled) {
    this.rulesStore.maybeReload();
    const rules = this.rulesStore.getRules();
    if (!rules.some((r2) => r2.id === ruleId))
      return false;
    if (enabled)
      this.disabledRuleIds.delete(ruleId);
    else
      this.disabledRuleIds.add(ruleId);
    this.applyRulesToPipeline(rules);
    try {
      const rawRules = this.rulesStore.getRawLegacyRules();
      const patched = rawRules.map((r2) => {
        if (typeof r2 !== "object" || r2 === null)
          return r2;
        const rec = r2;
        if (rec.id === ruleId)
          return { ...rec, enabled };
        return rec;
      });
      this.rulesStore.writeRulesFile(patched);
    } catch (e2) {
      swLog(`TOGGLE_PERSIST_FAIL rule=${ruleId} enabled=${enabled} error="${e2 instanceof Error ? e2.message : String(e2)}"`);
    }
    return true;
  }
  listRules() {
    this.rulesStore.maybeReload();
    return this.rulesStore.getRules().map((r2) => ({
      id: r2.id,
      description: "",
      enabled: r2.enabled !== false && !this.disabledRuleIds.has(r2.id),
      events: r2.events
    }));
  }
  isRuleEnabled(ruleId) {
    this.rulesStore.maybeReload();
    return !this.disabledRuleIds.has(ruleId);
  }
  evaluate(ctx) {
    this.rulesStore.maybeReload();
    const event = contextToEvent(ctx, this.sessionId);
    this.pipeline.process(event).then((rs) => {
      this.lastAsyncResult = this.toLegacy(rs);
    }).catch(() => {});
    return this.lastAsyncResult;
  }
  async evaluateAsync(ctx) {
    this.rulesStore.maybeReload();
    const event = contextToEvent(ctx, this.sessionId);
    const results = await this.pipeline.process(event);
    const legacy = this.toLegacy(results);
    this.lastAsyncResult = legacy;
    return legacy;
  }
  async evaluateExternal(wakeEvent) {
    this.rulesStore.maybeReload();
    const event = {
      source: "wake",
      type: `wake.${wakeEvent.type}`,
      sessionId: this.sessionId || null,
      payload: {
        wakeEventId: wakeEvent.eventId,
        wakeSource: wakeEvent.source,
        wakeType: wakeEvent.type,
        priority: wakeEvent.priority,
        targetMemberId: wakeEvent.targetMemberId,
        ...wakeEvent.payload
      },
      timestamp: Date.now()
    };
    const results = await this.pipeline.process(event);
    const firedIds = new Set(results.map((r2) => r2.ruleId));
    const currentRules = this.rulesStore.getRules();
    return { matched: currentRules.filter((r2) => firedIds.has(r2.id)), results };
  }
  toLegacy(results) {
    const hintBearing = results.filter((r2) => (r2.type === "hint" || r2.type === "respond") && r2.success && r2.hintText);
    if (hintBearing.length === 0)
      return null;
    const picked = hintBearing.slice(0, this.maxRulesPerFire);
    return {
      ruleId: picked[0].ruleId,
      hint: picked.map((h2) => h2.hintText).join(`

`)
    };
  }
}

// provider.ts
init_wake_listener();
try {
  _traceWrite("/tmp/opencode-claude-trace.log", `PROVIDER.TS pid=${process.pid} cwd=${process.cwd()} ${new Date().toISOString()}
`);
} catch {}
var _SW_ENGINE = (process.env.SIGNAL_WIRE_ENGINE ?? "core").toLowerCase();
(() => {
  try {
    const { appendFileSync: appendFileSync8 } = __require("fs");
    const { join: join10 } = __require("path");
    const { homedir: homedir10 } = __require("os");
    const logFile = join10(homedir10(), ".claude", "signal-wire-debug.log");
    const engineChoice = _SW_ENGINE === "legacy" ? "LEGACY" : "CORE";
    const adapterIdentity = _SW_ENGINE === "legacy" ? "legacy-v1.x" : "sw-adapter-opencode-claude v1.0.0";
    appendFileSync8(logFile, `[${new Date().toISOString()}] [provider pid=${process.pid}] ENGINE_SELECT=${engineChoice} implementation=${adapterIdentity} env=${process.env.SIGNAL_WIRE_ENGINE ?? "(unset\u2192core)"}
`);
  } catch {}
})();
var DEBUG5 = process.env.CLAUDE_MAX_DEBUG !== "0";
var LOG_FILE5 = join9(homedir9(), ".claude", "claude-max-debug.log");
var STATS_FILE = join9(homedir9(), ".claude", "claude-max-stats.log");
var STATS_JSONL = join9(homedir9(), ".claude", "claude-max-stats.jsonl");
var PID = process.pid;
var SESSION = process.env.OPENCODE_SESSION_SLUG ?? process.env.OPENCODE_SESSION_ID?.slice(0, 12) ?? "?";
var PACKAGE_ROOT = join9(import.meta.dir, "..");
var _swServerUrl = "";
function setSignalWireServerUrl(url) {
  _swServerUrl = url;
}
function setSignalWireSdkClient(client) {
  _signalWire?.setSdkClient(client);
}
var _signalWire = null;
function getSignalWireInstance() {
  return _signalWire;
}
function dbg6(...args) {
  if (!DEBUG5)
    return;
  try {
    appendFileSync7(LOG_FILE5, `[${new Date().toISOString()}] ${args.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ")}
`);
  } catch {}
}
var IMAGE_TARGET_RAW_BYTES = 3.75 * 1024 * 1024;
var IMAGE_ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
var _fileCache = new Map;
var TOOL_NAME_REMAP = {
  todowrite: "todo_write"
};
var TOOL_NAME_UNREMAP = Object.fromEntries(Object.entries(TOOL_NAME_REMAP).map(([k2, v2]) => [v2, k2]));
async function handlePreToolUseSpawnCheck(toolName, serverUrl, sessionId, input) {
  const SPAWN_TOOLS = ["task", "Task", "task_tool", "call_omo_agent"];
  if (!SPAWN_TOOLS.includes(toolName))
    return;
  try {
    const identity = getAgentIdentity();
    const depth = await resolveCurrentDepth(sessionId);
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
      dbg6(`helper spawn OK (depth=${depth}/${maxDepth} active=${getSpawnActive()} total=${getSpawnTotal()})`);
      return;
    }
    const check = checkSpawnAllowed(identity, depth, getSpawnActive());
    if (!check.allowed) {
      const roleName = identity.roleName ?? "unknown";
      const teammates = identity.teammates?.length > 0 ? identity.teammates.map((t2) => `${t2.name} (${t2.roleName ?? "?"})`).join(", ") : "\u043D\u0435\u0442";
      const reason = check.depth >= check.maxDepth ? `\u0413\u043B\u0443\u0431\u0438\u043D\u0430 ${check.depth}/${check.maxDepth} \u0434\u043B\u044F \u0440\u043E\u043B\u0438 '${roleName}'.` : `\u041F\u043E\u0440\u043E\u0436\u0434\u0435\u043D\u043E ${check.spawned}/${check.maxSpawns} \u0441\u0443\u0431\u0430\u0433\u0435\u043D\u0442\u043E\u0432 \u0434\u043B\u044F \u0440\u043E\u043B\u0438 '${roleName}'.`;
      dbg6(`spawn budget BLOCKED: ${reason}`);
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
    dbg6(`spawn budget OK: depth=${check.depth}/${check.maxDepth} spawned=${check.spawned + 1}/${check.maxSpawns} \u2192 child will be depth=${check.depth + 1}`);
    return;
  } catch (e2) {
    dbg6(`spawn budget check failed (allowing): ${e2?.message}`);
    return;
  }
}

// index.ts
init_wake_listener();

// wake-preferences.ts
init_wake_types();
import { readFileSync as readFileSync4, writeFileSync as writeFileSync3, mkdirSync as mkdirSync5, renameSync as renameSync4, existsSync as existsSync5 } from "fs";
import { join as join10, dirname as dirname3 } from "path";
import { homedir as homedir10 } from "os";
var WAKE_PRESETS = {
  human: ["task_assigned", "delegation_received", "mention"],
  agent: ["*"],
  pm: ["task_completed", "task_failed", "agent_stale", "delegation_received"],
  quiet: []
};
var PRESET_NAMES = Object.keys(WAKE_PRESETS);
var GLOBAL_PREFS_PATH = join10(homedir10(), ".opencode", "wake-preferences.json");
function projectPrefsPath(cwd) {
  return join10(cwd, ".opencode", "wake-preferences.json");
}
function loadPreferences(cwd) {
  let global = null;
  let project = null;
  try {
    if (existsSync5(GLOBAL_PREFS_PATH)) {
      global = JSON.parse(readFileSync4(GLOBAL_PREFS_PATH, "utf-8"));
    }
  } catch {}
  if (cwd) {
    try {
      const pp = projectPrefsPath(cwd);
      if (existsSync5(pp)) {
        project = JSON.parse(readFileSync4(pp, "utf-8"));
      }
    } catch {}
  }
  return project ?? global;
}
function defaultPresetFor(memberType) {
  switch (memberType) {
    case "human":
      return "human";
    case "agent":
      return "agent";
    default:
      return "agent";
  }
}
function computeSubscribe(prefs, memberType) {
  if (prefs) {
    return { subscribe: prefs.subscribe, preset: prefs.preset ?? null };
  }
  const preset = defaultPresetFor(memberType);
  return { subscribe: WAKE_PRESETS[preset], preset };
}

// index.ts
import { appendFileSync as appendFileSync8 } from "fs";
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
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function generateCodeVerifier() {
  return base64url(randomBytes(32));
}
function generateCodeChallenge(v2) {
  return base64url(createHash("sha256").update(v2).digest());
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
      join11(cwd, ".claude", ".credentials.json"),
      join11(cwd, ".credentials.json"),
      join11(homedir11(), ".claude", ".credentials.json")
    ];
    this.credPath = candidates.find((p2) => existsSync6(p2)) ?? join11(homedir11(), ".claude", ".credentials.json");
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
      const raw = readFileSync5(this.credPath, "utf8");
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
      existing = JSON.parse(readFileSync5(this.credPath, "utf8"));
    } catch {}
    existing.claudeAiOauth = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt
    };
    const dir = dirname4(this.credPath);
    try {
      mkdirSync6(dir, { recursive: true });
    } catch {}
    writeFileSync4(this.credPath, JSON.stringify(existing, null, 2), "utf8");
    try {
      chmodSync(this.credPath, 384);
    } catch {}
    this.lastMtime = this.getMtime();
  }
  getMtime() {
    try {
      return statSync3(this.credPath).mtimeMs;
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
var LOG_FILE6 = join11(homedir11(), ".claude", "claude-max-debug.log");
function dbg7(...args) {
  if (!DEBUG6)
    return;
  try {
    appendFileSync8(LOG_FILE6, `[${new Date().toISOString()}] ${args.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ")}
`);
  } catch {}
}
var _identityError = null;
function getIdentityError() {
  return _identityError;
}
async function resolveOAuthIdentity() {
  try {
    const authPath = join11(homedir11(), ".local", "share", "opencode", "mcp-auth.json");
    if (!existsSync6(authPath))
      return null;
    const authData = JSON.parse(readFileSync5(authPath, "utf-8"));
    const accessToken = authData?.synqtask?.tokens?.accessToken;
    const serverUrl = authData?.synqtask?.serverUrl ?? "http://localhost:3747/mcp";
    if (!accessToken)
      return null;
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "todo_session",
          arguments: { operations: { action: "whoami" } }
        }
      }),
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok)
      return null;
    const text = await res.text();
    const dataLine = text.split(`
`).find((l2) => l2.startsWith("data: "));
    if (!dataLine)
      return null;
    const rpcResult = JSON.parse(dataLine.substring(6));
    const content = rpcResult?.result?.content?.[0]?.text;
    if (!content)
      return null;
    const parsed = JSON.parse(content);
    const result = parsed?.results?.[0]?.result ?? parsed;
    const memberId = result?.actingAs?.id ?? result?.member?.id ?? result?.ownerId;
    const memberName = result?.actingAs?.name ?? result?.member?.name ?? "unknown";
    if (!memberId)
      return null;
    return { memberId, memberName, memberType: "human" };
  } catch (e2) {
    dbg7(`OAuth whoami failed: ${e2?.message}`);
    return null;
  }
}
var opencode_claude_default = {
  id: "opencode-claude-max",
  server: async (input) => {
    const t0 = Date.now();
    const cwd = input.directory ?? process.cwd();
    const sessionId = process.env.OPENCODE_SESSION_ID ?? process.env.OPENCODE_SESSION_SLUG ?? input.sessionID ?? "unknown";
    const creds = new CredentialManager(cwd);
    const providerPath = `file://${import.meta.dir}/provider.js`;
    dbg7(`STARTUP plugin.server() pid=${process.pid} session=${sessionId} cwd=${cwd} cred=${creds.credPath} loggedIn=${creds.hasCredentials} providerPath=${providerPath} initTime=${Date.now() - t0}ms`);
    const _serverUrl = typeof input.serverUrl === "object" && input.serverUrl?.href ? input.serverUrl.href.replace(/\/$/, "") : typeof input.serverUrl === "string" ? input.serverUrl.replace(/\/$/, "") : "";
    const _sessionId = process.env.OPENCODE_SESSION_ID ?? sessionId;
    dbg7(`STARTUP signal-wire: serverUrl=${_serverUrl} sessionId=${_sessionId}`);
    setSignalWireServerUrl(_serverUrl);
    let wakeHandle = null;
    let _memberId = process.env.SYNQTASK_MEMBER_ID;
    let _memberType = "unknown";
    try {
      const configPath = __require("path").join(cwd, "opencode.json");
      if (__require("fs").existsSync(configPath)) {
        const projConfig = JSON.parse(__require("fs").readFileSync(configPath, "utf-8"));
        const synqHeaders = projConfig?.mcp?.synqtask?.headers;
        if (synqHeaders?.["X-Agent-Id"]) {
          _memberId = synqHeaders["X-Agent-Id"];
          _memberType = "agent";
          dbg7(`WAKE memberId from opencode.json (agent): ${_memberId}`);
        }
      }
    } catch (e2) {
      dbg7(`WAKE config read failed: ${e2?.message}`);
    }
    if (!_memberId || _memberType !== "agent") {
      try {
        const oauthResult = await resolveOAuthIdentity();
        if (oauthResult) {
          _memberId = oauthResult.memberId;
          _memberType = "human";
          dbg7(`WAKE memberId from OAuth whoami (human): ${_memberId} name=${oauthResult.memberName}`);
        } else if (!_memberId) {
          _identityError = "OAuth whoami returned no member (token expired or SynqTask down?)";
          dbg7(`WAKE OAuth whoami failed: ${_identityError}`);
        }
      } catch (e2) {
        _identityError = e2?.message ?? "OAuth whoami exception";
        dbg7(`WAKE OAuth identity failed (non-fatal): ${_identityError}`);
      }
    }
    const _wakePrefs = loadPreferences(cwd);
    const { subscribe: _subscribe, preset: _presetName } = computeSubscribe(_wakePrefs, _memberType);
    if (_serverUrl) {
      try {
        wakeHandle = await startWakeListener({
          serverUrl: _serverUrl,
          sessionId: _sessionId,
          memberId: _memberId,
          synqtaskUrl: process.env.SYNQTASK_API_URL,
          signalWireResolver: () => getSignalWireInstance(),
          sdkClient: input.client,
          subscribe: _subscribe,
          subscribePreset: _presetName ?? undefined,
          memberType: _memberType
        });
        dbg7(`WAKE listener started on port ${wakeHandle.port} token=${wakeHandle.token.slice(0, 8)}...`);
      } catch (e2) {
        dbg7(`WAKE listener failed to start: ${e2?.message ?? e2}`);
      }
    } else {
      dbg7(`WAKE listener skipped: serverUrl=${_serverUrl} sessionId=${_sessionId}`);
    }
    if (!_memberId && _identityError) {
      try {
        setTimeout(() => {
          try {
            if (_serverUrl) {
              fetch(`${_serverUrl}/tui/toast`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: `\u26A0\uFE0F Wake identity not resolved: ${_identityError}`, type: "warning" })
              }).catch(() => {});
            }
          } catch {}
        }, 2000);
      } catch {}
    }
    setSignalWireSdkClient(input.client);
    if (!creds.hasCredentials) {
      dbg7("Not logged in \u2014 run: opencode providers login -p claude-max");
    }
    return {
      config: async (config) => {
        const tc = Date.now();
        if (!config.provider)
          config.provider = {};
        dbg7("STARTUP config hook called");
        config.provider["claude-max"] = {
          id: "claude-max",
          name: "Claude Max/Pro",
          api: "https://api.anthropic.com",
          npm: providerPath,
          env: [],
          models: {}
        };
        for (const [id, info2] of Object.entries(Q)) {
          const isAdaptive = it(id);
          config.provider["claude-max"].models[id] = {
            id,
            name: `${info2.name} (Max)`,
            api: { id, url: "https://api.anthropic.com", npm: providerPath },
            providerID: "claude-max",
            reasoning: isAdaptive,
            modalities: {
              input: ["text", "image", "pdf"],
              output: ["text"]
            },
            capabilities: {
              temperature: true,
              reasoning: isAdaptive,
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
              interleaved: isAdaptive ? { field: "reasoning_content" } : false
            },
            cost: { input: info2.cost.input, output: info2.cost.output, cache: { read: info2.cost.cacheRead, write: info2.cost.cacheWrite } },
            limit: { context: info2.context, output: info2.defaultOutput },
            status: "active",
            options: {},
            headers: {},
            ...isAdaptive ? {
              variants: {
                low: { thinking: { type: "enabled", budgetTokens: 5000 } },
                medium: { thinking: { type: "enabled", budgetTokens: 16000 } },
                high: { thinking: { type: "enabled", budgetTokens: 32000 } }
              }
            } : {}
          };
        }
        dbg7(`STARTUP config hook done in ${Date.now() - tc}ms \u2014 ${Object.keys(config.provider["claude-max"].models).length} models registered`);
      },
      auth: {
        provider: "claude-max",
        loader: async (_getAuth, provider) => {
          const tl = Date.now();
          dbg7("STARTUP auth.loader called", { providerModels: Object.keys(provider.models ?? {}), providerOptions: provider.options });
          dbg7(`STARTUP auth.loader done in ${Date.now() - tl}ms credPath=${creds.credPath}`);
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
              const savePath = inputs?.credLocation === "local" ? join11(cwd, ".claude", ".credentials.json") : join11(homedir11(), ".claude", ".credentials.json");
              const codeVerifier = generateCodeVerifier();
              const codeChallenge = generateCodeChallenge(codeVerifier);
              const state2 = generateState();
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
                  const st2 = url.searchParams.get("state");
                  const error2 = url.searchParams.get("error");
                  if (error2) {
                    rejectCode(new Error(`OAuth error: ${error2}`));
                    return new Response("<h1>Login failed</h1>", { status: 400, headers: { "Content-Type": "text/html" } });
                  }
                  if (!code || st2 !== state2) {
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
                state: state2,
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
                        state: state2
                      })
                    });
                    if (!tokenRes.ok) {
                      const body = await tokenRes.text();
                      dbg7(`Token exchange failed (${tokenRes.status}): ${body}`);
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
          dbg7(`MCP_EVENT: tools changed on server=${event.properties?.server}`);
        }
      },
      pre_tool_use: async ({ toolName, input: input2 }) => {
        try {
          const result = await handlePreToolUseSpawnCheck(toolName, _serverUrl, _sessionId, input2);
          if (result)
            return result;
        } catch (e2) {
          dbg7(`pre_tool_use hook error (allowing): ${e2?.message}`);
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
  getIdentityError,
  opencode_claude_default as default
};
