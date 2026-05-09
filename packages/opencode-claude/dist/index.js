// @bun
var __require = import.meta.require;

// index.ts
import { createHash, randomBytes } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ../../dist/index.js
import { createHash as n, randomBytes as a } from "crypto";
import { writeFileSync as o, readFileSync as l, mkdirSync as h, chmodSync as c } from "fs";
import { dirname as u, join as d } from "path";
import { homedir as p } from "os";
import { createHash as C, randomBytes as x, randomUUID as N } from "crypto";
import { readFileSync as L, writeFileSync as P, chmodSync as F, mkdirSync as H, rmdirSync as B, statSync as U, unlinkSync as K, appendFileSync as W } from "fs";
import { join as J } from "path";
import { homedir as j } from "os";
import { appendFileSync as it, mkdirSync as st, readdirSync as rt, statSync as nt, unlinkSync as at, writeFileSync as ot } from "fs";
import { createHash as lt } from "crypto";
import { homedir as ht } from "os";
import { join as ct } from "path";
import { statSync as ut, readFileSync as dt } from "fs";
import { homedir as pt } from "os";
import { join as ft } from "path";
import { watch as Lt, appendFileSync as Pt, statSync as Ft, existsSync as Ht, renameSync as Bt, unlinkSync as Ut } from "fs";
import { homedir as Kt } from "os";
import { join as Wt } from "path";
import { readFileSync as he, writeFileSync as ce, mkdirSync as ue } from "fs";
import { dirname as de } from "path";
import { randomUUID as pe } from "crypto";
import { readFileSync as ye, statSync as we } from "fs";
import { spawn as xe, spawnSync as Ne } from "child_process";
import { request as Le } from "https";
import { randomBytes as Pe, createHash as Fe } from "crypto";
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
})(r, { getClaudeConfigDir: () => f, getDefaultCredentialsPath: () => m, oauthLogin: () => _ });
function f() {
  return (process.env.CLAUDE_CONFIG_DIR ?? d(p(), ".claude")).normalize("NFC");
}
function m() {
  return d(f(), ".credentials.json");
}
function g() {
  return k(a(32));
}
function y(t2) {
  return k(n("sha256").update(t2).digest());
}
function w() {
  return k(a(32));
}
function k(t2) {
  return t2.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
async function _(t2 = {}) {
  let e2 = t2.credentialsPath ?? m(), i2 = g(), s2 = y(i2), r2 = w(), { port: n2, waitForCode: a2, close: d2 } = await T(r2, t2.port), p2 = `http://localhost:${n2}/callback`, f2 = t2.loginWithClaudeAi !== false ? S : v, k2 = new URLSearchParams({ client_id: R, response_type: "code", scope: b, code_challenge: s2, code_challenge_method: "S256", state: r2, code: "true" });
  t2.loginHint && k2.set("login_hint", t2.loginHint), t2.loginMethod && k2.set("login_method", t2.loginMethod), t2.orgUUID && k2.set("orgUUID", t2.orgUUID);
  let _2, $, O = `${f2}?${k2.toString()}&redirect_uri=${encodeURIComponent(p2)}`, A = `${f2}?${k2.toString()}&redirect_uri=${encodeURIComponent(D)}`;
  t2.onAuthUrl ? t2.onAuthUrl(O, A) : (console.log(`
\uD83D\uDD10 Login to Claude
`), console.log(`Open this URL in your browser:
`), console.log(`  ${A}
`)), t2.openBrowser !== false && E(O).catch(() => {});
  try {
    _2 = await a2, $ = p2;
  } catch (t3) {
    throw d2(), t3;
  }
  d2();
  let I = await fetch(M, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: _2, redirect_uri: $, client_id: R, code_verifier: i2, state: r2 }) });
  if (!I.ok) {
    let t3 = await I.text();
    throw new Error(`Token exchange failed (${I.status}): ${t3}`);
  }
  let C2 = await I.json(), x2 = Date.now() + 1000 * C2.expires_in, N2 = { accessToken: C2.access_token, refreshToken: C2.refresh_token, expiresAt: x2, scopes: C2.scope?.split(" ") ?? [] }, L2 = {};
  try {
    L2 = JSON.parse(l(e2, "utf8"));
  } catch {}
  L2.claudeAiOauth = N2;
  let P2 = u(e2);
  try {
    h(P2, { recursive: true });
  } catch {}
  return o(e2, JSON.stringify(L2, null, 2), "utf8"), c(e2, 384), console.log(`
\u2705 Login successful! Credentials saved to ${e2}
`), { accessToken: N2.accessToken, refreshToken: N2.refreshToken, expiresAt: N2.expiresAt, credentialsPath: e2 };
}
async function T(t2, e2) {
  let s2, r2, n2 = new Promise((t3, e3) => {
    s2 = t3, r2 = e3;
  }), a2 = Bun.serve({ port: e2 ?? 0, async fetch(e3) {
    let i2 = new URL(e3.url);
    if (i2.pathname !== "/callback")
      return new Response("Not found", { status: 404 });
    let n3 = i2.searchParams.get("code"), a3 = i2.searchParams.get("state"), o3 = i2.searchParams.get("error");
    return o3 ? (r2(new Error(`OAuth error: ${o3} \u2014 ${i2.searchParams.get("error_description") ?? ""}`)), new Response("<html><body><h1>Login failed</h1><p>You can close this tab.</p></body></html>", { status: 400, headers: { "Content-Type": "text/html" } })) : n3 && a3 === t2 ? (s2(n3), new Response(null, { status: 302, headers: { Location: `${$}/oauth/code/success?app=claude-code` } })) : (r2(new Error("Invalid callback: missing code or state mismatch")), new Response("Invalid request", { status: 400 }));
  } }), o2 = setTimeout(() => {
    r2(new Error("Login timed out (5 minutes). Try again.")), a2.stop();
  }, 300000);
  return { port: a2.port, waitForCode: n2.finally(() => clearTimeout(o2)), close: i(() => {
    clearTimeout(o2), a2.stop();
  }, "close") };
}
async function E(t2) {
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
var R;
var $;
var v;
var S;
var M;
var D;
var b;
var O;
var A;
var I = (O = { "src/auth.ts"() {
  R = "9d1c250a-e61b-44d9-88ed-5944d1962f5e", v = ($ = "https://platform.claude.com") + "/oauth/authorize", S = "https://claude.com/cai/oauth/authorize", M = `${$}/v1/oauth/token`, D = `${$}/oauth/code/callback`, i(f, "getClaudeConfigDir"), i(m, "getDefaultCredentialsPath"), b = ["user:profile", "user:inference", "org:create_api_key", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"].join(" "), i(g, "generateCodeVerifier"), i(y, "generateCodeChallenge"), i(w, "generateState"), i(k, "base64url"), i(_, "oauthLogin"), i(T, "startCallbackServer"), i(E, "tryOpenBrowser");
} }, function() {
  return O && (A = (0, O[e(O)[0]])(O = 0)), A;
});
var q = class extends Error {
  constructor(t2, e2) {
    super(t2), this.cause = e2, this.name = "ClaudeCodeSDKError";
  }
  static {
    i(this, "ClaudeCodeSDKError");
  }
};
var z = class extends q {
  static {
    i(this, "AuthError");
  }
  constructor(t2, e2) {
    super(t2, e2), this.name = "AuthError";
  }
};
var G = class extends q {
  constructor(t2, e2, i2, s2) {
    super(t2, s2), this.status = e2, this.requestId = i2, this.name = "APIError";
  }
  static {
    i(this, "APIError");
  }
};
var Q = class extends q {
  constructor(t2, e2, i2 = 429, s2) {
    super(t2, s2), this.rateLimitInfo = e2, this.status = i2, this.name = "RateLimitError";
  }
  static {
    i(this, "RateLimitError");
  }
};
var Y = class extends q {
  constructor(t2, e2, i2) {
    super(`CACHE_REWRITE_BLOCKED: session idle ${Math.round(t2 / 1000)}s on model=${i2}, next request would cost ~${e2} cache_write tokens. Unset CLAUDE_MAX_REWRITE_BLOCK or raise CLAUDE_MAX_REWRITE_BLOCK_IDLE_SEC to proceed.`), this.idleMs = t2, this.estimatedTokens = e2, this.model = i2, this.name = "CacheRewriteBlockedError";
  }
  static {
    i(this, "CacheRewriteBlockedError");
  }
  code = "CACHE_REWRITE_BLOCKED";
};
var V = { "claude-opus-4-7": { name: "Claude Opus 4.7", context: 1e6, defaultOutput: 64000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 } }, "claude-opus-4-6": { name: "Claude Opus 4.6", context: 1e6, defaultOutput: 64000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 } }, "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", context: 1e6, defaultOutput: 32000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, "claude-haiku-4-5-20251001": { name: "Claude Haiku 4.5", context: 200000, defaultOutput: 32000, maxOutput: 64000, adaptiveThinking: false, cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } } };
var X = { defaultOutput: 32000, maxOutput: 128000, adaptiveThinking: false };
function Z(t2, e2) {
  if (typeof e2 == "number" && e2 > 0)
    return e2;
  let i2 = tt(t2), s2 = i2?.maxOutput ?? X.maxOutput, r2 = i2?.defaultOutput ?? X.defaultOutput, n2 = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  if (n2) {
    let t3 = parseInt(n2, 10);
    if (Number.isFinite(t3) && t3 > 0)
      return Math.min(t3, s2);
  }
  return r2;
}
function tt(t2) {
  if (V[t2])
    return V[t2];
  let e2 = t2.toLowerCase();
  for (let [t3, i2] of Object.entries(V))
    if (e2.includes(t3) || t3.includes(e2))
      return i2;
  for (let [t3, i2] of Object.entries(V)) {
    let s2 = t3.replace(/^claude-/, "").split("-").slice(0, 3).join("-");
    if (e2.includes(s2))
      return i2;
  }
}
function et(t2) {
  let e2 = tt(t2);
  if (e2)
    return e2.adaptiveThinking;
  let i2 = t2.toLowerCase();
  return i2.includes("opus-4-7") || i2.includes("opus-4-6") || i2.includes("sonnet-4-6") || i2.includes("sonnet-4-7");
}
i(Z, "resolveMaxTokens"), i(tt, "getModelMetadata"), i(et, "supportsAdaptiveThinking");
var mt = { enabled: true, initialCalls: 3, ringRetentionMs: 7200000, ringMaxMb: 300, suspiciousContextSize: 5, suspiciousRetentionMs: 86400000, suspiciousMaxMb: 100, coldCwThreshold: 1e4, metadataRetentionMs: 604800000 };
var gt = { cacheTtlMs: 300000, safetyMarginMs: 15000, intervalMs: 120000, intervalClampMin: 60000, retryDelaysMs: [2, 3, 5, 7, 10, 12, 15, 17, 20, 20, 20, 20, 20].map((t2) => 1000 * t2), rewriteWarnIdleMs: 300000, rewriteWarnTokens: 50000, healthProbeIntervalsMs: [3000, 5000, 7000, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4], healthProbeTimeoutMs: 3000, enabled: true, idleTimeoutMs: 1 / 0, minTokens: 2000, rewriteBlockEnabled: false, dump: mt, tokenRotationContextThreshold: 150000, tokenRotationPollIntervalMs: 30000, orgIdCacheTtlMs: 300000, tokenRotationLogMaxBytes: 10485760, tokenRotationLogRetentionDays: 7 };
var wt = ft(pt(), ".claude", "keepalive.json");
var kt = process.env.CLAUDE_KEEPALIVE_CONFIG_PATH || wt;
var _t = 0;
var Tt = null;
var Et = new Set;
function Rt() {
  try {
    let t2 = ut(kt);
    return t2.mtimeMs === _t && Tt ? null : (_t = t2.mtimeMs, Et.clear(), JSON.parse(dt(kt, "utf8")));
  } catch {
    return null;
  }
}
function $t(t2, e2, i2, s2, r2) {
  if (t2 == null)
    return i2;
  let n2 = typeof t2 == "number" ? t2 : Number(t2);
  return Number.isFinite(n2) ? n2 < s2 || n2 > r2 ? (Et.has(e2) || (console.error(`[keepalive-config] ${e2}=${n2} out of range [${s2}, ${r2}] \u2014 clamping`), Et.add(e2)), Math.max(s2, Math.min(r2, n2))) : n2 : (Et.has(e2) || (console.error(`[keepalive-config] ${e2}=${JSON.stringify(t2)} is not a number \u2014 using fallback ${i2}`), Et.add(e2)), i2);
}
function vt(t2, e2, i2, s2 = 1, r2 = 30) {
  if (t2 == null)
    return i2;
  if (!Array.isArray(t2))
    return Et.has(e2) || (console.error(`[keepalive-config] ${e2} is not an array \u2014 using fallback`), Et.add(e2)), i2;
  let n2 = t2.map((t3) => typeof t3 == "number" ? t3 : Number(t3)).filter((t3) => Number.isFinite(t3) && t3 > 0);
  return n2.length < s2 || n2.length > r2 ? (Et.has(e2) || (console.error(`[keepalive-config] ${e2} length ${n2.length} out of [${s2}, ${r2}] \u2014 using fallback`), Et.add(e2)), i2) : n2;
}
function St(t2, e2) {
  return t2 == null ? e2 : typeof t2 == "boolean" ? t2 : typeof t2 == "string" ? t2 === "true" || t2 === "1" || t2 === "yes" : !!t2;
}
function Mt() {
  let t2 = Rt();
  return t2 === null && Tt ? Tt : bt(t2 ?? null);
}
function Dt() {
  return _t = 0, Tt = null, Mt();
}
function bt(t2) {
  let e2 = t2 === null ? "defaults" : Object.keys(t2).length > 0 ? "mixed" : "defaults", i2 = $t(t2?.cacheTtlMs ?? (typeof t2?.cacheTtlSec == "number" ? 1000 * t2.cacheTtlSec : undefined), "cacheTtlMs", gt.cacheTtlMs, 60000, 7200000), s2 = $t(t2?.safetyMarginMs ?? (typeof t2?.safetyMarginSec == "number" ? 1000 * t2.safetyMarginSec : undefined), "safetyMarginMs", gt.safetyMarginMs, 1000, 300000), r2 = Math.max(60000, Math.min(i2 / 2, 1800000)), n2 = $t(t2?.intervalMs ?? (typeof t2?.intervalSec == "number" ? 1000 * t2.intervalSec : undefined), "intervalMs", r2, 60000, i2 - s2 - 1000), a2 = gt.intervalClampMin, o2 = Math.max(a2 + 1, i2 - s2 - 60000);
  n2 < a2 && (n2 = a2), n2 > o2 && (n2 = o2);
  let l2 = { cacheTtlMs: i2, safetyMarginMs: s2, intervalMs: n2, intervalClampMin: a2, intervalClampMax: o2, retryDelaysMs: vt(t2?.retryDelaysMs ?? (Array.isArray(t2?.retryDelaysSec) ? t2.retryDelaysSec.map((t3) => typeof t3 == "number" ? 1000 * t3 : NaN) : undefined), "retryDelaysMs", gt.retryDelaysMs), rewriteWarnIdleMs: $t(t2?.rewriteWarnIdleMs ?? (typeof t2?.rewriteWarnIdleSec == "number" ? 1000 * t2.rewriteWarnIdleSec : undefined), "rewriteWarnIdleMs", Math.max(60000, i2 - s2), 1000, 86400000), rewriteWarnTokens: $t(t2?.rewriteWarnTokens, "rewriteWarnTokens", gt.rewriteWarnTokens, 100, 1e6), healthProbeIntervalsMs: vt(t2?.healthProbeIntervalsMs, "healthProbeIntervalsMs", gt.healthProbeIntervalsMs), healthProbeTimeoutMs: $t(t2?.healthProbeTimeoutMs, "healthProbeTimeoutMs", gt.healthProbeTimeoutMs, 500, 60000), enabled: St(t2?.enabled, gt.enabled), idleTimeoutMs: t2?.idleTimeoutMs === null || t2?.idleTimeoutSec === null ? 1 / 0 : $t(t2?.idleTimeoutMs ?? (typeof t2?.idleTimeoutSec == "number" ? 1000 * t2.idleTimeoutSec : undefined), "idleTimeoutMs", gt.idleTimeoutMs === 1 / 0 ? 86400000 : gt.idleTimeoutMs, 0, 86400000), minTokens: $t(t2?.minTokens, "minTokens", gt.minTokens, 1, 1e6), rewriteBlockEnabled: St(t2?.rewriteBlockEnabled, gt.rewriteBlockEnabled), dump: mt, tokenRotationContextThreshold: $t(t2?.tokenRotationContextThreshold, "tokenRotationContextThreshold", gt.tokenRotationContextThreshold, 1000, 1e7), tokenRotationPollIntervalMs: $t(t2?.tokenRotationPollIntervalMs, "tokenRotationPollIntervalMs", gt.tokenRotationPollIntervalMs, 5000, 3600000), orgIdCacheTtlMs: $t(t2?.orgIdCacheTtlMs, "orgIdCacheTtlMs", gt.orgIdCacheTtlMs, 1e4, 86400000), tokenRotationLogMaxBytes: $t(t2?.tokenRotationLogMaxBytes, "tokenRotationLogMaxBytes", gt.tokenRotationLogMaxBytes, 1024, 1073741824), tokenRotationLogRetentionDays: $t(t2?.tokenRotationLogRetentionDays, "tokenRotationLogRetentionDays", gt.tokenRotationLogRetentionDays, 1, 3650), t: e2 };
  return Tt = l2, l2;
}
function Ot() {
  return kt;
}
function At() {
  return Mt().cacheTtlMs;
}
function It() {
  return Mt().safetyMarginMs;
}
function Ct(t2) {
  let e2 = t2;
  if (!e2)
    return "permanent";
  let i2 = e2.status;
  if (i2 === 401 || i2 === 403)
    return "auth";
  if (i2 === 429 || i2 === 503 || i2 === 529 || i2 && i2 >= 500)
    return "server_transient";
  if (i2 && i2 >= 400 && i2 < 500)
    return "permanent";
  let s2 = e2.code ?? e2.cause?.code ?? "", r2 = e2.name ?? e2.cause?.name ?? "", n2 = `${(e2.message ?? "").toLowerCase()} ${(e2.cause?.message ?? "").toLowerCase()}`.trim();
  return r2 === "AbortError" || r2 === "TimeoutError" || n2.includes("aborted") || n2.includes("the operation timed out") || n2.includes("request timed out") || s2 && new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_ABORTED", "ABORT_ERR", "ERR_NETWORK", "ConnectionRefused", "FailedToOpenSocket"]).has(s2) || n2.includes("unable to connect") || n2.includes("failed to open socket") || n2.includes("connection refused") || n2.includes("network is unreachable") || n2.includes("network error") || n2.includes("fetch failed") || n2.includes("timeout") || n2.includes("dns") || n2.includes("socket hang up") || n2.includes("terminated") ? "network" : "server_transient";
}
i(Rt, "readRawConfig"), i($t, "num"), i(vt, "numArray"), i(St, "bool"), i(Mt, "loadKeepaliveConfig"), i(Dt, "reloadKeepaliveConfig"), i(bt, "_resolve"), i(Ot, "getConfigPath"), i(At, "getCacheTtlMs"), i(It, "getSafetyMarginMs"), i(Ct, "classifyError");
var xt = class _KeepaliveEngine {
  static {
    i(this, "KeepaliveEngine");
  }
  cacheTtlMs;
  safetyMarginMs;
  retryDelaysMs;
  healthProbeIntervalsMs;
  healthProbeTimeoutMs;
  static SNAPSHOT_TTL_MS = 60 * (parseInt(process.env.CLAUDE_SDK_SNAPSHOT_TTL_MIN ?? "1440", 10) || 1440) * 1000;
  static DUMP_BODY = process.env.CLAUDE_SDK_DUMP_BODY === "1";
  config;
  getToken;
  doFetch;
  getRateLimitInfo;
  isOwnerAlive;
  lastKnownCacheTokensByModel = new Map;
  networkState = "healthy";
  healthProbeTimer = null;
  healthProbeAttempt = 0;
  registry = new Map;
  i = "";
  o = null;
  l = null;
  lastActivityAt = 0;
  lastRealActivityAt = 0;
  cacheWrittenAt = 0;
  timer = null;
  retryTimer = null;
  abortController = null;
  inFlight = false;
  jitterMs = 0;
  snapshotCallCount = 0;
  constructor(t2) {
    this.getToken = t2.getToken, this.doFetch = t2.doFetch, this.getRateLimitInfo = t2.getRateLimitInfo, this.isOwnerAlive = t2.isOwnerAlive ?? (() => true);
    let e2 = t2.config ?? {}, i2 = Mt();
    this.cacheTtlMs = i2.cacheTtlMs, this.safetyMarginMs = i2.safetyMarginMs, this.retryDelaysMs = i2.retryDelaysMs, this.healthProbeIntervalsMs = i2.healthProbeIntervalsMs, this.healthProbeTimeoutMs = i2.healthProbeTimeoutMs;
    let s2 = e2.intervalMs ?? i2.intervalMs;
    s2 < i2.intervalClampMin && (console.error(`[claude-sdk] keepalive intervalMs=${s2} below safe min (${i2.intervalClampMin}); clamped`), s2 = i2.intervalClampMin), s2 > i2.intervalClampMax && (console.error(`[claude-sdk] keepalive intervalMs=${s2} above safe max (${i2.intervalClampMax}, cacheTTL ${this.cacheTtlMs}ms - margin ${this.safetyMarginMs}ms - 60s); clamped`), s2 = i2.intervalClampMax), this.config = { enabled: e2.enabled ?? i2.enabled, intervalMs: s2, idleTimeoutMs: e2.idleTimeoutMs ?? i2.idleTimeoutMs, minTokens: e2.minTokens ?? i2.minTokens, rewriteWarnIdleMs: e2.rewriteWarnIdleMs ?? i2.rewriteWarnIdleMs, rewriteWarnTokens: e2.rewriteWarnTokens ?? i2.rewriteWarnTokens, rewriteBlockIdleMs: e2.rewriteBlockIdleMs ?? 1 / 0, rewriteBlockEnabled: e2.rewriteBlockEnabled ?? i2.rewriteBlockEnabled, onHeartbeat: e2.onHeartbeat, onTick: e2.onTick, onDisarmed: e2.onDisarmed, onRewriteWarning: e2.onRewriteWarning, onNetworkStateChange: e2.onNetworkStateChange };
  }
  notifyRealRequestStart(t2, e2, i2) {
    this.i = t2, this.o = JSON.parse(JSON.stringify(e2)), this.l = { ...i2 }, this.abortController?.abort(), this.inFlight = false;
  }
  notifyRealRequestComplete(t2) {
    let e2 = Date.now();
    if (this.lastActivityAt = e2, this.lastRealActivityAt = e2, this.cacheWrittenAt = e2, (this.healthProbeTimer || this.networkState !== "healthy") && (this.stopHealthProbe(), this.networkState !== "healthy")) {
      let t3 = this.networkState;
      this.networkState = "healthy";
      try {
        this.config.onNetworkStateChange?.({ from: t3, to: "healthy", at: e2 });
      } catch {}
    }
    if (!this.config.enabled)
      return;
    let i2 = this.i, s2 = this.o, r2 = this.l;
    if (i2 && s2 && r2) {
      let e3 = (t2.inputTokens ?? 0) + (t2.cacheReadInputTokens ?? 0) + (t2.cacheCreationInputTokens ?? 0), n2 = this.registry.get(i2);
      e3 >= this.config.minTokens && (!n2 || e3 >= n2.inputTokens) && this.registry.set(i2, { body: s2, headers: r2, model: i2, inputTokens: e3 }), e3 > (this.lastKnownCacheTokensByModel.get(i2) ?? 0) && this.lastKnownCacheTokensByModel.set(i2, e3), this.writeSnapshotDebug(i2, s2, t2), this.o = null, this.l = null;
    }
    this.registry.size > 0 && this.startTimer();
  }
  checkRewriteGuard(t2) {
    let e2 = this.cacheWrittenAt;
    if (e2 === 0)
      return;
    let i2 = Date.now() - e2, s2 = this.config.rewriteWarnIdleMs, r2 = this.config.rewriteBlockIdleMs;
    if (i2 < s2)
      return;
    let n2 = this.lastKnownCacheTokensByModel.get(t2) ?? 0, a2 = this.config.rewriteBlockEnabled && i2 >= r2;
    if (n2 >= this.config.rewriteWarnTokens || a2)
      try {
        this.config.onRewriteWarning?.({ idleMs: i2, estimatedTokens: n2, blocked: a2, model: t2 });
      } catch {}
    if (a2)
      throw new Y(i2, n2, t2);
  }
  stop() {
    this.timer && (clearInterval(this.timer), this.timer = null), this.retryTimer && (clearTimeout(this.retryTimer), this.retryTimer = null), this.abortController?.abort(), this.registry.clear(), this.inFlight = false, this.stopHealthProbe();
  }
  startTimer() {
    if (this.timer)
      return;
    let t2 = Math.min(30000, Math.max(5000, Math.floor(this.config.intervalMs / 6)));
    this.timer = setInterval(() => this.tick(), t2), this.timer && typeof this.timer == "object" && "unref" in this.timer && this.timer.unref();
  }
  async tick() {
    try {
      let t3 = this.cacheWrittenAt > 0 ? Date.now() - this.cacheWrittenAt : -1, e3 = Math.round((Date.now() - this.lastActivityAt) / 1000), i3 = Math.max(0, Math.round((this.config.intervalMs - (Date.now() - this.lastActivityAt)) / 1000)), s3 = this.inFlight ? "firing" : this.registry.size === 0 ? "empty_registry" : "armed";
      it(ct(ht(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] KA_HEARTBEAT pid=${process.pid} state=${s3} regSize=${this.registry.size} idleSec=${e3} nextFireSec=${i3} cacheAgeSec=${t3 < 0 ? "na" : Math.round(t3 / 1000)} cacheTtlSec=${Math.round(this.cacheTtlMs / 1000)} intervalSec=${Math.round(this.config.intervalMs / 1000)}
`);
    } catch {}
    if (this.registry.size === 0 || this.inFlight)
      return;
    try {
      if (!this.isOwnerAlive())
        return this.logClearDiag("owner_dead", { ownerCheck: "tick" }), this.registry.clear(), this.stop(), void this.onDisarmed("owner_dead");
    } catch {}
    if (this.cacheWrittenAt > 0) {
      let t3 = Date.now() - this.cacheWrittenAt;
      if (t3 > this.cacheTtlMs) {
        try {
          it(ct(ht(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] KA_DISARM_CACHE_EXPIRED pid=${process.pid} cacheAgeSec=${Math.round(t3 / 1000)} cacheTtlSec=${Math.round(this.cacheTtlMs / 1000)} overSec=${Math.round((t3 - this.cacheTtlMs) / 1000)}
`);
        } catch {}
        return this.logClearDiag("cache_expired_during_sleep", { overSec: Math.round((t3 - this.cacheTtlMs) / 1000) }), this.registry.clear(), void this.onDisarmed("cache_expired_during_sleep");
      }
    }
    let t2 = Mt();
    if (!t2.enabled)
      return this.logClearDiag("config_disabled", { liveConfigEnabled: t2.enabled }), this.registry.clear(), void this.stop();
    if (t2.cacheTtlMs !== this.cacheTtlMs) {
      let e3 = this.cacheTtlMs;
      this.cacheTtlMs = t2.cacheTtlMs;
      try {
        it(ct(ht(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] CACHE_TTL_RELOADED pid=${process.pid} oldMs=${e3} newMs=${t2.cacheTtlMs} oldMin=${Math.round(e3 / 60000)} newMin=${Math.round(t2.cacheTtlMs / 60000)}
`);
      } catch {}
    }
    if (t2.safetyMarginMs !== this.safetyMarginMs) {
      let e3 = this.safetyMarginMs;
      this.safetyMarginMs = t2.safetyMarginMs;
      try {
        it(ct(ht(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] SAFETY_MARGIN_RELOADED pid=${process.pid} oldMs=${e3} newMs=${t2.safetyMarginMs}
`);
      } catch {}
    }
    let e2 = Math.max(t2.intervalClampMin, Math.min(t2.intervalMs, t2.intervalClampMax));
    e2 !== this.config.intervalMs && (this.config.intervalMs = e2), t2.idleTimeoutMs !== this.config.idleTimeoutMs && (this.config.idleTimeoutMs = t2.idleTimeoutMs), t2.minTokens !== this.config.minTokens && (this.config.minTokens = t2.minTokens);
    let i2 = Date.now() - this.lastRealActivityAt;
    if (this.config.idleTimeoutMs !== 1 / 0 && i2 > this.config.idleTimeoutMs)
      return this.logClearDiag("idle_timeout", { realIdleMs: i2, idleTimeoutMs: this.config.idleTimeoutMs }), this.registry.clear(), void this.stop();
    let s2 = null;
    for (let t3 of this.registry.values())
      (!s2 || t3.inputTokens > s2.inputTokens) && (s2 = t3);
    if (!s2)
      return;
    let r2 = Date.now() - this.lastActivityAt;
    if (this.jitterMs || (this.jitterMs = Math.floor(30000 * Math.random())), this.config.onTick?.({ idleMs: r2, nextFireMs: Math.max(0, this.config.intervalMs - r2), model: s2.model, tokens: s2.inputTokens }), !(r2 < 0.9 * this.config.intervalMs + this.jitterMs)) {
      this.inFlight = true;
      try {
        let t3 = await this.getToken(), e3 = JSON.parse(JSON.stringify(s2.body)), i3 = e3.thinking?.budget_tokens ?? 0;
        e3.max_tokens = i3 > 0 ? i3 + 1 : 1;
        let n2 = { ...s2.headers, Authorization: `Bearer ${t3}` }, a2 = new AbortController;
        this.abortController = a2;
        let o2 = Date.now(), l2 = { inputTokens: 0, outputTokens: 0 };
        for await (let t4 of this.doFetch(e3, n2, a2.signal))
          t4.type === "message_stop" && (l2 = t4.usage);
        let h2 = Date.now() - o2;
        this.lastActivityAt = Date.now(), this.cacheWrittenAt = Date.now();
        let c2 = this.getRateLimitInfo();
        this.config.onHeartbeat?.({ usage: l2, durationMs: h2, idleMs: r2, model: s2.model, rateLimit: { status: c2.status, claim: c2.claim, resetAt: c2.resetAt } });
      } catch (t3) {
        let e3 = Ct(t3);
        if (e3 === "network") {
          let t4 = Date.now() - this.cacheWrittenAt, e4 = this.cacheTtlMs - t4 <= this.safetyMarginMs;
          this.onDisarmed("network_error"), this.startHealthProbe({ reviveMode: e4 });
        } else
          e3 === "server_transient" ? this.retryChain(s2) : e3 === "auth" ? (this.logClearDiag("auth_error", { category: e3, errStatus: t3?.status }), this.registry.clear(), this.onDisarmed("auth_error")) : (this.logClearDiag("permanent_error", { category: e3, errStatus: t3?.status, errMessage: t3?.message?.slice(0, 200) }), this.registry.clear(), this.onDisarmed("permanent_error"));
      } finally {
        this.inFlight = false, this.abortController = null;
      }
    }
  }
  logClearDiag(t2, e2) {
    try {
      let i2 = this.cacheWrittenAt > 0 ? Date.now() - this.cacheWrittenAt : -1, s2 = this.cacheTtlMs - i2, r2 = Date.now() - this.lastActivityAt, n2 = Date.now() - this.lastRealActivityAt, a2 = { reason: t2, cacheAgeMs: i2, cacheTtlMs: this.cacheTtlMs, ttlRemainingMs: s2, safetyMarginMs: this.safetyMarginMs, idleMs: r2, realIdleMs: n2, regSize: this.registry.size, inFlight: this.inFlight, cacheWrittenAt: this.cacheWrittenAt, lastActivityAt: this.lastActivityAt, lastRealActivityAt: this.lastRealActivityAt, ...e2 }, o2 = Object.entries(a2).map(([t3, e3]) => `${t3}=${e3}`).join(" ");
      it(ct(ht(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] KA_CLEAR_DIAG pid=${process.pid} ${o2}
`);
    } catch {}
  }
  retryChain(t2, e2 = 0) {
    if (e2 >= this.retryDelaysMs.length)
      return this.logClearDiag("retry_exhausted", { attemptIndex: e2, retryDelaysMsLen: this.retryDelaysMs.length }), this.registry.clear(), void this.onDisarmed("retry_exhausted");
    let i2 = Date.now() - this.cacheWrittenAt, s2 = this.cacheTtlMs - i2, r2 = 1000 * this.retryDelaysMs[e2];
    if (s2 < r2 + this.safetyMarginMs) {
      let t3 = i2 < this.cacheTtlMs / 2 ? "retry_budget_exceeds_ttl" : "cache_ttl_exhausted";
      return this.logClearDiag(t3, { cmpLeft: s2, cmpRight: r2 + this.safetyMarginMs, nextDelayMs: r2, attemptIndex: e2, retryDelaysMsRaw: JSON.stringify(this.retryDelaysMs) }), this.registry.clear(), void this.onDisarmed(t3);
    }
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try {
        if (!this.isOwnerAlive())
          return this.logClearDiag("owner_dead", { ownerCheck: "retry" }), this.registry.clear(), this.stop(), void this.onDisarmed("owner_dead");
      } catch {}
      if (this.lastRealActivityAt > this.cacheWrittenAt)
        return;
      let i3 = Date.now() - this.cacheWrittenAt;
      if (i3 > this.cacheTtlMs - this.safetyMarginMs)
        return this.logClearDiag("cache_ttl_expired_mid_retry", { ageNowMs: i3 }), this.registry.clear(), void this.onDisarmed("cache_ttl_expired_mid_retry");
      this.inFlight = true;
      try {
        let e3 = await this.getToken(), i4 = JSON.parse(JSON.stringify(t2.body)), s3 = i4.thinking?.budget_tokens ?? 0;
        i4.max_tokens = s3 > 0 ? s3 + 1 : 1;
        let r3 = { ...t2.headers, Authorization: `Bearer ${e3}` }, n2 = new AbortController;
        this.abortController = n2;
        for await (let t3 of this.doFetch(i4, r3, n2.signal))
          ;
        this.lastActivityAt = Date.now(), this.cacheWrittenAt = Date.now();
      } catch (i4) {
        let s3 = Ct(i4);
        if (s3 === "network") {
          this.inFlight = false, this.abortController = null;
          let t3 = this.cacheTtlMs - (Date.now() - this.cacheWrittenAt) <= this.safetyMarginMs;
          return this.onDisarmed("network_error_mid_retry"), void this.startHealthProbe({ reviveMode: t3 });
        }
        if (s3 === "server_transient")
          return this.inFlight = false, this.abortController = null, void this.retryChain(t2, e2 + 1);
        this.logClearDiag("permanent_error_mid_retry", { category: s3, attemptIndex: e2, errStatus: i4?.status, errMessage: i4?.message?.slice(0, 200) }), this.registry.clear(), this.onDisarmed("permanent_error_mid_retry");
      } finally {
        this.inFlight = false, this.abortController = null;
      }
    }, r2);
  }
  onDisarmed(t2) {
    this.abortController?.abort(), this.abortController = null, this.inFlight = false, this.retryTimer && (clearTimeout(this.retryTimer), this.retryTimer = null);
    try {
      this.config.onDisarmed?.({ reason: t2, at: Date.now() });
    } catch {}
    if (new Set(["retry_exhausted", "cache_ttl_exhausted", "cache_ttl_expired_mid_retry", "retry_budget_exceeds_ttl"]).has(t2) && !this.healthProbeTimer) {
      let t3 = Date.now() - this.cacheWrittenAt, e2 = this.cacheTtlMs - t3 <= this.safetyMarginMs;
      this.startHealthProbe({ reviveMode: e2 });
    }
  }
  startHealthProbe(t2 = {}) {
    if (this.healthProbeTimer)
      return;
    this.healthProbeAttempt = 0;
    let e2 = this.networkState;
    if (this.networkState = "degraded", e2 !== "degraded")
      try {
        this.config.onNetworkStateChange?.({ from: e2, to: "degraded", at: Date.now() });
      } catch {}
    let s2 = i(() => {
      let t3 = this.healthProbeIntervalsMs, e3 = t3[Math.min(this.healthProbeAttempt, t3.length - 1)];
      this.healthProbeTimer = setTimeout(r2, e3), this.healthProbeTimer && typeof this.healthProbeTimer == "object" && "unref" in this.healthProbeTimer && this.healthProbeTimer.unref();
    }, "scheduleNext"), r2 = i(async () => {
      if (this.healthProbeTimer = null, this.healthProbeAttempt++, Date.now() - this.cacheWrittenAt >= this.cacheTtlMs - this.safetyMarginMs && !t2.reviveMode)
        return void this.stopHealthProbe();
      if (this.healthProbeAttempt > this.healthProbeIntervalsMs.length)
        return void this.stopHealthProbe();
      let e3 = false;
      try {
        let { connect: t3 } = await import("net");
        await new Promise((e4, i3) => {
          let s3 = t3({ host: "api.anthropic.com", port: 443 }), r4 = setTimeout(() => {
            s3.destroy(), i3(new Error("timeout"));
          }, this.healthProbeTimeoutMs);
          s3.once("connect", () => {
            clearTimeout(r4), s3.end(), e4();
          }), s3.once("error", (t4) => {
            clearTimeout(r4), i3(t4);
          });
        }), e3 = true;
      } catch {
        e3 = false;
      }
      if (!e3)
        return void s2();
      this.stopHealthProbe();
      let i2 = this.networkState;
      this.networkState = "healthy";
      try {
        this.config.onNetworkStateChange?.({ from: i2, to: "healthy", at: Date.now() });
      } catch {}
      let r3 = this.cacheTtlMs - (Date.now() - this.cacheWrittenAt);
      this.registry.size > 0 && r3 > this.safetyMarginMs && this.tick();
    }, "probe");
    r2();
  }
  stopHealthProbe() {
    this.healthProbeTimer && (clearTimeout(this.healthProbeTimer), this.healthProbeTimer = null), this.healthProbeAttempt = 0;
  }
  writeSnapshotDebug(t2, e2, i2) {
    try {
      let s2 = ct(ht(), ".claude", "snapshots");
      st(s2, { recursive: true });
      try {
        let t3 = Date.now() - _KeepaliveEngine.SNAPSHOT_TTL_MS;
        for (let e3 of rt(s2)) {
          let i3 = ct(s2, e3);
          nt(i3).mtimeMs < t3 && at(i3);
        }
      } catch {}
      this.snapshotCallCount++;
      let { messages: r2, system: n2, tools: a2 } = e2, o2 = typeof n2 == "string" ? n2 : JSON.stringify(n2), l2 = lt("md5").update(o2).digest("hex").slice(0, 8), h2 = { ts: new Date().toISOString(), pid: process.pid, callNum: this.snapshotCallCount, model: t2, messages: r2?.length ?? 0, tools: a2?.length ?? 0, sysHash: l2, sysLen: o2.length, usage: { input: i2.inputTokens ?? 0, cacheRead: i2.cacheReadInputTokens ?? 0, cacheWrite: i2.cacheCreationInputTokens ?? 0 }, firstMsg: r2?.[0] ? { role: r2[0].role, contentLen: JSON.stringify(r2[0].content).length, contentHash: lt("md5").update(JSON.stringify(r2[0].content)).digest("hex").slice(0, 8) } : null, lastMsg: r2?.length ? { role: r2[r2.length - 1].role, contentLen: JSON.stringify(r2[r2.length - 1].content).length } : null, toolsHash: a2?.length ? lt("md5").update(JSON.stringify(a2.map((t3) => t3.name ?? "").join(","))).digest("hex").slice(0, 8) : null }, c2 = `${process.pid}-${Date.now()}.json`;
      if (ot(ct(s2, c2), JSON.stringify(h2, null, 2) + `
`), _KeepaliveEngine.DUMP_BODY || this.snapshotCallCount <= 3) {
        let t3 = ct(s2, "bodies");
        st(t3, { recursive: true });
        let i3 = `${process.pid}-call${this.snapshotCallCount}-${Date.now()}.json`;
        ot(ct(t3, i3), JSON.stringify(e2, null, 2) + `
`);
      }
    } catch {}
  }
  get h() {
    return this.registry;
  }
  get u() {
    return this.timer;
  }
  get p() {
    return this.config;
  }
  get m() {
    return this.lastKnownCacheTokensByModel;
  }
  k(t2) {
    this.lastRealActivityAt = t2;
  }
  _(t2) {
    this.cacheWrittenAt = t2;
  }
  get T() {
    return this.cacheWrittenAt;
  }
  R(t2, e2, i2) {
    this.i = t2, this.o = e2, this.l = i2;
  }
};
function Nt(t2) {
  return !t2 || t2.length < 21 ? "" : t2.slice(13, 21);
}
i(Nt, "tokenHint");
var Jt = class {
  constructor(t2, e2, i2) {
    this.credentialStore = t2, this.contextTokensProvider = e2, this.getConfig = i2, this.startWatcher(), this.startPollFallback();
  }
  static {
    i(this, "TokenRotationManager");
  }
  pendingRotation = null;
  orgIdCache = null;
  watcher = null;
  pollTimer = null;
  closed = false;
  eventEmitter = null;
  lastSeenHint = "";
  contextProviderThrew = false;
  appendCallCount = 0;
  async checkPending() {
    if (await this.detectRotation("ensureAuth"), this.pendingRotation === null)
      return { action: "no-pending" };
    let t2 = null;
    if (this.contextTokensProvider)
      try {
        let e3 = this.contextTokensProvider();
        t2 = typeof e3 == "number" ? e3 : null;
      } catch (e3) {
        t2 = null, this.contextProviderThrew || (this.contextProviderThrew = true, this.logBestEffort(`[${new Date().toISOString()}] TOKEN_PROVIDER_THREW pid=${process.pid} error=${e3.message}`));
      }
    let e2 = this.getConfig().tokenRotationContextThreshold;
    if (t2 === null || t2 < e2) {
      await this.applyPending("context-drop");
      let t3 = await this.credentialStore.read();
      return t3 ? { action: "apply-now", credentials: t3, mode: "applied" } : { action: "no-pending" };
    }
    return { action: "continue-with-old", pending: this.pendingRotation };
  }
  async applyPending(t2, e2) {
    if (t2 === "forced-expired" && e2 === undefined)
      throw new Error("forcedReason required when reason=forced-expired");
    if (this.pendingRotation === null)
      return;
    if (!await this.credentialStore.read())
      return this.logBestEffort(`[${new Date().toISOString()}] TOKEN_APPLY_NO_CREDS pid=${process.pid}`), void (this.pendingRotation = null);
    let { oldHint: i2, newHint: s2, oldOrgId: r2, newOrgId: n2, detectedAt: a2 } = this.pendingRotation;
    this.lastSeenHint = s2, this.pendingRotation = null, this.orgIdCache = null;
    let o2 = t2 === "forced-expired" ? "forced" : "applied", l2 = t2, h2 = null;
    if (this.contextTokensProvider)
      try {
        let t3 = this.contextTokensProvider();
        h2 = typeof t3 == "number" ? t3 : null;
      } catch {
        h2 = null;
      }
    let c2 = { pid: process.pid, spawnDepth: 0, sessionId: null, oldHint: i2, newHint: s2, oldOrgId: r2, newOrgId: n2, contextTokens: h2, mode: o2, appliedAt: l2, forcedReason: e2 ?? null, detectedAt: new Date(a2).toISOString() };
    t2 === "forced-expired" ? this.logBestEffort(`[${new Date().toISOString()}] TOKEN_ROTATION_FORCED pid=${process.pid} forcedReason=${e2} oldHint=${i2} newHint=${s2}`) : this.logBestEffort(`[${new Date().toISOString()}] TOKEN_ROTATION_APPLIED pid=${process.pid} reason=${t2} oldHint=${i2} newHint=${s2} newOrgId=${n2 ?? "null"}`), this.emitEvent(c2);
  }
  hasPending() {
    return this.pendingRotation !== null;
  }
  setEventEmitter(t2) {
    this.eventEmitter = t2;
  }
  close() {
    if (this.closed = true, this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }
    this.pollTimer && (clearInterval(this.pollTimer), this.pollTimer = null);
  }
  startWatcher() {
    let t2 = this.credentialStore.path;
    if (typeof t2 == "string")
      try {
        this.watcher = Lt(t2, { persistent: false }, (t3) => {
          (t3 === "change" || t3 === "rename") && queueMicrotask(() => {
            this.detectRotation("fs.watch").catch(() => {});
          });
        }), this.watcher.on("error", (t3) => {
          this.logBestEffort(`[${new Date().toISOString()}] TOKEN_WATCHER_ERROR pid=${process.pid} error=${t3.message}`);
        });
      } catch (t3) {
        this.logBestEffort(`[${new Date().toISOString()}] TOKEN_WATCHER_INIT_FAILED pid=${process.pid} error=${t3.message}`);
      }
  }
  startPollFallback() {
    let t2 = this.getConfig().tokenRotationPollIntervalMs;
    this.pollTimer = setInterval(() => {
      this.closed || this.detectRotation("poll").catch(() => {});
    }, t2), this.pollTimer.unref();
  }
  async detectRotation(t2) {
    if (this.closed)
      return;
    let e2;
    try {
      e2 = await this.credentialStore.read();
    } catch (e3) {
      return void this.logBestEffort(`[${new Date().toISOString()}] TOKEN_DETECT_READ_FAILED pid=${process.pid} source=${t2} error=${e3.message}`);
    }
    if (!e2)
      return;
    let i2 = Nt(e2.accessToken);
    if (i2 === this.lastSeenHint)
      return;
    if (this.lastSeenHint === "")
      return this.lastSeenHint = i2, void (this.orgIdCache = { orgId: this.extractOrgId(e2.refreshToken), cachedAt: Date.now() });
    if (this.pendingRotation !== null && i2 === this.pendingRotation.newHint)
      return;
    if (this.pendingRotation !== null && i2 === this.pendingRotation.oldHint) {
      let t3 = this.pendingRotation;
      return this.pendingRotation = null, this.lastSeenHint = i2, void this.logBestEffort(`[${new Date().toISOString()}] TOKEN_ROTATION_CANCELLED pid=${process.pid} oldHint=${t3.oldHint} newHint=${t3.newHint} reason=revert`);
    }
    let s2 = this.lastSeenHint, r2 = i2, n2 = await this.getCachedOrgId(), a2 = this.extractOrgId(e2.refreshToken), o2 = null;
    if (this.contextTokensProvider)
      try {
        let t3 = this.contextTokensProvider();
        o2 = typeof t3 == "number" ? t3 : null;
      } catch (t3) {
        o2 = null, this.contextProviderThrew || (this.contextProviderThrew = true, this.logBestEffort(`[${new Date().toISOString()}] TOKEN_PROVIDER_THREW pid=${process.pid} error=${t3.message}`));
      }
    let l2, h2, c2, u2 = this.getConfig().tokenRotationContextThreshold;
    n2 !== null && n2 === a2 ? (l2 = "same-org", h2 = "immediate", c2 = "TOKEN_ROTATION_SAME_ORG", this.lastSeenHint = r2, this.pendingRotation = null, this.orgIdCache = null) : o2 === null || o2 < u2 ? (l2 = "applied", h2 = "immediate", c2 = "TOKEN_ROTATION_APPLIED", this.lastSeenHint = r2, this.pendingRotation = null, this.orgIdCache = null) : (l2 = "deferred", h2 = null, c2 = "TOKEN_ROTATION_DEFERRED", this.pendingRotation = { oldHint: s2, newHint: r2, oldOrgId: n2, newOrgId: a2, detectedAt: Date.now() });
    let d2 = { pid: process.pid, spawnDepth: 0, sessionId: null, oldHint: s2, newHint: r2, oldOrgId: n2, newOrgId: a2, contextTokens: o2, mode: l2, appliedAt: h2, forcedReason: null, detectedAt: new Date().toISOString() };
    this.logBestEffort(`[${new Date().toISOString()}] ${c2} pid=${process.pid} source=${t2} oldHint=${s2} newHint=${r2} oldOrgId=${n2 ?? "null"} newOrgId=${a2 ?? "null"} contextTokens=${o2 ?? "null"}`), this.emitEvent(d2);
  }
  extractOrgId(t2) {
    if (!t2)
      return null;
    try {
      let e2 = t2.split(".");
      if (e2.length !== 3)
        return null;
      let i2 = Buffer.from(e2[1], "base64url").toString("utf8"), s2 = JSON.parse(i2);
      return typeof s2.organization_id == "string" ? s2.organization_id : null;
    } catch {
      return null;
    }
  }
  async getCachedOrgId() {
    let t2, e2 = this.getConfig().orgIdCacheTtlMs, i2 = Date.now();
    if (this.orgIdCache && i2 - this.orgIdCache.cachedAt < e2)
      return this.orgIdCache.orgId;
    try {
      t2 = await this.credentialStore.read();
    } catch {
      return null;
    }
    let s2 = t2 ? this.extractOrgId(t2.refreshToken) : null;
    return this.orgIdCache = { orgId: s2, cachedAt: i2 }, s2;
  }
  appendRotationLog(t2) {
    try {
      let e2 = Wt(Kt(), ".claude", "token-rotation.log");
      Pt(e2, JSON.stringify(t2) + `
`), this.appendCallCount += 1, (this.appendCallCount === 1 || this.appendCallCount % 100 == 0) && this.maybeRotateLog();
    } catch {}
  }
  maybeRotateLog() {
    try {
      let t2 = this.getConfig(), e2 = Wt(Kt(), ".claude", "token-rotation.log");
      if (!Ht(e2) || Ft(e2).size < t2.tokenRotationLogMaxBytes)
        return;
      let i2 = `${e2}.1`, s2 = `${e2}.2`;
      if (Ht(s2)) {
        let e3 = Ft(s2).mtimeMs;
        if (Date.now() - e3 > 86400 * t2.tokenRotationLogRetentionDays * 1000)
          try {
            Ut(s2);
          } catch {}
      }
      if (Ht(i2))
        try {
          Bt(i2, s2);
        } catch {}
      try {
        Bt(e2, i2);
      } catch {}
    } catch {}
  }
  emitEvent(t2) {
    if (this.eventEmitter)
      try {
        this.eventEmitter(t2);
      } catch (t3) {
        this.logBestEffort(`[${new Date().toISOString()}] TOKEN_EMITTER_THREW pid=${process.pid} error=${t3.message}`);
      }
    this.appendRotationLog(t2);
  }
  logBestEffort(t2) {
    try {
      Pt(Wt(Kt(), ".claude", "claude-max-debug.log"), t2 + `
`);
    } catch {}
  }
};
var jt = 300000;
var qt = 0.25;
var zt = 300000;
var Gt = 1200000;
var Qt = J(j(), ".claude", ".refresh-cooldown");
var Yt = 1800000;
var Vt = "2.1.90";
var Xt = { todowrite: "todo_write" };
var Zt = Object.fromEntries(Object.entries(Xt).map(([t2, e2]) => [e2, t2]));
function te(t2) {
  if (!t2?.length)
    return { remapped: t2, didRemap: false };
  let e2 = false;
  return { remapped: t2.map((t3) => {
    let i2 = Xt[t3.name];
    return i2 ? (e2 = true, { ...t3, name: i2 }) : t3;
  }), didRemap: e2 };
}
function ee(t2) {
  return Zt[t2] ?? t2;
}
i(te, "remapToolNames"), i(ee, "unremapToolName");
var ie = J(j(), ".claude", ".token-refresh-lock");
async function se() {
  for (let t2 = 0;t2 < 30; t2++)
    try {
      return H(ie), P(J(ie, "pid"), `${process.pid}
${Date.now()}`), () => {
        try {
          K(J(ie, "pid")), B(ie);
        } catch {}
      };
    } catch (t3) {
      if (t3.code === "EEXIST") {
        try {
          let t4 = L(J(ie, "pid"), "utf8"), e2 = parseInt(t4.split(`
`)[1] ?? "0");
          if (Date.now() - e2 > 30000) {
            try {
              K(J(ie, "pid"));
            } catch {}
            try {
              B(ie);
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
async function re(t2, e2, i2) {
  let s2 = Date.now() + e2;
  for (;Date.now() < s2; ) {
    try {
      let e3 = await t2.read();
      if (e3 && e3.expiresAt - Date.now() >= i2)
        return { accessToken: e3.accessToken, refreshToken: e3.refreshToken, expiresAt: e3.expiresAt };
    } catch {}
    await new Promise((t3) => setTimeout(t3, 500));
  }
  return null;
}
i(se, "acquireTokenRefreshLock"), i(re, "pollDiskForFreshToken");
var ne = class {
  static {
    i(this, "ClaudeCodeSDK");
  }
  accessToken = null;
  refreshToken = null;
  expiresAt = null;
  credentialStore;
  tokenRotation;
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
  keepalive;
  $ = null;
  constructor(t2 = {}) {
    this.sessionId = N(), this.deviceId = t2.deviceId ?? x(32).toString("hex"), this.accountUuid = t2.accountUuid ?? this.readAccountUuid(), this.timeout = t2.timeout ?? 600000, this.maxRetries = t2.maxRetries ?? 10, this.onTokenStatus = t2.onTokenStatus, this.keepalive = new xt({ config: t2.keepalive, getToken: i(async () => (await this.ensureAuth(), this.accessToken ?? ""), "getToken"), doFetch: i((t3, e2, i2) => this.doStreamRequest(t3, e2, i2), "doFetch"), getRateLimitInfo: i(() => this.lastRateLimitInfo, "getRateLimitInfo") }), t2.credentialStore ? this.credentialStore = t2.credentialStore : t2.accessToken ? (this.accessToken = t2.accessToken, this.refreshToken = t2.refreshToken ?? null, this.expiresAt = t2.expiresAt ?? null, this.credentialStore = new oe({ accessToken: t2.accessToken, refreshToken: t2.refreshToken ?? "", expiresAt: t2.expiresAt ?? 0 }), this.expiresAt && this.refreshToken && this.scheduleProactiveRotation()) : (this.credentialStore = new ae(t2.credentialsPath ?? J(j(), ".claude", ".credentials.json")), this.initialLoad = this.loadFromStore().catch(() => {})), this.tokenRotation = new Jt(this.credentialStore, t2.contextTokensProvider, () => Mt());
  }
  close() {
    this.tokenRotation.close();
  }
  async generate(t2) {
    let e2 = [];
    for await (let i2 of this.stream(t2))
      e2.push(i2);
    return this.assembleResponse(e2, t2.model);
  }
  async* stream(t2) {
    this.keepalive.checkRewriteGuard(t2.model), await this.ensureAuth();
    let e2, i2 = this.buildRequestBody(t2), s2 = this.buildHeaders(t2);
    this.keepalive.notifyRealRequestStart(t2.model, i2, s2), this.$ = null;
    for (let r2 = 1;r2 <= this.maxRetries + 1; r2++) {
      if (t2.signal?.aborted)
        throw new q("Aborted");
      try {
        return yield* this.doStreamRequest(i2, s2, t2.signal), void (this.$ && (this.keepalive.notifyRealRequestComplete(this.$), this.$ = null));
      } catch (i3) {
        if (e2 = i3, i3 instanceof G) {
          if (i3.status === 401 && r2 <= this.maxRetries) {
            await this.handleAuth401(), s2.Authorization = `Bearer ${this.accessToken}`;
            continue;
          }
          if (i3.status === 429)
            throw i3 instanceof Q ? i3 : new Q("Rate limited", this.lastRateLimitInfo, 429, i3);
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
    let r2 = new AbortController, n2 = setTimeout(() => r2.abort(), this.timeout);
    i2 && i2.addEventListener("abort", () => r2.abort(), { once: true });
    let a2, o2 = Date.now(), l2 = JSON.stringify(t2);
    if (l2.length > 19922944) {
      let e3 = (l2.length / 1024 / 1024).toFixed(1);
      try {
        let { appendFileSync: t3 } = s("fs");
        t3(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] BODY_TOO_LARGE pid=${process.pid} bodyLen=${l2.length} (${e3}MB) \u2014 refusing to send (would 413)
`);
      } catch {}
      let i3 = t2.messages?.length ?? 0;
      throw new Error(`Request body too large: ${e3}MB exceeds the 19MB safety threshold (API hard limit ~20MB). Got ${i3} messages. Run /compact to summarize history, or start a fresh session. If this is unexpected, the consumer's per-image / total-body management may have a gap.`);
    }
    try {
      let { appendFileSync: i3 } = s("fs");
      i3(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_START pid=${process.pid} model=${t2.model} msgs=${t2.messages?.length ?? 0}
`);
      let r3 = t2.tools?.map((t3) => t3.name).join(",") ?? "none", n3 = typeof t2.system == "string" ? t2.system.substring(0, 200) : JSON.stringify(t2.system)?.substring(0, 200);
      if (i3(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_REQ pid=${process.pid} headers=${JSON.stringify(e2).substring(0, 300)} tools=[${r3.substring(0, 500)}] sys=${n3} bodyLen=${l2.length}
`), process.env.CLAUDE_MAX_DUMP_REQUESTS === "1") {
        let s2 = { ...t2, messages: `[${t2.messages?.length ?? 0} messages]`, system: `[${typeof t2.system == "string" ? t2.system.length : "array"}]` };
        i3(J(j(), ".claude", "claude-max-request-dump.jsonl"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, headers: e2, body: s2 }) + `
`);
      }
    } catch {}
    try {
      a2 = await fetch("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", headers: e2, body: l2, signal: r2.signal });
    } catch (t3) {
      clearTimeout(n2);
      try {
        let { appendFileSync: e3 } = s("fs");
        e3(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_ERROR pid=${process.pid} ttfb=${Date.now() - o2}ms err=${t3.message}
`);
      } catch {}
      throw new q("Network error", t3);
    }
    clearTimeout(n2);
    try {
      let { appendFileSync: t3 } = s("fs"), e3 = {};
      a2.headers.forEach((t4, i4) => {
        e3[i4] = t4;
      });
      let i3 = { ts: new Date().toISOString(), pid: process.pid, status: a2.status, statusText: a2.statusText, ttfbMs: Date.now() - o2, headers: e3 };
      t3(J(j(), ".claude", "claude-max-api-responses.log"), JSON.stringify(i3) + `
`), t3(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_RESPONSE pid=${process.pid} status=${a2.status} ttfb=${Date.now() - o2}ms
`);
    } catch {}
    if (this.lastRateLimitInfo = this.parseRateLimitHeaders(a2.headers), !a2.ok) {
      let t3 = "";
      try {
        t3 = await a2.text();
      } catch {}
      let e3 = a2.headers.get("request-id");
      try {
        let { appendFileSync: i3 } = s("fs"), r3 = {};
        a2.headers.forEach((t4, e4) => {
          r3[e4] = t4;
        }), i3(J(j(), ".claude", "claude-max-api-responses.log"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, type: "ERROR", status: a2.status, requestId: e3, headers: r3, body: t3.slice(0, 5000), rateLimitInfo: this.lastRateLimitInfo }) + `
`);
      } catch {}
      throw a2.status === 429 ? new Q(`Rate limited: ${t3}`, this.lastRateLimitInfo, 429) : new G(`API error ${a2.status}: ${t3}`, a2.status, e3);
    }
    if (!a2.body)
      throw new q("No response body");
    yield* this.parseSSE(a2.body, i2);
  }
  async* parseSSE(t2, e2) {
    let i2 = new TextDecoder, r2 = t2.getReader(), n2 = "", a2 = new Map, o2 = { inputTokens: 0, outputTokens: 0 }, l2 = null;
    try {
      for (;; ) {
        if (e2?.aborted)
          return void r2.cancel();
        let { done: t3, value: h2 } = await r2.read();
        if (t3)
          break;
        n2 += i2.decode(h2, { stream: true });
        let c2 = n2.split(`
`);
        n2 = c2.pop() ?? "";
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
                W(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] RAW_USAGE: ${JSON.stringify(t5)}
`);
              } catch {}
            }
            continue;
          }
          if (r3 === "content_block_start") {
            let { index: t5, content_block: i4 } = e3;
            if (i4.type === "tool_use") {
              let e4 = ee(i4.name);
              a2.set(t5, { type: "tool_use", id: i4.id, name: e4, input: "" }), yield { type: "tool_use_start", id: i4.id, name: e4 };
            } else
              i4.type === "text" ? a2.set(t5, { type: "text", text: "" }) : i4.type === "thinking" && a2.set(t5, { type: "thinking", thinking: "", signature: i4.signature ?? undefined });
            continue;
          }
          if (r3 === "content_block_delta") {
            let t5 = e3.index, i4 = a2.get(t5), s2 = e3.delta;
            s2.type === "text_delta" && s2.text !== undefined ? (i4 && (i4.text = (i4.text ?? "") + s2.text), s2.text && (yield { type: "text_delta", text: s2.text })) : s2.type === "thinking_delta" && s2.thinking !== undefined ? (i4 && (i4.thinking = (i4.thinking ?? "") + s2.thinking), s2.thinking && (yield { type: "thinking_delta", text: s2.thinking })) : s2.type === "signature_delta" && s2.signature !== undefined ? i4 && (i4.signature = (i4.signature ?? "") + s2.signature) : s2.type === "input_json_delta" && s2.partial_json !== undefined && (i4 && (i4.input = (i4.input ?? "") + s2.partial_json), s2.partial_json && (yield { type: "tool_use_delta", partialInput: s2.partial_json }));
            continue;
          }
          if (r3 === "content_block_stop") {
            let t5 = e3.index, i4 = a2.get(t5);
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
          r3 === "message_stop" && (this.$ = o2, yield { type: "message_stop", usage: o2, stopReason: l2 });
        }
      }
    } finally {
      r2.releaseLock();
    }
  }
  stopKeepalive() {
    this.keepalive.stop(), this.tokenRotationTimer && (clearTimeout(this.tokenRotationTimer), this.tokenRotationTimer = null);
  }
  buildHeaders(t2) {
    let e2 = this.buildBetas(t2);
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}`, "anthropic-version": "2023-06-01", "anthropic-beta": e2.join(","), "anthropic-dangerous-direct-browser-access": "true", "x-app": "cli", "User-Agent": `claude-cli/${Vt}`, "X-Claude-Code-Session-Id": this.sessionId };
  }
  buildRequestBody(t2) {
    let e2, i2 = this.computeFingerprint(t2.messages), s2 = `x-anthropic-billing-header: cc_version=${Vt}.${i2}; cc_entrypoint=cli; cch=00000;`;
    e2 = (typeof t2.system == "string" ? t2.system : Array.isArray(t2.system) ? JSON.stringify(t2.system) : "").includes("x-anthropic-billing-header") ? t2.system : typeof t2.system == "string" ? s2 + `
` + t2.system : Array.isArray(t2.system) ? [{ type: "text", text: s2 }, ...t2.system] : s2;
    let r2 = { model: t2.model, messages: t2.messages, max_tokens: Z(t2.model, t2.maxTokens), stream: true, system: e2, metadata: { user_id: JSON.stringify({ device_id: this.deviceId, account_uuid: this.accountUuid, session_id: this.sessionId }) } };
    if (t2.tools && t2.tools.length > 0) {
      let { remapped: e3 } = te(t2.tools);
      if (r2.tools = e3, t2.toolChoice) {
        let e4 = typeof t2.toolChoice == "string" ? { type: t2.toolChoice } : { ...t2.toolChoice };
        e4.type === "tool" && e4.name && Xt[e4.name] && (e4.name = Xt[e4.name]), r2.tool_choice = e4;
      }
    }
    t2.caching !== false && this.addCacheMarkers(r2);
    let n2 = t2.model.toLowerCase(), a2 = n2.includes("opus-4-6") || n2.includes("sonnet-4-6") || n2.includes("opus-4-7") || n2.includes("sonnet-4-7"), o2 = t2.thinking?.type === "disabled";
    return !o2 && a2 ? r2.thinking = { type: "adaptive" } : t2.thinking?.type === "enabled" && (r2.thinking = { type: "enabled", budget_tokens: t2.thinking.budgetTokens }), !(!o2 && (a2 || t2.thinking?.type === "enabled")) && t2.temperature !== undefined && (r2.temperature = t2.temperature), t2.topP !== undefined && (r2.top_p = t2.topP), t2.effort && a2 && (r2.output_config = { effort: t2.effort }), t2.stopSequences?.length && (r2.stop_sequences = t2.stopSequences), t2.fast && (r2.speed = "fast"), r2;
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
    let n2 = r2[r2.length - 1];
    if (typeof n2.content == "string")
      n2.content = [{ type: "text", text: n2.content, ...e2 }];
    else if (Array.isArray(n2.content) && n2.content.length > 0) {
      let t3 = n2.content[n2.content.length - 1];
      n2.content[n2.content.length - 1] = { ...t3, ...e2 };
    }
  }
  buildBetas(t2) {
    let e2 = [], i2 = t2.model.toLowerCase().includes("haiku");
    return i2 || e2.push("claude-code-20250219"), e2.push("oauth-2025-04-20"), /\[1m\]/i.test(t2.model) && e2.push("context-1m-2025-08-07"), !i2 && t2.thinking?.type !== "disabled" && e2.push("interleaved-thinking-2025-05-14"), t2.effort && e2.push("effort-2025-11-24"), t2.fast && e2.push("fast-mode-2026-02-01"), i2 || e2.push("context-management-2025-06-27"), e2.push("task-budgets-2026-03-13"), e2.push("redact-thinking-2026-02-12"), e2.push("prompt-caching-scope-2026-01-05"), e2.push("fine-grained-tool-streaming-2025-05-14"), t2.extraBetas && e2.push(...t2.extraBetas), e2;
  }
  async ensureAuth() {
    if ((await this.tokenRotation.checkPending()).action === "apply-now" && (this.accessToken = null, this.refreshToken = null, this.expiresAt = 0), this.accessToken && this.credentialStore.hasChanged)
      try {
        if (await this.credentialStore.hasChanged()) {
          try {
            let t2 = Nt(this.accessToken);
            W(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_FILE_CHANGED pid=${process.pid} oldHint=${t2} reason=mtime_diff_in_fast_path action=invalidate_in_memory_token
`);
          } catch {}
          this.accessToken = null, this.refreshToken = null, this.expiresAt = 0;
        }
      } catch (t2) {
        try {
          W(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_MTIME_CHECK_FAILED pid=${process.pid} error=${t2?.message ?? String(t2)}
`);
        } catch {}
      }
    if (!this.accessToken || this.isTokenExpired())
      return this.pendingAuth || (this.pendingAuth = this.v().finally(() => {
        this.pendingAuth = null;
      })), this.pendingAuth;
  }
  async v() {
    this.credentialStore.hasChanged && await this.credentialStore.hasChanged() && await this.loadFromStore(), (!this.accessToken || this.isTokenExpired()) && (!this.accessToken && (await this.loadFromStore(), this.accessToken && !this.isTokenExpired()) || (this.tokenRotation.hasPending() && this.isTokenExpired() && await this.tokenRotation.applyPending("forced-expired", "old-token-expired"), this.accessToken && this.isTokenExpired() && await this.refreshTokenWithTripleCheck()));
  }
  async loadFromStore() {
    let t2 = this.accessToken, e2 = await this.credentialStore.read();
    if (!e2?.accessToken)
      throw new z('No OAuth tokens found. Run "claude login" first or provide credentials.');
    this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken, this.expiresAt = e2.expiresAt, !this.tokenIssuedAt && this.expiresAt && (this.tokenIssuedAt = Date.now()), this.scheduleProactiveRotation();
    try {
      let i2 = Nt(e2.accessToken);
      if (t2)
        if (t2 !== e2.accessToken) {
          let e3 = Nt(t2);
          W(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_LOADED pid=${process.pid} reason=rotation oldHint=${e3} newHint=${i2} expiresInSec=${Math.round((this.expiresAt - Date.now()) / 1000)}
`);
        } else
          W(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_LOADED pid=${process.pid} reason=reload hint=${i2}
`);
      else
        W(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_LOADED pid=${process.pid} reason=initial newHint=${i2} expiresInSec=${Math.round((this.expiresAt - Date.now()) / 1000)}
`);
    } catch {}
  }
  isTokenExpired() {
    return !!this.expiresAt && Date.now() + jt >= this.expiresAt;
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
      let { oauthLogin: t2 } = await Promise.resolve().then(() => (I(), r)), e2 = this.credentialStore instanceof ae ? this.credentialStore.path : J(j(), ".claude", ".credentials.json"), i2 = await t2({ credentialsPath: e2 });
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
    return t2 = i2 <= 0 ? "expired" : r2 < 0.1 ? "critical" : r2 < qt ? "warning" : "healthy", { expiresAt: this.expiresAt, expiresInMs: i2, lifetimePct: r2, failedRefreshes: this.proactiveRefreshFailures, status: t2 };
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
    let i2 = Math.max(0.8 * e2, zt), s2 = Math.floor(60000 * Math.random()), r2 = Math.min(i2 + s2, e2 - jt);
    if (r2 <= 0)
      return this.dbg(`proactive rotation: delay=${r2}ms <= 0, scheduling emergency refresh in 30s`), void (this.tokenRotationTimer || (this.tokenRotationTimer = setTimeout(() => {
        this.tokenRotationTimer = null, this.proactiveRefresh();
      }, 30000), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && ("unref" in this.tokenRotationTimer) && this.tokenRotationTimer.unref()));
    let n2 = this.tokenIssuedAt > 0 ? this.expiresAt - this.tokenIssuedAt : 2 * e2, a2 = n2 > 0 ? e2 / n2 : 1;
    a2 < 0.1 && this.proactiveRefreshFailures > 0 ? (this.dbg(`\u26A0\uFE0F CRITICAL: token ${Math.round(100 * a2)}% life left, ${this.proactiveRefreshFailures} failed refreshes`), this.emitTokenStatus("critical", `Token ${Math.round(100 * a2)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)) : a2 < qt && this.proactiveRefreshFailures > 0 && (this.dbg(`\u26A0 WARNING: token ${Math.round(100 * a2)}% life left, ${this.proactiveRefreshFailures} failed refreshes`), this.emitTokenStatus("warning", `Token ${Math.round(100 * a2)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)), this.dbg(`proactive rotation scheduled in ${Math.round(r2 / 1000)}s (expires in ${Math.round(e2 / 1000)}s, ${Math.round(100 * a2)}% life, failures=${this.proactiveRefreshFailures})`), this.tokenRotationTimer = setTimeout(() => {
      this.tokenRotationTimer = null, this.proactiveRefresh();
    }, r2), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && "unref" in this.tokenRotationTimer && this.tokenRotationTimer.unref();
  }
  async proactiveRefresh() {
    if (this.isRefreshOnCooldown()) {
      try {
        let t3 = await this.credentialStore.read();
        if (t3 && !(Date.now() + jt >= t3.expiresAt)) {
          let e3 = t3.expiresAt - Date.now();
          if (e3 >= Gt)
            return this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.dbg(`proactive refresh: picked up fresh token during cooldown (${Math.round(e3 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(e3 / 60000)}min remaining)`), void this.scheduleProactiveRotation();
          this.dbg(`proactive refresh: disk token has only ${Math.round(e3 / 60000)}min left (need ${Math.round(20)}min) \u2014 waiting for cooldown`);
        }
      } catch {}
      if (this.dbg("proactive refresh skipped: global cooldown active, no fresh token found"), !this.tokenRotationTimer) {
        let t3 = Math.max(zt, 60000);
        this.tokenRotationTimer = setTimeout(() => {
          this.tokenRotationTimer = null, this.proactiveRefresh();
        }, t3), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && "unref" in this.tokenRotationTimer && this.tokenRotationTimer.unref();
      }
      return;
    }
    let t2 = Date.now();
    if (t2 - this.lastRefreshAttemptAt < zt)
      return void this.dbg("proactive refresh skipped: too recent");
    this.lastRefreshAttemptAt = t2, this.dbg("proactive rotation: refreshing token silently...");
    let e2 = await se();
    if (!e2) {
      this.dbg("proactive rotation: lock unavailable (another PID refreshing) \u2014 polling disk");
      let t3 = await re(this.credentialStore, 45000, Gt);
      if (t3) {
        this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0;
        let e3 = t3.expiresAt - Date.now();
        this.dbg(`proactive rotation: picked up fresh token from disk (${Math.round(e3 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(e3 / 60000)}min remaining)`);
      } else
        this.dbg("proactive rotation: lock unavailable and no fresh token appeared \u2014 will retry on next schedule");
      return void this.scheduleProactiveRotation();
    }
    try {
      let t3 = await this.credentialStore.read();
      if (t3 && !(Date.now() + jt >= t3.expiresAt)) {
        let e4 = t3.expiresAt - Date.now();
        if (e4 >= Gt)
          return this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.dbg(`proactive rotation: picked up fresh token from lock winner (${Math.round(e4 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(e4 / 60000)}min remaining)`), void this.scheduleProactiveRotation();
      }
      let e3 = this.expiresAt ?? 0;
      await this.doTokenRefresh(true), this.proactiveRefreshFailures = 0, this.refreshConsecutive429s = 0, this.clearRefreshCooldown(), this.tokenIssuedAt = Date.now();
      let i2 = (this.expiresAt ?? 0) - Date.now(), s2 = e3 > 0 ? e3 - (this.tokenIssuedAt - 1000) : 2 * i2;
      i2 > 0 && i2 < 0.5 * s2 && this.dbg(`\u26A0\uFE0F SHRINKING TOKEN: new ${Math.round(i2 / 60000)}min vs prev ${Math.round(s2 / 60000)}min \u2014 backing off rotation`), this.dbg(`proactive rotation SUCCESS \u2014 new token expires at ${new Date(this.expiresAt).toISOString()} (${Math.round(i2 / 60000)}min lifetime)`), this.emitTokenStatus("rotated", `Token rotated silently \u2014 expires ${new Date(this.expiresAt).toISOString()}`), this.scheduleProactiveRotation();
    } catch (t3) {
      this.proactiveRefreshFailures++;
      let e3 = t3?.message ?? String(t3);
      if (this.dbg(`proactive rotation FAILED (#${this.proactiveRefreshFailures}): ${e3}`), e3.includes("429") || e3.includes("rate limit")) {
        this.refreshConsecutive429s++;
        let t4 = Math.min(zt * Math.pow(2, this.refreshConsecutive429s), Yt);
        this.setRefreshCooldown(t4), this.dbg(`proactive rotation: 429 cooldown ${Math.round(t4 / 1000)}s (attempt #${this.refreshConsecutive429s})`);
      }
      let i2 = this.expiresAt ? this.expiresAt - Date.now() : 0, s2 = this.tokenIssuedAt > 0 && this.expiresAt ? this.expiresAt - this.tokenIssuedAt : 2 * i2, r2 = s2 > 0 ? i2 / s2 : 0;
      i2 <= jt ? this.emitTokenStatus("expired", `Token expired after ${this.proactiveRefreshFailures} failed refresh attempts: ${e3}`) : r2 < 0.1 ? this.emitTokenStatus("critical", `CRITICAL: ${Math.round(i2 / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${e3}. Consider forceReLogin()`) : r2 < qt && this.emitTokenStatus("warning", `WARNING: ${Math.round(i2 / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${e3}`), this.expiresAt && this.expiresAt > Date.now() + jt ? this.scheduleProactiveRotation() : (this.dbg("proactive rotation: token nearly expired \u2014 emitting expired status"), this.emitTokenStatus("expired", `Token expired \u2014 refresh failed ${this.proactiveRefreshFailures} times. Call forceReLogin() to recover.`));
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
      let t2 = L(Qt, "utf8"), e2 = parseInt(t2.trim());
      if (Date.now() < e2)
        return true;
      try {
        K(Qt);
      } catch {}
    } catch {}
    return false;
  }
  setRefreshCooldown(t2) {
    try {
      let e2 = J(j(), ".claude");
      try {
        H(e2, { recursive: true });
      } catch {}
      P(Qt, `${Date.now() + t2}
`);
    } catch {}
  }
  clearRefreshCooldown() {
    try {
      K(Qt);
    } catch {}
    this.refreshConsecutive429s = 0;
  }
  dbg(t2) {
    try {
      W(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_ROTATION pid=${process.pid} ${t2}
`);
    } catch {}
  }
  async refreshTokenWithTripleCheck() {
    let t2 = await this.credentialStore.read();
    if (t2 && !(Date.now() + jt >= t2.expiresAt))
      return this.accessToken = t2.accessToken, this.refreshToken = t2.refreshToken, void (this.expiresAt = t2.expiresAt);
    let e2 = await se();
    if (!e2) {
      this.dbg("refresh: lock unavailable (another PID refreshing) \u2014 polling disk");
      let t3 = await re(this.credentialStore, 45000, jt);
      return t3 ? (this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, void this.dbg(`refresh: picked up fresh token from disk (${Math.round((t3.expiresAt - Date.now()) / 60000)}min remaining)`)) : (this.dbg("refresh: no fresh token from disk after 45s wait \u2014 attempting unlocked refresh as last resort"), void await this.doTokenRefresh());
    }
    try {
      let t3 = await this.credentialStore.read();
      if (t3 && !(Date.now() + jt >= t3.expiresAt))
        return this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, void (this.expiresAt = t3.expiresAt);
      await this.doTokenRefresh();
    } finally {
      e2();
    }
  }
  async handleAuth401() {
    let t2 = this.accessToken;
    this.pending401 && this.lastFailedToken === t2 || (this.lastFailedToken = t2, this.pending401 = (async () => {
      let e2 = await this.credentialStore.read();
      if (e2 && e2.accessToken !== t2)
        return this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken, this.expiresAt = e2.expiresAt, true;
      let i2 = await se();
      if (!i2) {
        this.dbg("handleAuth401: lock unavailable \u2014 polling disk for fresh token");
        let e3 = await re(this.credentialStore, 45000, jt);
        return e3 && e3.accessToken !== t2 ? (this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, this.dbg(`handleAuth401: picked up fresh token from disk (${Math.round((e3.expiresAt - Date.now()) / 60000)}min remaining)`), true) : (this.dbg("handleAuth401: no fresh token from disk after 45s wait \u2014 attempting unlocked refresh"), await this.doTokenRefresh(), true);
      }
      try {
        let e3 = await this.credentialStore.read();
        if (e3 && e3.accessToken !== t2 && !(Date.now() + jt >= e3.expiresAt))
          return this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, true;
        await this.doTokenRefresh();
      } finally {
        i2();
      }
      return true;
    })().finally(() => {
      this.pending401 = null, this.lastFailedToken = null;
    })), await this.pending401;
  }
  async doTokenRefresh(t2 = false) {
    if (!this.refreshToken)
      throw new z("Token expired and no refresh token available.");
    if (this.isRefreshOnCooldown() && !t2) {
      let t3 = await this.credentialStore.read();
      if (t3 && !(Date.now() + jt >= t3.expiresAt))
        return this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, void this.dbg("refresh skipped (cooldown) \u2014 another process already refreshed");
      if (this.expiresAt && this.expiresAt > Date.now() + 600000)
        throw new z("Token refresh on cooldown due to rate limiting. Will retry later.");
      this.dbg("refresh: ignoring cooldown \u2014 token critically close to expiry");
    }
    let e2 = [500, 1500, 3000, 5000, 8000], i2 = this.credentialStore.path ?? J(j(), ".claude", ".credentials.json");
    try {
      let e3 = U(i2).mtimeMs, s3 = Date.now() - e3;
      if (s3 < 60000) {
        let e4 = await this.credentialStore.read();
        if (e4 && !(Date.now() + jt >= e4.expiresAt)) {
          let i3 = e4.expiresAt - Date.now(), r2 = e4.accessToken !== this.accessToken;
          if (!t2 || r2 && i3 >= Gt)
            return this.accessToken = e4.accessToken, this.refreshToken = e4.refreshToken, this.expiresAt = e4.expiresAt, this.tokenIssuedAt = Date.now(), this.dbg(`refresh: skipped (mtime fresh ${Math.round(s3 / 1000)}s ago, ${Math.round(i3 / 60000)}min remaining) \u2014 picked up sibling/CLI write`), void this.scheduleProactiveRotation();
        }
      }
    } catch {}
    for (let i3 = 0;i3 < 5; i3++) {
      let s3 = await this.credentialStore.read();
      if (s3 && !(Date.now() + jt >= s3.expiresAt)) {
        if (!t2)
          return this.accessToken = s3.accessToken, this.refreshToken = s3.refreshToken, this.expiresAt = s3.expiresAt, void this.dbg(`refresh: another process already refreshed (attempt ${i3})`);
        let e3 = s3.expiresAt - Date.now();
        if (s3.accessToken !== this.accessToken && e3 >= Gt)
          return this.accessToken = s3.accessToken, this.refreshToken = s3.refreshToken, this.expiresAt = s3.expiresAt, void this.dbg(`refresh: another process got fresh token (${Math.round(e3 / 60000)}min remaining) (attempt ${i3})`);
        s3.accessToken !== this.accessToken ? (this.accessToken = s3.accessToken, this.refreshToken = s3.refreshToken, this.expiresAt = s3.expiresAt, this.dbg(`refresh: force=true, disk token different but only ${Math.round(e3 / 60000)}min left \u2014 proceeding to actual refresh (attempt ${i3})`)) : this.dbg(`refresh: force=true, token still same, proceeding to actual refresh (attempt ${i3})`);
      }
      let r2 = await fetch("https://platform.claude.com/v1/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: this.refreshToken, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }), signal: AbortSignal.timeout(15000) });
      if (r2.ok) {
        let t3 = await r2.json();
        this.accessToken = t3.access_token, this.refreshToken = t3.refresh_token ?? this.refreshToken, this.expiresAt = Date.now() + 1000 * t3.expires_in, this.tokenIssuedAt = Date.now();
        let e3 = await this.credentialStore.read(), i4 = e3?.scopes?.length ? e3.scopes : ["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"];
        return await this.credentialStore.write({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt, scopes: i4 }), this.dbg(`token refreshed OK \u2014 expires in ${Math.round(t3.expires_in / 60)}min at ${new Date(this.expiresAt).toISOString()}`), void this.scheduleProactiveRotation();
      }
      if (r2.status === 429) {
        let t3 = Math.min(60000, Yt);
        throw this.setRefreshCooldown(t3), this.dbg(`TOKEN_REFRESH_RETRY status=429 attempt=${i3 + 1}/5 \u2014 bailing out, cooldown ${t3}ms (per-token rate limit)`), new z("Token refresh rate-limited (429) \u2014 will pickup from disk or retry after cooldown");
      }
      if (r2.status >= 500 && i3 < 4) {
        let t3 = e2[i3] ?? 8000, s4 = Math.random() * t3 * 0.5;
        this.dbg(`TOKEN_REFRESH_RETRY status=${r2.status} attempt=${i3 + 1}/5 delay=${Math.round(t3 + s4)}ms`), await new Promise((e3) => setTimeout(e3, t3 + s4));
        continue;
      }
      throw new z(`Token refresh failed: ${r2.status} ${r2.statusText}`);
    }
    let s2 = await this.credentialStore.read();
    if (!s2 || Date.now() + jt >= s2.expiresAt)
      throw new z("Token refresh failed after all retries and race recovery");
    this.accessToken = s2.accessToken, this.refreshToken = s2.refreshToken, this.expiresAt = s2.expiresAt;
    try {
      W(J(j(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_REFRESH_RACE_RECOVERY pid=${process.pid}
`);
    } catch {}
  }
  assembleResponse(t2, e2) {
    let i2, s2 = [], r2 = [], n2 = [], a2 = { inputTokens: 0, outputTokens: 0 }, o2 = null, l2 = "", h2 = "";
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
          n2.push({ type: "tool_use", id: e3.id, name: e3.name, input: e3.input });
          break;
        case "message_stop":
          a2 = e3.usage, o2 = e3.stopReason;
          break;
        case "error":
          throw e3.error;
      }
    return l2 && s2.push({ type: "text", text: l2 }), h2 && r2.push({ type: "thinking", thinking: h2, signature: i2 }), s2.push(...n2), { content: s2, thinking: r2.length > 0 ? r2 : undefined, toolCalls: n2.length > 0 ? n2 : undefined, usage: a2, stopReason: o2, rateLimitInfo: this.lastRateLimitInfo, model: e2 };
  }
  parseRateLimitHeaders(t2) {
    let e2 = {};
    if (t2.forEach((t3, i3) => {
      (i3.includes("ratelimit") || i3.includes("anthropic") || i3.includes("retry") || i3.includes("x-")) && (e2[i3] = t3);
    }), Object.keys(e2).length > 0)
      try {
        let { appendFileSync: t3 } = s("fs"), { join: i3 } = s("path"), { homedir: r3 } = s("os");
        t3(i3(r3(), ".claude", "claude-max-headers.log"), `[${new Date().toISOString()}] ${JSON.stringify(e2)}
`);
      } catch {}
    let i2 = t2.get("retry-after"), r2 = t2.get("anthropic-ratelimit-unified-reset"), n2 = r2 ? Number(r2) : null, a2 = t2.get("anthropic-ratelimit-unified-5h-utilization"), o2 = t2.get("anthropic-ratelimit-unified-7d-utilization");
    return { status: t2.get("anthropic-ratelimit-unified-status"), resetAt: Number.isFinite(n2) ? n2 : null, claim: t2.get("anthropic-ratelimit-unified-representative-claim"), retryAfter: i2 ? parseFloat(i2) : null, utilization5h: a2 ? parseFloat(a2) : null, utilization7d: o2 ? parseFloat(o2) : null };
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
        return void s2(new q("Aborted"));
      let r2 = setTimeout(i2, t2);
      e2?.addEventListener("abort", () => {
        clearTimeout(r2), s2(new q("Aborted"));
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
    let i2 = `59cf53e54c78${[4, 7, 20].map((t3) => e2[t3] || "0").join("")}${Vt}`;
    return C("sha256").update(i2).digest("hex").slice(0, 3);
  }
  readAccountUuid() {
    try {
      let t2 = J(j(), ".claude", "claude_code_config.json");
      return JSON.parse(L(t2, "utf8")).oauthAccount?.accountUuid ?? "";
    } catch {
      return "";
    }
  }
};
var ae = class {
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
    let i2 = J(this.path, "..");
    try {
      H(i2, { recursive: true });
    } catch {}
    P(this.path, JSON.stringify(e2, null, 2), "utf8"), F(this.path, 384), this.lastMtimeMs = this.getMtime();
  }
  async hasChanged() {
    let t2 = this.getMtime();
    return t2 !== this.lastMtimeMs && (this.lastMtimeMs = t2, true);
  }
  getMtime() {
    try {
      return U(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }
};
var oe = class {
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
var le = class _Conversation {
  static {
    i(this, "Conversation");
  }
  sdk;
  options;
  S = [];
  M = { inputTokens: 0, outputTokens: 0 };
  constructor(t2, e2) {
    this.sdk = t2, this.options = e2;
  }
  get messages() {
    return this.S;
  }
  get totalUsage() {
    return { ...this.M };
  }
  get length() {
    return this.S.length;
  }
  async send(t2, e2) {
    this.appendUserMessage(t2);
    let i2 = this.buildGenerateOptions(e2), s2 = await this.sdk.generate(i2);
    return this.appendAssistantFromResponse(s2), this.accumulateUsage(s2.usage), s2;
  }
  async* stream(t2, e2) {
    this.appendUserMessage(t2);
    let i2 = this.buildGenerateOptions(e2), s2 = [], r2 = [], n2 = [], a2 = { inputTokens: 0, outputTokens: 0 };
    for await (let t3 of this.sdk.stream(i2))
      switch (yield t3, t3.type) {
        case "text_delta":
          s2.push(t3.text);
          break;
        case "thinking_delta":
          r2.push(t3.text);
          break;
        case "tool_use_end":
          n2.push({ type: "tool_use", id: t3.id, name: t3.name, input: t3.input });
          break;
        case "message_stop":
          a2 = t3.usage;
      }
    let o2 = [];
    s2.length > 0 && o2.push({ type: "text", text: s2.join("") });
    for (let t3 of n2)
      o2.push({ type: "tool_use", id: t3.id, name: t3.name, input: t3.input });
    o2.length > 0 && this.S.push({ role: "assistant", content: o2 }), this.accumulateUsage(a2);
  }
  addToolResult(t2, e2, i2) {
    let s2 = { type: "tool_result", tool_use_id: t2, content: e2, ...i2 && { is_error: true } };
    this.S.push({ role: "user", content: [s2] });
  }
  addToolResults(t2) {
    let e2 = t2.map((t3) => ({ type: "tool_result", tool_use_id: t3.toolUseId, content: t3.content, ...t3.isError && { is_error: true } }));
    this.S.push({ role: "user", content: e2 });
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
    let n2 = [];
    i2.length > 0 && n2.push({ type: "text", text: i2.join("") });
    for (let t3 of s2)
      n2.push({ type: "tool_use", id: t3.id, name: t3.name, input: t3.input });
    n2.length > 0 && this.S.push({ role: "assistant", content: n2 }), this.accumulateUsage(r2);
  }
  rewind(t2) {
    if (t2 < 0 || t2 >= this.S.length)
      throw new Error(`Invalid rewind index: ${t2}`);
    return this.S.splice(t2);
  }
  undoLastTurn() {
    for (let t2 = this.S.length - 1;t2 >= 0; t2--) {
      let e2 = this.S[t2];
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
    return t2.S = [...this.S], t2.M = { ...this.M }, t2;
  }
  getHistory() {
    return this.S.map((t2, e2) => {
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
    this.S.push({ role: "user", content: t2 });
  }
  appendAssistantFromResponse(t2) {
    let e2 = [];
    for (let i2 of t2.content)
      i2.type === "text" ? e2.push({ type: "text", text: i2.text }) : i2.type === "tool_use" && e2.push({ type: "tool_use", id: i2.id, name: i2.name, input: i2.input });
    e2.length > 0 && this.S.push({ role: "assistant", content: e2 });
  }
  buildGenerateOptions(t2) {
    return { model: this.options.model, messages: [...this.S], system: this.options.system, tools: t2?.tools ?? this.options.tools, toolChoice: t2?.toolChoice ?? this.options.toolChoice, maxTokens: this.options.maxTokens, thinking: this.options.thinking, effort: this.options.effort, fast: this.options.fast, signal: t2?.signal ?? this.options.signal, extraBetas: this.options.extraBetas, caching: this.options.caching };
  }
  accumulateUsage(t2) {
    this.M.inputTokens += t2.inputTokens, this.M.outputTokens += t2.outputTokens, this.M.cacheCreationInputTokens = (this.M.cacheCreationInputTokens ?? 0) + (t2.cacheCreationInputTokens ?? 0), this.M.cacheReadInputTokens = (this.M.cacheReadInputTokens ?? 0) + (t2.cacheReadInputTokens ?? 0);
  }
};
function fe(t2, e2) {
  ue(de(t2), { recursive: true });
  let i2 = null, s2 = [];
  for (let t3 of e2) {
    let e3 = pe(), r2 = { type: t3.role === "user" ? "user" : "assistant", uuid: e3, parentUuid: i2, timestamp: Date.now(), content: t3.content };
    s2.push(JSON.stringify(r2)), i2 = e3;
  }
  ce(t2, s2.join(`
`) + `
`, "utf8");
}
function me(t2) {
  let e2 = he(t2, "utf8"), i2 = [];
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
i(fe, "saveSession"), i(me, "loadSession");
var ge = class {
  static {
    i(this, "CacheMetricsCollector");
  }
  samples = [];
  timer = null;
  previousHitRate = 1;
  previousSampleCount = 0;
  windowMs;
  reportIntervalMs;
  regressionThreshold;
  regressionPreviousFloor;
  regressionMinSamples;
  onSummary;
  onRegression;
  constructor(t2 = {}) {
    this.windowMs = t2.windowMs ?? 60000, this.reportIntervalMs = t2.reportIntervalMs ?? this.windowMs, this.regressionThreshold = t2.regressionThreshold ?? 0.7, this.regressionPreviousFloor = t2.regressionPreviousFloor ?? 0.85, this.regressionMinSamples = t2.regressionMinSamples ?? 50, this.onSummary = t2.onSummary, this.onRegression = t2.onRegression, this.reportIntervalMs > 0 && (this.timer = setInterval(() => this.report(), this.reportIntervalMs), typeof this.timer == "object" && ("unref" in this.timer) && this.timer.unref());
  }
  recordRequest(t2) {
    this.samples.push({ ts: Date.now(), ...t2 });
  }
  summary() {
    this.prune();
    let t2 = this.samples.length, e2 = this.samples.filter((t3) => t3.cacheRead > 0).length, i2 = this.samples.filter((t3) => t3.firstCall && t3.cacheRead === 0).length, s2 = this.samples.filter((t3) => t3.kind === "real").length, r2 = this.samples.filter((t3) => t3.kind === "ka").length, n2 = this.samples.reduce((t3, e3) => t3 + e3.cacheRead, 0), a2 = this.samples.reduce((t3, e3) => t3 + e3.cacheWrite, 0), o2 = this.samples.reduce((t3, e3) => t3 + e3.input, 0), l2 = this.samples.reduce((t3, e3) => Math.max(t3, e3.cacheRead), 0), h2 = new Set(this.samples.map((t3) => t3.sysHash).filter(Boolean)).size, c2 = Math.round(0.9 * n2);
    return { windowMs: this.windowMs, windowEndsAt: new Date().toISOString(), total: t2, hitRate: t2 > 0 ? e2 / t2 : 0, coldStartCount: i2, realCount: s2, kaCount: r2, avgCacheRead: t2 > 0 ? n2 / t2 : 0, avgCacheWrite: t2 > 0 ? a2 / t2 : 0, avgInput: t2 > 0 ? o2 / t2 : 0, maxCacheRead: l2, distinctSysHash: h2, estimatedSavedTokens: c2 };
  }
  report() {
    let t2 = this.summary();
    t2.total !== 0 && (this.onSummary?.(t2), this.previousSampleCount >= this.regressionMinSamples && this.previousHitRate >= this.regressionPreviousFloor && t2.total >= this.regressionMinSamples && t2.hitRate < this.regressionThreshold && this.onRegression?.({ detectedAt: t2.windowEndsAt, windowMs: this.windowMs, currentHitRate: t2.hitRate, previousHitRate: this.previousHitRate, drop: this.previousHitRate - t2.hitRate, reason: `hit_rate dropped from ${this.previousHitRate.toFixed(3)} to ${t2.hitRate.toFixed(3)} (\u0394=${(this.previousHitRate - t2.hitRate).toFixed(3)}); ${t2.total} samples in current window` }), this.previousHitRate = t2.hitRate, this.previousSampleCount = t2.total);
  }
  prune() {
    let t2 = Date.now() - this.windowMs;
    for (;this.samples.length > 0 && this.samples[0].ts < t2; )
      this.samples.shift();
  }
  stop() {
    this.timer && (clearInterval(this.timer), this.timer = null);
  }
  get D() {
    return this.samples;
  }
};
var ke = class {
  static {
    i(this, "FileCredentialsProvider");
  }
  path;
  expiryBufferMs;
  cached = null;
  lastMtimeMs = 0;
  constructor(t2 = {}) {
    this.path = t2.path ?? _e(), this.expiryBufferMs = t2.expiryBufferMs ?? 300000;
  }
  async getAccessToken() {
    if (this.mtimeChanged() && (this.cached = null), (!this.cached || this.isExpired(this.cached)) && (this.cached = this.readFromDisk()), !this.cached?.accessToken)
      throw new Error(`No valid OAuth credentials at ${this.path} \u2014 run \`claude login\` or equivalent`);
    return this.cached.accessToken;
  }
  invalidate() {
    this.cached = null, this.lastMtimeMs = 0;
  }
  readFromDisk() {
    try {
      let t2 = ye(this.path, "utf8");
      return this.lastMtimeMs = this.getMtime(), JSON.parse(t2).claudeAiOauth ?? null;
    } catch {
      return null;
    }
  }
  mtimeChanged() {
    return this.getMtime() !== this.lastMtimeMs;
  }
  getMtime() {
    try {
      return we(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }
  isExpired(t2) {
    return !!t2.expiresAt && Date.now() + this.expiryBufferMs >= t2.expiresAt;
  }
};
function _e() {
  let t2 = process.env.HOME || process.env.USERPROFILE || "";
  return `${process.env.CLAUDE_CONFIG_DIR || `${t2}/.claude`}/.credentials.json`;
}
i(_e, "defaultCredentialsPath");
var Te = { error: 0, info: 1, debug: 2 };
var Ee = class {
  static {
    i(this, "ConsoleEventEmitter");
  }
  minRank;
  format;
  write;
  constructor(t2 = {}) {
    this.minRank = Te[t2.minLevel ?? "info"] ?? 1, this.format = t2.format ?? "human", this.write = t2.writeTarget ?? ((t3) => process.stderr.write(t3 + `
`));
  }
  emit(t2) {
    try {
      if ((Te[t2.level] ?? 1) > this.minRank)
        return;
      let e2 = t2.ts ?? new Date().toISOString();
      if (this.format === "json")
        return void this.write(JSON.stringify({ ts: e2, ...t2 }));
      let i2 = e2.slice(11, 23), s2 = t2.level.toUpperCase().padEnd(5), r2 = t2.kind.padEnd(22), n2 = [];
      for (let [e3, i3] of Object.entries(t2)) {
        if (["ts", "level", "kind", "msg"].includes(e3) || i3 == null)
          continue;
        let t3 = typeof i3 == "object" ? JSON.stringify(i3) : String(i3);
        n2.push(`${e3}=${t3.length > 120 ? t3.slice(0, 117) + "..." : t3}`);
      }
      let a2 = t2.msg ? ` ${t2.msg}` : "", o2 = n2.length ? " " + n2.join(" ") : "";
      this.write(`${i2} ${s2} ${r2}${a2}${o2}`);
    } catch {}
  }
};
var Re = class {
  static {
    i(this, "NullEventEmitter");
  }
  emit(t2) {}
};
var $e = class {
  static {
    i(this, "InMemorySessionStore");
  }
  sessions = new Map;
  liveness;
  constructor(t2 = new ve) {
    this.liveness = t2;
  }
  getOrCreate(t2, e2, i2) {
    let s2 = this.sessions.get(t2);
    if (s2)
      return s2;
    let r2 = { sessionId: t2, pid: e2, firstSeenAt: Date.now(), lastRequestAt: Date.now(), engine: i2(), model: null, lastUsage: null };
    return this.sessions.set(t2, r2), r2;
  }
  get(t2) {
    return this.sessions.get(t2);
  }
  list() {
    return Array.from(this.sessions.values());
  }
  size() {
    return this.sessions.size;
  }
  isOwnerAlive(t2) {
    let e2 = this.sessions.get(t2);
    return !e2 || e2.pid === null || e2.pid !== 1 && this.liveness.isAlive(e2.pid);
  }
  reapDead() {
    let t2 = [];
    for (let [e2, i2] of this.sessions.entries())
      if (i2.pid !== null && (i2.pid === 1 || !this.liveness.isAlive(i2.pid))) {
        try {
          i2.engine?.stop?.();
        } catch {}
        this.sessions.delete(e2), t2.push(e2);
      }
    return t2;
  }
  stopAll() {
    for (let t2 of this.sessions.values())
      try {
        t2.engine?.stop?.();
      } catch {}
    this.sessions.clear();
  }
};
var ve = class {
  static {
    i(this, "DefaultLivenessChecker");
  }
  isAlive(t2) {
    if (!t2 || t2 < 1)
      return false;
    try {
      return process.kill(t2, 0), true;
    } catch (t3) {
      return t3.code === "EPERM";
    }
  }
};
var Se = class {
  static {
    i(this, "NativeFetchUpstream");
  }
  async fetch(t2, e2) {
    return fetch(t2, e2);
  }
};
var Me = { anthropicBaseUrl: "https://api.anthropic.com", kaIntervalSec: undefined, kaIdleTimeoutSec: 0, kaMinTokens: 2000, kaRewriteWarnIdleSec: 300, kaRewriteWarnTokens: 50000, kaRewriteBlockIdleSec: 0, kaRewriteBlockEnabled: false };
var De = class {
  static {
    i(this, "ProxyClient");
  }
  config;
  metrics;
  credentials;
  events;
  store;
  upstream;
  liveness;
  reaperTimer;
  lastRateLimit = { status: null, resetAt: null, claim: null, retryAfter: null, utilization5h: null, utilization7d: null };
  constructor(t2) {
    this.config = { ...Me, ...t2.config }, this.credentials = t2.credentialsProvider, this.events = t2.eventEmitter ?? new Ee, this.liveness = t2.livenessChecker ?? new ve, this.store = t2.sessionStore ?? new $e(this.liveness), this.upstream = t2.upstreamFetcher ?? new Se, this.metrics = new ge({ windowMs: 60000, reportIntervalMs: 60000, onSummary: i((t3) => this.events.emit({ level: "info", kind: "CACHE_METRICS_SUMMARY", ...t3 }), "onSummary"), onRegression: i((t3) => this.events.emit({ level: "error", kind: "CACHE_REGRESSION_DETECTED", ...t3 }), "onRegression") }), this.reaperTimer = setInterval(() => {
      let t3 = this.store.reapDead();
      for (let e2 of t3)
        this.events.emit({ level: "info", kind: "SESSION_DEAD", sessionId: e2, reason: "pid_gone" });
    }, 1e4), this.reaperTimer && typeof this.reaperTimer == "object" && "unref" in this.reaperTimer && this.reaperTimer.unref();
  }
  get rateLimitSnapshot() {
    return this.lastRateLimit;
  }
  listSessions() {
    return this.store.list();
  }
  sessionCount() {
    return this.store.size();
  }
  get configSnapshot() {
    return this.config;
  }
  get cacheMetricsSnapshot() {
    return this.metrics.summary();
  }
  stop() {
    clearInterval(this.reaperTimer), this.metrics.stop(), this.store.stopAll();
  }
  async handleRequest(t2, e2, i2) {
    let s2 = i2.sessionId, r2 = i2.sourcePid ?? null, n2 = this.store.getOrCreate(s2, r2, () => this.createEngine(s2));
    n2.lastRequestAt = Date.now();
    let a2, o2 = typeof t2 == "string" ? t2 : new TextDecoder().decode(t2), l2 = typeof t2 == "string" ? new TextEncoder().encode(t2).byteLength : t2.byteLength;
    try {
      a2 = JSON.parse(o2);
    } catch {
      return this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, msg: "Invalid JSON body" }), Ie(400, { error: "Invalid JSON" });
    }
    let h2 = a2.model ?? "unknown";
    n2.model = h2;
    let c2 = {};
    for (let [t3, i3] of Object.entries(e2)) {
      let e3 = t3.toLowerCase();
      be.includes(e3) || (c2[t3] = i3);
    }
    c2["accept-encoding"] = "identity";
    try {
      let t3 = await this.credentials.getAccessToken();
      c2.Authorization = `Bearer ${t3}`;
    } catch (t3) {
      return this.events.emit({ level: "error", kind: "TOKEN_NEEDS_RELOGIN", sessionId: s2, msg: t3?.message ?? "No OAuth credentials" }), Ie(401, { error: { type: "authentication_error", message: t3?.message ?? "No OAuth credentials" } });
    }
    let u2 = c2["anthropic-beta"] ?? c2["Anthropic-Beta"] ?? "";
    if (!u2.includes("oauth-2025-04-20")) {
      let t3 = u2 ? u2 + "," : "";
      c2["anthropic-beta"] = t3 + "oauth-2025-04-20", delete c2["Anthropic-Beta"];
    }
    this.events.emit({ level: "info", kind: "REAL_REQUEST_START", sessionId: s2, model: h2, bodyBytes: l2 }), n2.engine.notifyRealRequestStart(h2, a2, c2);
    try {
      n2.engine.checkRewriteGuard(h2);
    } catch (t3) {
      if (t3?.code === "CACHE_REWRITE_BLOCKED")
        return Ie(429, { error: { type: "cache_rewrite_blocked", message: t3.message } });
      throw t3;
    }
    let d2, p2, f2, m2 = Date.now();
    try {
      d2 = await this.upstream.fetch(`${this.config.anthropicBaseUrl}/v1/messages?beta=true`, { method: "POST", headers: c2, body: o2, signal: i2.signal });
    } catch (t3) {
      return this.handleNetworkError(s2, t3);
    }
    if (this.lastRateLimit = Ae(d2.headers), !d2.ok) {
      let t3 = await d2.text().catch(() => "");
      return d2.status === 401 && this.credentials.invalidate(), this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, status: d2.status, msg: t3.slice(0, 200) }), new Response(t3, { status: d2.status, headers: d2.headers });
    }
    if (!d2.body)
      return new Response("No upstream body", { status: 502 });
    try {
      let t3 = d2.body.tee();
      p2 = t3[0], f2 = t3[1];
    } catch (t3) {
      return this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, msg: `tee() failed: ${t3?.message}` }), new Response(d2.body, { status: d2.status, headers: d2.headers });
    }
    this.parseSSEAndNotify(f2, n2, s2, h2, m2).catch((t3) => {
      this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, msg: `parse promise rejected: ${t3?.message}` });
    });
    let g2 = new Headers(d2.headers);
    return g2.delete("content-encoding"), g2.delete("content-length"), new Response(p2, { status: d2.status, headers: g2 });
  }
  createEngine(t2) {
    let e2 = this.config;
    return new xt({ config: { intervalMs: e2.kaIntervalSec !== undefined ? 1000 * e2.kaIntervalSec : undefined, idleTimeoutMs: e2.kaIdleTimeoutSec > 0 ? 1000 * e2.kaIdleTimeoutSec : 1 / 0, minTokens: e2.kaMinTokens, rewriteWarnIdleMs: 1000 * e2.kaRewriteWarnIdleSec, rewriteWarnTokens: e2.kaRewriteWarnTokens, rewriteBlockIdleMs: e2.kaRewriteBlockIdleSec > 0 ? 1000 * e2.kaRewriteBlockIdleSec : 1 / 0, rewriteBlockEnabled: e2.kaRewriteBlockEnabled, onHeartbeat: i((e3) => {
      this.metrics.recordRequest({ kind: "ka", cacheRead: e3.usage.cacheReadInputTokens ?? 0, cacheWrite: e3.usage.cacheCreationInputTokens ?? 0, input: e3.usage.inputTokens ?? 0, model: e3.model }), this.events.emit({ level: "info", kind: "KA_FIRE_COMPLETE", sessionId: t2, model: e3.model, durationMs: e3.durationMs, idleMs: e3.idleMs, usage: { inputTokens: e3.usage.inputTokens, outputTokens: e3.usage.outputTokens, cacheReadInputTokens: e3.usage.cacheReadInputTokens ?? 0, cacheCreationInputTokens: e3.usage.cacheCreationInputTokens ?? 0 }, rateLimit: e3.rateLimit });
    }, "onHeartbeat"), onTick: i((i2) => {
      let s2 = 1000 * (e2.kaIntervalSec ?? 120);
      i2.idleMs > 0.9 * s2 && this.events.emit({ level: "debug", kind: "KA_TICK_IDLE", sessionId: t2, idleMs: i2.idleMs, nextFireMs: i2.nextFireMs, model: i2.model, tokens: i2.tokens });
    }, "onTick"), onDisarmed: i((e3) => this.events.emit({ level: "error", kind: "KA_DISARM", sessionId: t2, reason: e3.reason, msg: `KA disarmed for session ${t2.slice(0, 8)} \u2014 reason=${e3.reason}` }), "onDisarmed"), onRewriteWarning: i((e3) => this.events.emit({ level: e3.blocked ? "error" : "info", kind: e3.blocked ? "REWRITE_BLOCK" : "REWRITE_WARN", sessionId: t2, idleMs: e3.idleMs, estimatedTokens: e3.estimatedTokens, blocked: e3.blocked, model: e3.model }), "onRewriteWarning"), onNetworkStateChange: i((e3) => this.events.emit({ level: e3.to === "degraded" ? "error" : "info", kind: e3.to === "degraded" ? "NETWORK_DEGRADED" : "NETWORK_HEALTHY", sessionId: t2, from: e3.from, to: e3.to }), "onNetworkStateChange") }, getToken: i(() => this.credentials.getAccessToken(), "getToken"), doFetch: i((t3, e3, i2) => this.engineDoFetch(t3, e3, i2), "doFetch"), getRateLimitInfo: i(() => this.lastRateLimit, "getRateLimitInfo"), isOwnerAlive: i(() => this.store.isOwnerAlive(t2), "isOwnerAlive") });
  }
  async* engineDoFetch(t2, e2, i2) {
    let s2 = JSON.stringify(t2), r2 = await this.upstream.fetch(`${this.config.anthropicBaseUrl}/v1/messages?beta=true`, { method: "POST", headers: e2, body: s2, signal: i2 });
    if (!r2.ok) {
      let t3 = await r2.text().catch(() => ""), e3 = new Error(`HTTP ${r2.status}: ${t3.slice(0, 200)}`);
      throw e3.status = r2.status, r2.status === 401 && this.credentials.invalidate(), e3;
    }
    if (!r2.body)
      throw new Error("No response body");
    yield* Ce(r2.body, i2);
  }
  async parseSSEAndNotify(t2, e2, i2, s2, r2) {
    try {
      let n2 = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, a2 = new TextDecoder, o2 = t2.getReader(), l2 = "";
      for (;; ) {
        let t3, e3;
        try {
          let i3 = await o2.read();
          t3 = i3.done, e3 = i3.value;
        } catch (t4) {
          return void this.events.emit({ level: "debug", kind: "REAL_REQUEST_ERROR", sessionId: i2, msg: `stream read aborted: ${t4?.message}` });
        }
        if (t3)
          break;
        if (!e3)
          continue;
        l2 += a2.decode(e3, { stream: true });
        let s3 = l2.split(`
`);
        l2 = s3.pop() ?? "";
        for (let t4 of s3) {
          if (!t4.startsWith("data: "))
            continue;
          let e4 = t4.slice(6);
          if (e4 !== "[DONE]")
            try {
              let t5 = JSON.parse(e4);
              if (t5.type === "message_start" && t5.message?.usage) {
                let e5 = t5.message.usage;
                n2 = { inputTokens: e5.input_tokens ?? 0, outputTokens: e5.output_tokens ?? 0, cacheCreationInputTokens: e5.cache_creation_input_tokens ?? 0, cacheReadInputTokens: e5.cache_read_input_tokens ?? 0 };
              } else
                t5.type === "message_delta" && t5.usage?.output_tokens && (n2.outputTokens = t5.usage.output_tokens);
            } catch {}
        }
      }
      let h2 = e2.lastUsage === null;
      e2.lastUsage = n2;
      try {
        e2.engine.notifyRealRequestComplete(n2);
      } catch (t3) {
        this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: i2, msg: `engine.notifyRealRequestComplete: ${t3?.message}` });
      }
      this.metrics.recordRequest({ kind: "real", cacheRead: n2.cacheReadInputTokens ?? 0, cacheWrite: n2.cacheCreationInputTokens ?? 0, input: n2.inputTokens ?? 0, model: s2, firstCall: h2 }), this.events.emit({ level: "info", kind: "REAL_REQUEST_COMPLETE", sessionId: i2, model: s2, durationMs: Date.now() - r2, usage: n2, rateLimit: { util5h: this.lastRateLimit.utilization5h, util7d: this.lastRateLimit.utilization7d, status: this.lastRateLimit.status } });
    } catch (t3) {
      this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: i2, msg: `SSE parse error: ${t3?.message ?? t3}` });
    }
  }
  handleNetworkError(t2, e2) {
    let i2 = e2?.code ?? e2?.cause?.code ?? "", s2 = String(e2?.message ?? "").toLowerCase(), r2 = Oe.has(i2) || s2.includes("unable to connect") || s2.includes("failed to open socket") || s2.includes("connection refused") || s2.includes("network");
    return this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: t2, status: r2 ? 503 : 502, msg: `upstream fetch threw: ${i2 || ""} ${s2}`.trim().slice(0, 200) }), r2 ? new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Upstream network error \u2014 proxy cannot reach Anthropic. Retrying will help once network is restored." } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "2" } }) : new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream request failed: ${s2 || i2 || "unknown"}` } }), { status: 502, headers: { "content-type": "application/json" } });
  }
};
var be = ["host", "content-length", "connection", "authorization", "accept-encoding"];
var Oe = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
function Ae(t2) {
  return { status: t2.get("anthropic-ratelimit-unified-status"), resetAt: t2.get("anthropic-ratelimit-unified-reset") ? Number(t2.get("anthropic-ratelimit-unified-reset")) : null, claim: t2.get("anthropic-ratelimit-unified-representative-claim"), retryAfter: t2.get("retry-after") ? parseFloat(t2.get("retry-after")) : null, utilization5h: t2.get("anthropic-ratelimit-unified-5h-utilization") ? parseFloat(t2.get("anthropic-ratelimit-unified-5h-utilization")) : null, utilization7d: t2.get("anthropic-ratelimit-unified-7d-utilization") ? parseFloat(t2.get("anthropic-ratelimit-unified-7d-utilization")) : null };
}
function Ie(t2, e2) {
  return new Response(JSON.stringify(e2), { status: t2, headers: { "content-type": "application/json" } });
}
async function* Ce(t2, e2) {
  let i2 = new TextDecoder, s2 = t2.getReader(), r2 = "", n2 = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  try {
    for (;; ) {
      if (e2?.aborted)
        return void s2.cancel();
      let { done: t3, value: a2 } = await s2.read();
      if (t3)
        break;
      r2 += i2.decode(a2, { stream: true });
      let o2 = r2.split(`
`);
      r2 = o2.pop() ?? "";
      for (let t4 of o2) {
        if (!t4.startsWith("data: "))
          continue;
        let e3, i3 = t4.slice(6);
        if (i3 !== "[DONE]") {
          try {
            e3 = JSON.parse(i3);
          } catch {
            continue;
          }
          if (e3.type === "message_start" && e3.message?.usage) {
            let t5 = e3.message.usage;
            n2 = { inputTokens: t5.input_tokens ?? 0, outputTokens: t5.output_tokens ?? 0, cacheCreationInputTokens: t5.cache_creation_input_tokens ?? 0, cacheReadInputTokens: t5.cache_read_input_tokens ?? 0 };
          } else
            e3.type === "message_delta" && e3.usage?.output_tokens ? n2.outputTokens = e3.usage.output_tokens : e3.type === "message_stop" && (yield { type: "message_stop", usage: n2, stopReason: null });
        }
      }
    }
  } finally {
    s2.releaseLock();
  }
}
i(Ae, "parseRateLimitHeaders"), i(Ie, "jsonResponse"), i(Ce, "parseSSEToEvents"), I(), I();
var He = '{"type":"KeepAlive"}';
var Be = 16000;
var Ue = Math.floor(3200);
async function Ke(t2, e2, s2) {
  let r2 = s2?.baseUrl ?? "https://api.anthropic.com", n2 = new URLSearchParams({ encoding: "linear16", sample_rate: String(Be), channels: String(1), endpointing_ms: "300", utterance_end_ms: "1000", language: s2?.language ?? "en" });
  if (s2?.keyterms?.length)
    for (let t3 of s2.keyterms)
      n2.append("keyterms", t3);
  let a2 = `/api/ws/speech_to_text/voice_stream?${n2.toString()}`, o2 = Pe(16).toString("base64"), l2 = null, h2 = false, c2 = false, u2 = false, d2 = null, p2 = null, f2 = "", m2 = await new Promise((e3, i2) => {
    let s3 = setTimeout(() => {
      i2(new Error("voice_stream WebSocket connection timeout (10s)"));
    }, 1e4), n3 = new URL(r2), l3 = Le({ hostname: n3.hostname, port: n3.port || 443, path: a2, method: "GET", headers: { Authorization: `Bearer ${t2}`, "User-Agent": "claude-cli/1.0.0 (subscriber, cli)", "x-app": "cli", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": o2 } });
    l3.on("upgrade", (t3, r3, n4) => {
      clearTimeout(s3);
      let a3 = Fe("sha1").update(o2 + "258EAFA5-E914-47DA-95CA-5AB5DC11E5B3").digest("base64");
      if (t3.headers["sec-websocket-accept"] !== a3)
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
  function g2(t3) {
    k2(Buffer.from(t3, "utf8"), 1);
  }
  function y2(t3) {
    k2(t3, 2);
  }
  function w2() {
    k2(Buffer.alloc(0), 8);
  }
  function k2(t3, e3) {
    if (m2.destroyed)
      return;
    let i2, s3 = Pe(4), r3 = Buffer.alloc(t3.length);
    for (let e4 = 0;e4 < t3.length; e4++)
      r3[e4] = t3[e4] ^ s3[e4 % 4];
    t3.length < 126 ? (i2 = Buffer.alloc(6), i2[0] = 128 | e3, i2[1] = 128 | t3.length, s3.copy(i2, 2)) : t3.length < 65536 ? (i2 = Buffer.alloc(8), i2[0] = 128 | e3, i2[1] = 254, i2.writeUInt16BE(t3.length, 2), s3.copy(i2, 4)) : (i2 = Buffer.alloc(14), i2[0] = 128 | e3, i2[1] = 255, i2.writeBigUInt64BE(BigInt(t3.length), 2), s3.copy(i2, 10)), m2.write(Buffer.concat([i2, r3]));
  }
  h2 = true, i(g2, "wsSendText"), i(y2, "wsSendBinary"), i(w2, "wsSendClose"), i(k2, "wsSendFrame");
  let _2 = Buffer.alloc(0);
  function T2() {
    for (;_2.length >= 2; ) {
      let t3 = _2[0], e3 = _2[1], i2 = 15 & t3, s3 = !!(128 & e3), r3 = 127 & e3, n3 = 2;
      if (r3 === 126) {
        if (_2.length < 4)
          return;
        r3 = _2.readUInt16BE(2), n3 = 4;
      } else if (r3 === 127) {
        if (_2.length < 10)
          return;
        r3 = Number(_2.readBigUInt64BE(2)), n3 = 10;
      }
      s3 && (n3 += 4);
      let a3 = n3 + r3;
      if (_2.length < a3)
        return;
      let o3 = _2.subarray(n3, a3);
      if (s3) {
        let t4 = _2.subarray(n3 - 4, n3);
        o3 = Buffer.from(o3);
        for (let e4 = 0;e4 < o3.length; e4++)
          o3[e4] = o3[e4] ^ t4[e4 % 4];
      }
      if (_2 = _2.subarray(a3), i2 === 1)
        E2(o3.toString("utf8"));
      else {
        if (i2 === 8)
          return void R2(o3.length >= 2 ? o3.readUInt16BE(0) : 1005, o3.length > 2 ? o3.subarray(2).toString("utf8") : "");
        i2 === 9 && k2(o3, 10);
      }
    }
  }
  function E2(t3) {
    let i2;
    try {
      i2 = JSON.parse(t3);
    } catch {
      return;
    }
    switch (i2.type) {
      case "TranscriptText": {
        let t4 = i2.data;
        c2 && p2?.(), t4 && (f2 = t4, e2.onTranscript(t4, false));
        break;
      }
      case "TranscriptEndpoint": {
        let t4 = f2;
        f2 = "", t4 && e2.onTranscript(t4, true), c2 && d2?.("post_closestream_endpoint");
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
  function R2(t3, i2) {
    if (h2 = false, l2 && (clearInterval(l2), l2 = null), f2) {
      let t4 = f2;
      f2 = "", e2.onTranscript(t4, true);
    }
    d2?.("ws_close"), !u2 && t3 !== 1000 && t3 !== 1005 && e2.onError(`Connection closed: code ${t3}${i2 ? ` \u2014 ${i2}` : ""}`), e2.onClose(), m2.destroy();
  }
  return i(T2, "processFrames"), i(E2, "handleMessage"), i(R2, "handleClose"), m2.on("data", (t3) => {
    _2 = Buffer.concat([_2, t3]), T2();
  }), m2.on("close", () => {
    h2 && R2(1006, "connection lost");
  }), m2.on("error", (t3) => {
    u2 || e2.onError(`Socket error: ${t3.message}`);
  }), g2(He), l2 = setInterval(() => {
    h2 && g2(He);
  }, 8000), { send(t3) {
    !h2 || c2 || y2(Buffer.from(t3));
  }, finalize: () => u2 || c2 ? Promise.resolve("already_closed") : (u2 = true, new Promise((t3) => {
    let s3 = setTimeout(() => d2?.("safety_timeout"), 5000), r3 = setTimeout(() => d2?.("no_data_timeout"), 1500);
    p2 = i(() => {
      clearTimeout(r3), p2 = null;
    }, "cancelNoDataTimer"), d2 = i((i2) => {
      if (clearTimeout(s3), clearTimeout(r3), d2 = null, p2 = null, f2) {
        let t4 = f2;
        f2 = "", e2.onTranscript(t4, true);
      }
      t3(i2);
    }, "resolveFinalize"), m2.destroyed ? d2("ws_already_closed") : setTimeout(() => {
      c2 = true, h2 && g2('{"type":"CloseStream"}');
    }, 0);
  })), close() {
    c2 = true, l2 && (clearInterval(l2), l2 = null), h2 = false, m2.destroyed || (w2(), m2.destroy());
  }, isConnected: () => h2 && !m2.destroyed };
}
async function We(t2, e2, s2) {
  let r2 = [], n2 = null, a2 = await Ke(t2, { onTranscript: i((t3, e3) => {
    e3 ? r2.push(t3.trim()) : s2?.onInterim?.(t3);
  }, "onTranscript"), onError: i((t3) => {
    n2 = t3;
  }, "onError"), onClose: i(() => {}, "onClose") }, s2);
  try {
    let t3 = await Qe(e2), i2 = t3;
    t3.length > 44 && t3[0] === 82 && t3[1] === 73 && t3[2] === 70 && t3[3] === 70 && (i2 = t3.subarray(44));
    let r3 = s2?.realtime !== false;
    for (let t4 = 0;t4 < i2.length && a2.isConnected(); t4 += Ue) {
      let e3 = i2.subarray(t4, Math.min(t4 + Ue, i2.length));
      a2.send(e3), r3 && t4 + Ue < i2.length && await Ge(80);
    }
    await a2.finalize();
  } finally {
    a2.close();
  }
  if (n2)
    throw new Error(`Transcription error: ${n2}`);
  return r2.join(" ");
}
async function Je(t2, e2, s2) {
  let r2 = [], n2 = null, a2 = await Ke(t2, { onTranscript: i((t3, e3) => {
    e3 ? r2.push(t3.trim()) : s2?.onInterim?.(t3);
  }, "onTranscript"), onError: i((t3) => {
    n2 = t3;
  }, "onError"), onClose: i(() => {}, "onClose") }, s2);
  try {
    let t3 = Ye();
    if (!t3)
      throw new Error("No audio converter found. Install ffmpeg or sox.");
    await Ve(a2, e2, t3, s2?.realtime !== false), await a2.finalize();
  } finally {
    a2.close();
  }
  if (n2)
    throw new Error(`Transcription error: ${n2}`);
  return r2.join(" ");
}
function je(t2, e2) {
  if (ze("rec")) {
    let i2 = xe("rec", ["-q", "--buffer", "1024", "-t", "raw", "-r", String(Be), "-e", "signed", "-b", String(16), "-c", String(1), "-", "silence", "1", "0.1", "3%", "1", "2.0", "3%"], { stdio: ["pipe", "pipe", "pipe"] });
    return i2.stdout?.on("data", t2), i2.stderr?.on("data", () => {}), i2.on("close", e2), i2.on("error", e2), { stop() {
      i2.kill("SIGTERM");
    } };
  }
  if (ze("arecord")) {
    let i2 = xe("arecord", ["-f", "S16_LE", "-r", String(Be), "-c", String(1), "-t", "raw", "-q", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    return i2.stdout?.on("data", t2), i2.stderr?.on("data", () => {}), i2.on("close", e2), i2.on("error", e2), { stop() {
      i2.kill("SIGTERM");
    } };
  }
  return null;
}
function qe() {
  return ze("rec") ? { available: true, tool: "sox", installHint: null } : ze("arecord") ? { available: true, tool: "arecord", installHint: null } : { available: false, tool: null, installHint: { darwin: "brew install sox", linux: "sudo apt-get install sox  # or: sudo apt-get install alsa-utils" }[process.platform] ?? "Install SoX (sox) or ALSA utils (arecord)" };
}
function ze(t2) {
  return Ne(t2, ["--version"], { stdio: "ignore", timeout: 3000 }).error === undefined;
}
function Ge(t2) {
  return new Promise((e2) => setTimeout(e2, t2));
}
async function Qe(t2) {
  let { readFile: e2 } = await import("fs/promises");
  return e2(t2);
}
function Ye() {
  return ze("ffmpeg") ? "ffmpeg" : ze("sox") ? "sox" : null;
}
async function Ve(t2, e2, i2, s2) {
  let r2 = i2 === "ffmpeg" ? ["-i", e2, "-f", "s16le", "-ar", String(Be), "-ac", String(1), "pipe:1"] : [e2, "-t", "raw", "-r", String(Be), "-e", "signed", "-b", String(16), "-c", String(1), "-"], n2 = xe(i2, r2, { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((e3, r3) => {
    let a2 = Date.now();
    n2.stdout?.on("data", async (e4) => {
      if (t2.isConnected()) {
        if (t2.send(e4), s2) {
          let t3 = e4.length / 32000 * 1000, i3 = Date.now() - a2, s3 = Math.max(0, 0.8 * t3 - i3);
          s3 > 10 && (n2.stdout?.pause(), await Ge(s3), n2.stdout?.resume()), a2 = Date.now();
        }
      } else
        n2.kill("SIGTERM");
    }), n2.stderr?.on("data", () => {}), n2.on("close", (t3) => {
      t3 !== 0 && t3 !== null ? r3(new Error(`${i2} exited with code ${t3}`)) : e3();
    }), n2.on("error", r3);
  });
}
i(Ke, "connectVoiceStream"), i(We, "transcribeFile"), i(Je, "transcribeAudioFile"), i(je, "startMicRecording"), i(qe, "checkVoiceDeps"), i(ze, "hasCommand"), i(Ge, "sleep"), i(Qe, "readFileAsBuffer"), i(Ye, "findConverter"), i(Ve, "streamConvertedAudio");

// index.ts
import { appendFileSync } from "fs";
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
      join(cwd, ".claude", ".credentials.json"),
      join(cwd, ".credentials.json"),
      join(homedir(), ".claude", ".credentials.json")
    ];
    this.credPath = candidates.find((p2) => existsSync(p2)) ?? join(homedir(), ".claude", ".credentials.json");
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
      const raw = readFileSync(this.credPath, "utf8");
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
      existing = JSON.parse(readFileSync(this.credPath, "utf8"));
    } catch {}
    existing.claudeAiOauth = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt
    };
    const dir = dirname(this.credPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
    writeFileSync(this.credPath, JSON.stringify(existing, null, 2), "utf8");
    try {
      chmodSync(this.credPath, 384);
    } catch {}
    this.lastMtime = this.getMtime();
  }
  getMtime() {
    try {
      return statSync(this.credPath).mtimeMs;
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
var DEBUG = process.env.CLAUDE_MAX_DEBUG !== "0";
var LOG_FILE = join(homedir(), ".claude", "claude-max-debug.log");
function dbg(...args) {
  if (!DEBUG)
    return;
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ")}
`);
  } catch {}
}
var _identityError = null;
function getIdentityError() {
  return _identityError;
}
async function resolveOAuthIdentity() {
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "mcp-auth.json");
    if (!existsSync(authPath))
      return null;
    const authData = JSON.parse(readFileSync(authPath, "utf-8"));
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
    dbg(`OAuth whoami failed: ${e2?.message}`);
    return null;
  }
}
function _readPkgVersion(p2) {
  try {
    const j2 = JSON.parse(readFileSync(p2, "utf8"));
    return `${j2.name ?? "?"}@${j2.version ?? "?"}`;
  } catch {
    return "unknown";
  }
}
var _PLUGIN_PKG = _readPkgVersion(join(import.meta.dir, "..", "package.json"));
var _SDK_PKG = _readPkgVersion(join(import.meta.dir, "..", "node_modules", "@life-ai-tools", "claude-code-sdk", "package.json"));
var opencode_claude_default = {
  id: "opencode-claude-max",
  server: async (input) => {
    const t0 = Date.now();
    const cwd = input.directory ?? process.cwd();
    const sessionId = process.env.OPENCODE_SESSION_ID ?? process.env.OPENCODE_SESSION_SLUG ?? input.sessionID ?? "unknown";
    const creds = new CredentialManager(cwd);
    const providerPath = `file://${import.meta.dir}/provider.js`;
    let _providerMtime = "unknown";
    try {
      _providerMtime = statSync(join(import.meta.dir, "provider.js")).mtime.toISOString();
    } catch {}
    dbg(`STARTUP plugin.server() pid=${process.pid} session=${sessionId} cwd=${cwd} cred=${creds.credPath} loggedIn=${creds.hasCredentials} plugin=${_PLUGIN_PKG} sdkInProc=${_SDK_PKG} node=${process.version} providerPath=${providerPath} providerMtime=${_providerMtime} initTime=${Date.now() - t0}ms`);
    const _serverUrl = typeof input.serverUrl === "object" && input.serverUrl?.href ? input.serverUrl.href.replace(/\/$/, "") : typeof input.serverUrl === "string" ? input.serverUrl.replace(/\/$/, "") : "";
    const _sessionId = process.env.OPENCODE_SESSION_ID ?? sessionId;
    dbg(`STARTUP provider context: serverUrl=${_serverUrl} sessionId=${_sessionId}`);
    let _memberId = process.env.SYNQTASK_MEMBER_ID;
    let _memberType = "unknown";
    let _identityError2 = null;
    try {
      const configPath = __require("path").join(cwd, "opencode.json");
      if (__require("fs").existsSync(configPath)) {
        const projConfig = JSON.parse(__require("fs").readFileSync(configPath, "utf-8"));
        const synqHeaders = projConfig?.mcp?.synqtask?.headers;
        if (synqHeaders?.["X-Agent-Id"]) {
          _memberId = synqHeaders["X-Agent-Id"];
          _memberType = "agent";
          dbg(`WAKE memberId from opencode.json (agent): ${_memberId}`);
        }
      }
    } catch (e2) {
      dbg(`WAKE config read failed: ${e2?.message}`);
    }
    if (!_memberId || _memberType !== "agent") {
      try {
        const oauthResult = await resolveOAuthIdentity();
        if (oauthResult) {
          _memberId = oauthResult.memberId;
          _memberType = "human";
          dbg(`WAKE memberId from OAuth whoami (human): ${_memberId} name=${oauthResult.memberName}`);
        } else if (!_memberId) {
          _identityError2 = "OAuth whoami returned no member (token expired or SynqTask down?)";
          dbg(`WAKE OAuth whoami failed: ${_identityError2}`);
        }
      } catch (e2) {
        _identityError2 = e2?.message ?? "OAuth whoami exception";
        dbg(`WAKE OAuth identity failed (non-fatal): ${_identityError2}`);
      }
    }
    dbg("WAKE listener bootstrap is owned by @life-ai-tools/opencode-signal-wire/plugin");
    if (!_memberId && _identityError2) {
      try {
        setTimeout(() => {
          try {
            if (_serverUrl) {
              fetch(`${_serverUrl}/tui/toast`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: `\u26A0\uFE0F Wake identity not resolved: ${_identityError2}`, type: "warning" })
              }).catch(() => {});
            }
          } catch {}
        }, 2000);
      } catch {}
    }
    if (!creds.hasCredentials) {
      dbg("Not logged in \u2014 run: opencode providers login -p claude-max");
    }
    return {
      config: async (config) => {
        const tc = Date.now();
        if (!config.provider)
          config.provider = {};
        dbg("STARTUP config hook called");
        config.provider["claude-max"] = {
          id: "claude-max",
          name: "Claude Max/Pro",
          api: "https://api.anthropic.com",
          npm: providerPath,
          env: [],
          models: {}
        };
        for (const [id, info] of Object.entries(V)) {
          const isAdaptive = et(id);
          config.provider["claude-max"].models[id] = {
            id,
            name: `${info.name} (Max)`,
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
            cost: { input: info.cost.input, output: info.cost.output, cache: { read: info.cost.cacheRead, write: info.cost.cacheWrite } },
            limit: { context: info.context, output: info.defaultOutput },
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
        dbg(`STARTUP config hook done in ${Date.now() - tc}ms \u2014 ${Object.keys(config.provider["claude-max"].models).length} models registered`);
      },
      auth: {
        provider: "claude-max",
        loader: async (_getAuth, provider) => {
          const tl = Date.now();
          dbg("STARTUP auth.loader called", { providerModels: Object.keys(provider.models ?? {}), providerOptions: provider.options });
          dbg(`STARTUP auth.loader done in ${Date.now() - tl}ms credPath=${creds.credPath}`);
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
              const savePath = inputs?.credLocation === "local" ? join(cwd, ".claude", ".credentials.json") : join(homedir(), ".claude", ".credentials.json");
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
                  const st2 = url.searchParams.get("state");
                  const error = url.searchParams.get("error");
                  if (error) {
                    rejectCode(new Error(`OAuth error: ${error}`));
                    return new Response("<h1>Login failed</h1>", { status: 400, headers: { "Content-Type": "text/html" } });
                  }
                  if (!code || st2 !== state) {
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
                      dbg(`Token exchange failed (${tokenRes.status}): ${body}`);
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
          dbg(`MCP_EVENT: tools changed on server=${event.properties?.server}`);
        }
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
