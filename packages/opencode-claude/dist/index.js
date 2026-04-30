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
import { homedir as f } from "os";
import { createHash as N, randomBytes as I, randomUUID as x } from "crypto";
import { readFileSync as L, writeFileSync as F, chmodSync as P, mkdirSync as U, rmdirSync as B, statSync as J, unlinkSync as W, appendFileSync as H } from "fs";
import { join as j } from "path";
import { homedir as K } from "os";
import { mkdirSync as ie, readdirSync as se, statSync as re, unlinkSync as ne, writeFileSync as ae } from "fs";
import { createHash as oe } from "crypto";
import { homedir as le } from "os";
import { join as he } from "path";
import { statSync as ce, readFileSync as ue } from "fs";
import { homedir as de } from "os";
import { join as fe } from "path";
import { readFileSync as Ve, writeFileSync as Xe, mkdirSync as Ze } from "fs";
import { dirname as et } from "path";
import { randomUUID as tt } from "crypto";
import { readFileSync as nt, statSync as at } from "fs";
import { spawn as vt, spawnSync as Et } from "child_process";
import { request as Rt } from "https";
import { randomBytes as St, createHash as bt } from "crypto";
var e = Object.defineProperty;
var t = Object.getOwnPropertyNames;
var i = (t2, i2) => e(t2, "name", { value: i2, configurable: true });
var s = ((e2) => "function" < "u" ? __require : typeof Proxy < "u" ? new Proxy(e2, { get: (e3, t2) => ("function" < "u" ? __require : e3)[t2] }) : e2)(function(e2) {
  if ("function" < "u")
    return __require.apply(this, arguments);
  throw Error('Dynamic require of "' + e2 + '" is not supported');
});
var r = {};
((t2, i2) => {
  for (var s2 in i2)
    e(t2, s2, { get: i2[s2], enumerable: true });
})(r, { getClaudeConfigDir: () => p, getDefaultCredentialsPath: () => m, oauthLogin: () => T });
function p() {
  return (process.env.CLAUDE_CONFIG_DIR ?? d(f(), ".claude")).normalize("NFC");
}
function m() {
  return d(p(), ".credentials.json");
}
function y() {
  return k(a(32));
}
function g(e2) {
  return k(n("sha256").update(e2).digest());
}
function w() {
  return k(a(32));
}
function k(e2) {
  return e2.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
async function T(e2 = {}) {
  let t2 = e2.credentialsPath ?? m(), i2 = y(), s2 = g(i2), r2 = w(), { port: n2, waitForCode: a2, close: d2 } = await _(r2, e2.port), f2 = `http://localhost:${n2}/callback`, p2 = e2.loginWithClaudeAi !== false ? b : S, k2 = new URLSearchParams({ client_id: E, response_type: "code", scope: D, code_challenge: s2, code_challenge_method: "S256", state: r2, code: "true" });
  e2.loginHint && k2.set("login_hint", e2.loginHint), e2.loginMethod && k2.set("login_method", e2.loginMethod), e2.orgUUID && k2.set("orgUUID", e2.orgUUID);
  let T2, R, C = `${p2}?${k2.toString()}&redirect_uri=${encodeURIComponent(f2)}`, O = `${p2}?${k2.toString()}&redirect_uri=${encodeURIComponent(M)}`;
  e2.onAuthUrl ? e2.onAuthUrl(C, O) : (console.log(`
\uD83D\uDD10 Login to Claude
`), console.log(`Open this URL in your browser:
`), console.log(`  ${O}
`)), e2.openBrowser !== false && v(C).catch(() => {});
  try {
    T2 = await a2, R = f2;
  } catch (e3) {
    throw d2(), e3;
  }
  d2();
  let A = await fetch($, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: T2, redirect_uri: R, client_id: E, code_verifier: i2, state: r2 }) });
  if (!A.ok) {
    let e3 = await A.text();
    throw new Error(`Token exchange failed (${A.status}): ${e3}`);
  }
  let N2 = await A.json(), I2 = Date.now() + 1000 * N2.expires_in, x2 = { accessToken: N2.access_token, refreshToken: N2.refresh_token, expiresAt: I2, scopes: N2.scope?.split(" ") ?? [] }, L2 = {};
  try {
    L2 = JSON.parse(l(t2, "utf8"));
  } catch {}
  L2.claudeAiOauth = x2;
  let F2 = u(t2);
  try {
    h(F2, { recursive: true });
  } catch {}
  return o(t2, JSON.stringify(L2, null, 2), "utf8"), c(t2, 384), console.log(`
\u2705 Login successful! Credentials saved to ${t2}
`), { accessToken: x2.accessToken, refreshToken: x2.refreshToken, expiresAt: x2.expiresAt, credentialsPath: t2 };
}
async function _(e2, t2) {
  let s2, r2, n2 = new Promise((e3, t3) => {
    s2 = e3, r2 = t3;
  }), a2 = Bun.serve({ port: t2 ?? 0, async fetch(t3) {
    let i2 = new URL(t3.url);
    if (i2.pathname !== "/callback")
      return new Response("Not found", { status: 404 });
    let n3 = i2.searchParams.get("code"), a3 = i2.searchParams.get("state"), o3 = i2.searchParams.get("error");
    return o3 ? (r2(new Error(`OAuth error: ${o3} \u2014 ${i2.searchParams.get("error_description") ?? ""}`)), new Response("<html><body><h1>Login failed</h1><p>You can close this tab.</p></body></html>", { status: 400, headers: { "Content-Type": "text/html" } })) : n3 && a3 === e2 ? (s2(n3), new Response(null, { status: 302, headers: { Location: `${R}/oauth/code/success?app=claude-code` } })) : (r2(new Error("Invalid callback: missing code or state mismatch")), new Response("Invalid request", { status: 400 }));
  } }), o2 = setTimeout(() => {
    r2(new Error("Login timed out (5 minutes). Try again.")), a2.stop();
  }, 300000);
  return { port: a2.port, waitForCode: n2.finally(() => clearTimeout(o2)), close: i(() => {
    clearTimeout(o2), a2.stop();
  }, "close") };
}
async function v(e2) {
  let t2 = (() => {
    switch (process.platform) {
      case "darwin":
        return [["open", e2]];
      case "win32":
        return [["cmd", "/c", "start", e2]];
      default:
        return [["xdg-open", e2], ["wslview", e2], ["sensible-browser", e2]];
    }
  })();
  for (let e3 of t2)
    try {
      let t3 = Bun.spawn({ cmd: e3, stdout: "ignore", stderr: "ignore" });
      if (await t3.exited, t3.exitCode === 0)
        return;
    } catch {}
}
var E;
var R;
var S;
var b;
var $;
var M;
var D;
var C;
var O;
var A = (C = { "src/auth.ts"() {
  E = "9d1c250a-e61b-44d9-88ed-5944d1962f5e", S = (R = "https://platform.claude.com") + "/oauth/authorize", b = "https://claude.com/cai/oauth/authorize", $ = `${R}/v1/oauth/token`, M = `${R}/oauth/code/callback`, i(p, "getClaudeConfigDir"), i(m, "getDefaultCredentialsPath"), D = ["user:profile", "user:inference", "org:create_api_key", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"].join(" "), i(y, "generateCodeVerifier"), i(g, "generateCodeChallenge"), i(w, "generateState"), i(k, "base64url"), i(T, "oauthLogin"), i(_, "startCallbackServer"), i(v, "tryOpenBrowser");
} }, function() {
  return C && (O = (0, C[t(C)[0]])(C = 0)), O;
});
var q = class extends Error {
  constructor(e2, t2) {
    super(e2), this.cause = t2, this.name = "ClaudeCodeSDKError";
  }
  static {
    i(this, "ClaudeCodeSDKError");
  }
};
var z = class extends q {
  static {
    i(this, "AuthError");
  }
  constructor(e2, t2) {
    super(e2, t2), this.name = "AuthError";
  }
};
var G = class extends q {
  constructor(e2, t2, i2, s2) {
    super(e2, s2), this.status = t2, this.requestId = i2, this.name = "APIError";
  }
  static {
    i(this, "APIError");
  }
};
var Q = class extends q {
  constructor(e2, t2, i2 = 429, s2) {
    super(e2, s2), this.rateLimitInfo = t2, this.status = i2, this.name = "RateLimitError";
  }
  static {
    i(this, "RateLimitError");
  }
};
var Y = class extends q {
  constructor(e2, t2, i2) {
    super(`CACHE_REWRITE_BLOCKED: session idle ${Math.round(e2 / 1000)}s on model=${i2}, next request would cost ~${t2} cache_write tokens. Unset CLAUDE_MAX_REWRITE_BLOCK or raise CLAUDE_MAX_REWRITE_BLOCK_IDLE_SEC to proceed.`), this.idleMs = e2, this.estimatedTokens = t2, this.model = i2, this.name = "CacheRewriteBlockedError";
  }
  static {
    i(this, "CacheRewriteBlockedError");
  }
  code = "CACHE_REWRITE_BLOCKED";
};
var V = { "claude-opus-4-7": { name: "Claude Opus 4.7", context: 1e6, defaultOutput: 64000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 } }, "claude-opus-4-6": { name: "Claude Opus 4.6", context: 1e6, defaultOutput: 64000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 } }, "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", context: 1e6, defaultOutput: 32000, maxOutput: 128000, adaptiveThinking: true, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, "claude-haiku-4-5-20251001": { name: "Claude Haiku 4.5", context: 200000, defaultOutput: 32000, maxOutput: 64000, adaptiveThinking: false, cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } } };
var X = { defaultOutput: 32000, maxOutput: 128000, adaptiveThinking: false };
function Z(e2, t2) {
  if (typeof t2 == "number" && t2 > 0)
    return t2;
  let i2 = ee(e2), s2 = i2?.maxOutput ?? X.maxOutput, r2 = i2?.defaultOutput ?? X.defaultOutput, n2 = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  if (n2) {
    let e3 = parseInt(n2, 10);
    if (Number.isFinite(e3) && e3 > 0)
      return Math.min(e3, s2);
  }
  return r2;
}
function ee(e2) {
  if (V[e2])
    return V[e2];
  let t2 = e2.toLowerCase();
  for (let [e3, i2] of Object.entries(V))
    if (t2.includes(e3) || e3.includes(t2))
      return i2;
  for (let [e3, i2] of Object.entries(V)) {
    let s2 = e3.replace(/^claude-/, "").split("-").slice(0, 3).join("-");
    if (t2.includes(s2))
      return i2;
  }
}
function te(e2) {
  let t2 = ee(e2);
  if (t2)
    return t2.adaptiveThinking;
  let i2 = e2.toLowerCase();
  return i2.includes("opus-4-7") || i2.includes("opus-4-6") || i2.includes("sonnet-4-6") || i2.includes("sonnet-4-7");
}
i(Z, "resolveMaxTokens"), i(ee, "getModelMetadata"), i(te, "supportsAdaptiveThinking");
var pe = { cacheTtlMs: 300000, safetyMarginMs: 15000, intervalMs: 120000, intervalClampMin: 60000, retryDelaysMs: [2, 3, 5, 7, 10, 12, 15, 17, 20, 20, 20, 20, 20].map((e2) => 1000 * e2), rewriteWarnIdleMs: 300000, rewriteWarnTokens: 50000, healthProbeIntervalsMs: [3000, 5000, 7000, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4], healthProbeTimeoutMs: 3000, enabled: true, idleTimeoutMs: 1 / 0, minTokens: 2000, rewriteBlockEnabled: false };
var ye = fe(de(), ".claude", "keepalive.json");
var ge = process.env.CLAUDE_KEEPALIVE_CONFIG_PATH || ye;
var we = 0;
var ke = null;
var Te = new Set;
function _e() {
  try {
    let e2 = ce(ge);
    return e2.mtimeMs === we && ke ? null : (we = e2.mtimeMs, Te.clear(), JSON.parse(ue(ge, "utf8")));
  } catch {
    return null;
  }
}
function ve(e2, t2, i2, s2, r2) {
  if (e2 == null)
    return i2;
  let n2 = typeof e2 == "number" ? e2 : Number(e2);
  return Number.isFinite(n2) ? n2 < s2 || n2 > r2 ? (Te.has(t2) || (console.error(`[keepalive-config] ${t2}=${n2} out of range [${s2}, ${r2}] \u2014 clamping`), Te.add(t2)), Math.max(s2, Math.min(r2, n2))) : n2 : (Te.has(t2) || (console.error(`[keepalive-config] ${t2}=${JSON.stringify(e2)} is not a number \u2014 using fallback ${i2}`), Te.add(t2)), i2);
}
function Ee(e2, t2, i2, s2 = 1, r2 = 30) {
  if (e2 == null)
    return i2;
  if (!Array.isArray(e2))
    return Te.has(t2) || (console.error(`[keepalive-config] ${t2} is not an array \u2014 using fallback`), Te.add(t2)), i2;
  let n2 = e2.map((e3) => typeof e3 == "number" ? e3 : Number(e3)).filter((e3) => Number.isFinite(e3) && e3 > 0);
  return n2.length < s2 || n2.length > r2 ? (Te.has(t2) || (console.error(`[keepalive-config] ${t2} length ${n2.length} out of [${s2}, ${r2}] \u2014 using fallback`), Te.add(t2)), i2) : n2;
}
function Re(e2, t2) {
  return e2 == null ? t2 : typeof e2 == "boolean" ? e2 : typeof e2 == "string" ? e2 === "true" || e2 === "1" || e2 === "yes" : !!e2;
}
function Se() {
  let e2 = _e();
  return e2 === null && ke ? ke : $e(e2 ?? null);
}
function be() {
  return we = 0, ke = null, Se();
}
function $e(e2) {
  let t2 = e2 === null ? "defaults" : Object.keys(e2).length > 0 ? "mixed" : "defaults", i2 = ve(e2?.cacheTtlMs ?? (typeof e2?.cacheTtlSec == "number" ? 1000 * e2.cacheTtlSec : undefined), "cacheTtlMs", pe.cacheTtlMs, 60000, 7200000), s2 = ve(e2?.safetyMarginMs ?? (typeof e2?.safetyMarginSec == "number" ? 1000 * e2.safetyMarginSec : undefined), "safetyMarginMs", pe.safetyMarginMs, 1000, 300000), r2 = Math.max(60000, Math.min(i2 / 2, 1800000)), n2 = ve(e2?.intervalMs ?? (typeof e2?.intervalSec == "number" ? 1000 * e2.intervalSec : undefined), "intervalMs", r2, 60000, i2 - s2 - 1000), a2 = pe.intervalClampMin, o2 = Math.max(a2 + 1, i2 - s2 - 60000);
  n2 < a2 && (n2 = a2), n2 > o2 && (n2 = o2);
  let l2 = { cacheTtlMs: i2, safetyMarginMs: s2, intervalMs: n2, intervalClampMin: a2, intervalClampMax: o2, retryDelaysMs: Ee(e2?.retryDelaysMs ?? (Array.isArray(e2?.retryDelaysSec) ? e2.retryDelaysSec.map((e3) => typeof e3 == "number" ? 1000 * e3 : NaN) : undefined), "retryDelaysMs", pe.retryDelaysMs), rewriteWarnIdleMs: ve(e2?.rewriteWarnIdleMs ?? (typeof e2?.rewriteWarnIdleSec == "number" ? 1000 * e2.rewriteWarnIdleSec : undefined), "rewriteWarnIdleMs", Math.max(60000, i2 - s2), 1000, 86400000), rewriteWarnTokens: ve(e2?.rewriteWarnTokens, "rewriteWarnTokens", pe.rewriteWarnTokens, 100, 1e6), healthProbeIntervalsMs: Ee(e2?.healthProbeIntervalsMs, "healthProbeIntervalsMs", pe.healthProbeIntervalsMs), healthProbeTimeoutMs: ve(e2?.healthProbeTimeoutMs, "healthProbeTimeoutMs", pe.healthProbeTimeoutMs, 500, 60000), enabled: Re(e2?.enabled, pe.enabled), idleTimeoutMs: e2?.idleTimeoutMs === null || e2?.idleTimeoutSec === null ? 1 / 0 : ve(e2?.idleTimeoutMs ?? (typeof e2?.idleTimeoutSec == "number" ? 1000 * e2.idleTimeoutSec : undefined), "idleTimeoutMs", pe.idleTimeoutMs === 1 / 0 ? 86400000 : pe.idleTimeoutMs, 0, 86400000), minTokens: ve(e2?.minTokens, "minTokens", pe.minTokens, 1, 1e6), rewriteBlockEnabled: Re(e2?.rewriteBlockEnabled, pe.rewriteBlockEnabled), t: t2 };
  return ke = l2, l2;
}
function Me() {
  return ge;
}
function De() {
  return Se().cacheTtlMs;
}
function Ce() {
  return Se().safetyMarginMs;
}
function Oe(e2) {
  let t2 = e2;
  if (!t2)
    return "permanent";
  let i2 = t2.status;
  if (i2 === 401 || i2 === 403)
    return "auth";
  if (i2 === 429 || i2 === 503 || i2 === 529 || i2 && i2 >= 500)
    return "server_transient";
  if (i2 && i2 >= 400 && i2 < 500)
    return "permanent";
  let s2 = t2.code ?? t2.cause?.code ?? "", r2 = t2.name ?? t2.cause?.name ?? "", n2 = `${(t2.message ?? "").toLowerCase()} ${(t2.cause?.message ?? "").toLowerCase()}`.trim();
  return r2 === "AbortError" || r2 === "TimeoutError" || n2.includes("aborted") || n2.includes("the operation timed out") || n2.includes("request timed out") || s2 && new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_ABORTED", "ABORT_ERR", "ERR_NETWORK", "ConnectionRefused", "FailedToOpenSocket"]).has(s2) || n2.includes("unable to connect") || n2.includes("failed to open socket") || n2.includes("connection refused") || n2.includes("network is unreachable") || n2.includes("network error") || n2.includes("fetch failed") || n2.includes("timeout") || n2.includes("dns") || n2.includes("socket hang up") || n2.includes("terminated") ? "network" : "server_transient";
}
i(_e, "readRawConfig"), i(ve, "num"), i(Ee, "numArray"), i(Re, "bool"), i(Se, "loadKeepaliveConfig"), i(be, "reloadKeepaliveConfig"), i($e, "_resolve"), i(Me, "getConfigPath"), i(De, "getCacheTtlMs"), i(Ce, "getSafetyMarginMs"), i(Oe, "classifyError");
var Ae = class _KeepaliveEngine {
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
  constructor(e2) {
    this.getToken = e2.getToken, this.doFetch = e2.doFetch, this.getRateLimitInfo = e2.getRateLimitInfo, this.isOwnerAlive = e2.isOwnerAlive ?? (() => true);
    let t2 = e2.config ?? {}, i2 = Se();
    this.cacheTtlMs = i2.cacheTtlMs, this.safetyMarginMs = i2.safetyMarginMs, this.retryDelaysMs = i2.retryDelaysMs, this.healthProbeIntervalsMs = i2.healthProbeIntervalsMs, this.healthProbeTimeoutMs = i2.healthProbeTimeoutMs;
    let s2 = t2.intervalMs ?? i2.intervalMs;
    s2 < i2.intervalClampMin && (console.error(`[claude-sdk] keepalive intervalMs=${s2} below safe min (${i2.intervalClampMin}); clamped`), s2 = i2.intervalClampMin), s2 > i2.intervalClampMax && (console.error(`[claude-sdk] keepalive intervalMs=${s2} above safe max (${i2.intervalClampMax}, cacheTTL ${this.cacheTtlMs}ms - margin ${this.safetyMarginMs}ms - 60s); clamped`), s2 = i2.intervalClampMax), this.config = { enabled: t2.enabled ?? i2.enabled, intervalMs: s2, idleTimeoutMs: t2.idleTimeoutMs ?? i2.idleTimeoutMs, minTokens: t2.minTokens ?? i2.minTokens, rewriteWarnIdleMs: t2.rewriteWarnIdleMs ?? i2.rewriteWarnIdleMs, rewriteWarnTokens: t2.rewriteWarnTokens ?? i2.rewriteWarnTokens, rewriteBlockIdleMs: t2.rewriteBlockIdleMs ?? 1 / 0, rewriteBlockEnabled: t2.rewriteBlockEnabled ?? i2.rewriteBlockEnabled, onHeartbeat: t2.onHeartbeat, onTick: t2.onTick, onDisarmed: t2.onDisarmed, onRewriteWarning: t2.onRewriteWarning, onNetworkStateChange: t2.onNetworkStateChange };
  }
  notifyRealRequestStart(e2, t2, i2) {
    this.i = e2, this.o = JSON.parse(JSON.stringify(t2)), this.l = { ...i2 }, this.abortController?.abort(), this.inFlight = false;
  }
  notifyRealRequestComplete(e2) {
    let t2 = Date.now();
    if (this.lastActivityAt = t2, this.lastRealActivityAt = t2, this.cacheWrittenAt = t2, (this.healthProbeTimer || this.networkState !== "healthy") && (this.stopHealthProbe(), this.networkState !== "healthy")) {
      let e3 = this.networkState;
      this.networkState = "healthy";
      try {
        this.config.onNetworkStateChange?.({ from: e3, to: "healthy", at: t2 });
      } catch {}
    }
    if (!this.config.enabled)
      return;
    let i2 = this.i, s2 = this.o, r2 = this.l;
    if (i2 && s2 && r2) {
      let t3 = (e2.inputTokens ?? 0) + (e2.cacheReadInputTokens ?? 0) + (e2.cacheCreationInputTokens ?? 0), n2 = this.registry.get(i2);
      t3 >= this.config.minTokens && (!n2 || t3 >= n2.inputTokens) && this.registry.set(i2, { body: s2, headers: r2, model: i2, inputTokens: t3 }), t3 > (this.lastKnownCacheTokensByModel.get(i2) ?? 0) && this.lastKnownCacheTokensByModel.set(i2, t3), this.writeSnapshotDebug(i2, s2, e2), this.o = null, this.l = null;
    }
    this.registry.size > 0 && this.startTimer();
  }
  checkRewriteGuard(e2) {
    let t2 = this.cacheWrittenAt;
    if (t2 === 0)
      return;
    let i2 = Date.now() - t2, s2 = this.config.rewriteWarnIdleMs, r2 = this.config.rewriteBlockIdleMs;
    if (i2 < s2)
      return;
    let n2 = this.lastKnownCacheTokensByModel.get(e2) ?? 0, a2 = this.config.rewriteBlockEnabled && i2 >= r2;
    if (n2 >= this.config.rewriteWarnTokens || a2)
      try {
        this.config.onRewriteWarning?.({ idleMs: i2, estimatedTokens: n2, blocked: a2, model: e2 });
      } catch {}
    if (a2)
      throw new Y(i2, n2, e2);
  }
  stop() {
    this.timer && (clearInterval(this.timer), this.timer = null), this.retryTimer && (clearTimeout(this.retryTimer), this.retryTimer = null), this.abortController?.abort(), this.registry.clear(), this.inFlight = false, this.stopHealthProbe();
  }
  startTimer() {
    if (this.timer)
      return;
    let e2 = Math.min(30000, Math.max(5000, Math.floor(this.config.intervalMs / 6)));
    this.timer = setInterval(() => this.tick(), e2), this.timer && typeof this.timer == "object" && "unref" in this.timer && this.timer.unref();
  }
  async tick() {
    if (this.registry.size === 0 || this.inFlight)
      return;
    try {
      if (!this.isOwnerAlive())
        return this.registry.clear(), this.stop(), void this.onDisarmed("owner_dead");
    } catch {}
    if (this.cacheWrittenAt > 0 && Date.now() - this.cacheWrittenAt > this.cacheTtlMs)
      return this.registry.clear(), void this.onDisarmed("cache_expired_during_sleep");
    let e2 = Se();
    if (!e2.enabled)
      return this.registry.clear(), void this.stop();
    let t2 = Math.max(e2.intervalClampMin, Math.min(e2.intervalMs, e2.intervalClampMax));
    t2 !== this.config.intervalMs && (this.config.intervalMs = t2), e2.idleTimeoutMs !== this.config.idleTimeoutMs && (this.config.idleTimeoutMs = e2.idleTimeoutMs), e2.minTokens !== this.config.minTokens && (this.config.minTokens = e2.minTokens);
    let i2 = Date.now() - this.lastRealActivityAt;
    if (this.config.idleTimeoutMs !== 1 / 0 && i2 > this.config.idleTimeoutMs)
      return this.registry.clear(), void this.stop();
    let s2 = null;
    for (let e3 of this.registry.values())
      (!s2 || e3.inputTokens > s2.inputTokens) && (s2 = e3);
    if (!s2)
      return;
    let r2 = Date.now() - this.lastActivityAt;
    if (this.jitterMs || (this.jitterMs = Math.floor(30000 * Math.random())), r2 < 0.9 * this.config.intervalMs + this.jitterMs)
      this.config.onTick?.({ idleMs: r2, nextFireMs: Math.max(0, this.config.intervalMs - r2), model: s2.model, tokens: s2.inputTokens });
    else {
      this.inFlight = true;
      try {
        let e3 = await this.getToken(), t3 = JSON.parse(JSON.stringify(s2.body)), i3 = t3.thinking?.budget_tokens ?? 0;
        t3.max_tokens = i3 > 0 ? i3 + 1 : 1;
        let n2 = { ...s2.headers, Authorization: `Bearer ${e3}` }, a2 = new AbortController;
        this.abortController = a2;
        let o2 = Date.now(), l2 = { inputTokens: 0, outputTokens: 0 };
        for await (let e4 of this.doFetch(t3, n2, a2.signal))
          e4.type === "message_stop" && (l2 = e4.usage);
        let h2 = Date.now() - o2;
        this.lastActivityAt = Date.now(), this.cacheWrittenAt = Date.now();
        let c2 = this.getRateLimitInfo();
        this.config.onHeartbeat?.({ usage: l2, durationMs: h2, idleMs: r2, model: s2.model, rateLimit: { status: c2.status, claim: c2.claim, resetAt: c2.resetAt } });
      } catch (e3) {
        let t3 = Oe(e3);
        if (t3 === "network") {
          let e4 = Date.now() - this.cacheWrittenAt, t4 = this.cacheTtlMs - e4 <= this.safetyMarginMs;
          this.onDisarmed("network_error"), this.startHealthProbe({ reviveMode: t4 });
        } else
          t3 === "server_transient" ? this.retryChain(s2) : t3 === "auth" ? (this.registry.clear(), this.onDisarmed("auth_error")) : (this.registry.clear(), this.onDisarmed("permanent_error"));
      } finally {
        this.inFlight = false, this.abortController = null;
      }
    }
  }
  retryChain(e2, t2 = 0) {
    if (t2 >= this.retryDelaysMs.length)
      return this.registry.clear(), void this.onDisarmed("retry_exhausted");
    let i2 = Date.now() - this.cacheWrittenAt, s2 = this.cacheTtlMs - i2, r2 = 1000 * this.retryDelaysMs[t2];
    if (s2 < r2 + this.safetyMarginMs) {
      this.registry.clear();
      let e3 = i2 < this.cacheTtlMs / 2 ? "retry_budget_exceeds_ttl" : "cache_ttl_exhausted";
      return void this.onDisarmed(e3);
    }
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try {
        if (!this.isOwnerAlive())
          return this.registry.clear(), this.stop(), void this.onDisarmed("owner_dead");
      } catch {}
      if (!(this.lastRealActivityAt > this.cacheWrittenAt)) {
        if (Date.now() - this.cacheWrittenAt > this.cacheTtlMs - this.safetyMarginMs)
          return this.registry.clear(), void this.onDisarmed("cache_ttl_expired_mid_retry");
        this.inFlight = true;
        try {
          let t3 = await this.getToken(), i3 = JSON.parse(JSON.stringify(e2.body)), s3 = i3.thinking?.budget_tokens ?? 0;
          i3.max_tokens = s3 > 0 ? s3 + 1 : 1;
          let r3 = { ...e2.headers, Authorization: `Bearer ${t3}` }, n2 = new AbortController;
          this.abortController = n2;
          for await (let e3 of this.doFetch(i3, r3, n2.signal))
            ;
          this.lastActivityAt = Date.now(), this.cacheWrittenAt = Date.now();
        } catch (i3) {
          let s3 = Oe(i3);
          if (s3 === "network") {
            this.inFlight = false, this.abortController = null;
            let e3 = this.cacheTtlMs - (Date.now() - this.cacheWrittenAt) <= this.safetyMarginMs;
            return this.onDisarmed("network_error_mid_retry"), void this.startHealthProbe({ reviveMode: e3 });
          }
          if (s3 === "server_transient")
            return this.inFlight = false, this.abortController = null, void this.retryChain(e2, t2 + 1);
          this.registry.clear(), this.onDisarmed("permanent_error_mid_retry");
        } finally {
          this.inFlight = false, this.abortController = null;
        }
      }
    }, r2);
  }
  onDisarmed(e2) {
    this.abortController?.abort(), this.abortController = null, this.inFlight = false, this.retryTimer && (clearTimeout(this.retryTimer), this.retryTimer = null);
    try {
      this.config.onDisarmed?.({ reason: e2, at: Date.now() });
    } catch {}
    if (new Set(["retry_exhausted", "cache_ttl_exhausted", "cache_ttl_expired_mid_retry", "retry_budget_exceeds_ttl"]).has(e2) && !this.healthProbeTimer) {
      let e3 = Date.now() - this.cacheWrittenAt, t2 = this.cacheTtlMs - e3 <= this.safetyMarginMs;
      this.startHealthProbe({ reviveMode: t2 });
    }
  }
  startHealthProbe(e2 = {}) {
    if (this.healthProbeTimer)
      return;
    this.healthProbeAttempt = 0;
    let t2 = this.networkState;
    if (this.networkState = "degraded", t2 !== "degraded")
      try {
        this.config.onNetworkStateChange?.({ from: t2, to: "degraded", at: Date.now() });
      } catch {}
    let s2 = i(() => {
      let e3 = this.healthProbeIntervalsMs, t3 = e3[Math.min(this.healthProbeAttempt, e3.length - 1)];
      this.healthProbeTimer = setTimeout(r2, t3), this.healthProbeTimer && typeof this.healthProbeTimer == "object" && "unref" in this.healthProbeTimer && this.healthProbeTimer.unref();
    }, "scheduleNext"), r2 = i(async () => {
      if (this.healthProbeTimer = null, this.healthProbeAttempt++, Date.now() - this.cacheWrittenAt >= this.cacheTtlMs - this.safetyMarginMs && !e2.reviveMode)
        return void this.stopHealthProbe();
      if (this.healthProbeAttempt > this.healthProbeIntervalsMs.length)
        return void this.stopHealthProbe();
      let t3 = false;
      try {
        let { connect: e3 } = await import("net");
        await new Promise((t4, i3) => {
          let s3 = e3({ host: "api.anthropic.com", port: 443 }), r4 = setTimeout(() => {
            s3.destroy(), i3(new Error("timeout"));
          }, this.healthProbeTimeoutMs);
          s3.once("connect", () => {
            clearTimeout(r4), s3.end(), t4();
          }), s3.once("error", (e4) => {
            clearTimeout(r4), i3(e4);
          });
        }), t3 = true;
      } catch {
        t3 = false;
      }
      if (!t3)
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
  writeSnapshotDebug(e2, t2, i2) {
    try {
      let s2 = he(le(), ".claude", "snapshots");
      ie(s2, { recursive: true });
      try {
        let e3 = Date.now() - _KeepaliveEngine.SNAPSHOT_TTL_MS;
        for (let t3 of se(s2)) {
          let i3 = he(s2, t3);
          re(i3).mtimeMs < e3 && ne(i3);
        }
      } catch {}
      this.snapshotCallCount++;
      let { messages: r2, system: n2, tools: a2 } = t2, o2 = typeof n2 == "string" ? n2 : JSON.stringify(n2), l2 = oe("md5").update(o2).digest("hex").slice(0, 8), h2 = { ts: new Date().toISOString(), pid: process.pid, callNum: this.snapshotCallCount, model: e2, messages: r2?.length ?? 0, tools: a2?.length ?? 0, sysHash: l2, sysLen: o2.length, usage: { input: i2.inputTokens ?? 0, cacheRead: i2.cacheReadInputTokens ?? 0, cacheWrite: i2.cacheCreationInputTokens ?? 0 }, firstMsg: r2?.[0] ? { role: r2[0].role, contentLen: JSON.stringify(r2[0].content).length, contentHash: oe("md5").update(JSON.stringify(r2[0].content)).digest("hex").slice(0, 8) } : null, lastMsg: r2?.length ? { role: r2[r2.length - 1].role, contentLen: JSON.stringify(r2[r2.length - 1].content).length } : null, toolsHash: a2?.length ? oe("md5").update(JSON.stringify(a2.map((e3) => e3.name ?? "").join(","))).digest("hex").slice(0, 8) : null }, c2 = `${process.pid}-${Date.now()}.json`;
      if (ae(he(s2, c2), JSON.stringify(h2, null, 2) + `
`), _KeepaliveEngine.DUMP_BODY || this.snapshotCallCount <= 3) {
        let e3 = he(s2, "bodies");
        ie(e3, { recursive: true });
        let i3 = `${process.pid}-call${this.snapshotCallCount}-${Date.now()}.json`;
        ae(he(e3, i3), JSON.stringify(t2, null, 2) + `
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
  k(e2) {
    this.lastRealActivityAt = e2;
  }
  T(e2) {
    this.cacheWrittenAt = e2;
  }
  get _() {
    return this.cacheWrittenAt;
  }
  v(e2, t2, i2) {
    this.i = e2, this.o = t2, this.l = i2;
  }
};
var Ne = 300000;
var Ie = 0.25;
var xe = 300000;
var Le = 1200000;
var Fe = j(K(), ".claude", ".refresh-cooldown");
var Pe = 1800000;
var Ue = "2.1.90";
var Be = { todowrite: "todo_write" };
var Je = Object.fromEntries(Object.entries(Be).map(([e2, t2]) => [t2, e2]));
function We(e2) {
  if (!e2?.length)
    return { remapped: e2, didRemap: false };
  let t2 = false;
  return { remapped: e2.map((e3) => {
    let i2 = Be[e3.name];
    return i2 ? (t2 = true, { ...e3, name: i2 }) : e3;
  }), didRemap: t2 };
}
function He(e2) {
  return Je[e2] ?? e2;
}
i(We, "remapToolNames"), i(He, "unremapToolName");
var je = j(K(), ".claude", ".token-refresh-lock");
async function Ke() {
  for (let e2 = 0;e2 < 30; e2++)
    try {
      return U(je), F(j(je, "pid"), `${process.pid}
${Date.now()}`), () => {
        try {
          W(j(je, "pid")), B(je);
        } catch {}
      };
    } catch (e3) {
      if (e3.code === "EEXIST") {
        try {
          let e4 = L(j(je, "pid"), "utf8"), t2 = parseInt(e4.split(`
`)[1] ?? "0");
          if (Date.now() - t2 > 30000) {
            try {
              W(j(je, "pid"));
            } catch {}
            try {
              B(je);
            } catch {}
            continue;
          }
        } catch {}
        await new Promise((e4) => setTimeout(e4, 1000 + 1000 * Math.random()));
        continue;
      }
      return null;
    }
  return null;
}
async function qe(e2, t2, i2) {
  let s2 = Date.now() + t2;
  for (;Date.now() < s2; ) {
    try {
      let t3 = await e2.read();
      if (t3 && t3.expiresAt - Date.now() >= i2)
        return { accessToken: t3.accessToken, refreshToken: t3.refreshToken, expiresAt: t3.expiresAt };
    } catch {}
    await new Promise((e3) => setTimeout(e3, 500));
  }
  return null;
}
i(Ke, "acquireTokenRefreshLock"), i(qe, "pollDiskForFreshToken");
var ze = class {
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
  keepalive;
  R = null;
  constructor(e2 = {}) {
    this.sessionId = x(), this.deviceId = e2.deviceId ?? I(32).toString("hex"), this.accountUuid = e2.accountUuid ?? this.readAccountUuid(), this.timeout = e2.timeout ?? 600000, this.maxRetries = e2.maxRetries ?? 10, this.onTokenStatus = e2.onTokenStatus, this.keepalive = new Ae({ config: e2.keepalive, getToken: i(async () => (await this.ensureAuth(), this.accessToken ?? ""), "getToken"), doFetch: i((e3, t2, i2) => this.doStreamRequest(e3, t2, i2), "doFetch"), getRateLimitInfo: i(() => this.lastRateLimitInfo, "getRateLimitInfo") }), e2.credentialStore ? this.credentialStore = e2.credentialStore : e2.accessToken ? (this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken ?? null, this.expiresAt = e2.expiresAt ?? null, this.credentialStore = new Qe({ accessToken: e2.accessToken, refreshToken: e2.refreshToken ?? "", expiresAt: e2.expiresAt ?? 0 }), this.expiresAt && this.refreshToken && this.scheduleProactiveRotation()) : (this.credentialStore = new Ge(e2.credentialsPath ?? j(K(), ".claude", ".credentials.json")), this.initialLoad = this.loadFromStore().catch(() => {}));
  }
  async generate(e2) {
    let t2 = [];
    for await (let i2 of this.stream(e2))
      t2.push(i2);
    return this.assembleResponse(t2, e2.model);
  }
  async* stream(e2) {
    this.keepalive.checkRewriteGuard(e2.model), await this.ensureAuth();
    let t2, i2 = this.buildRequestBody(e2), s2 = this.buildHeaders(e2);
    this.keepalive.notifyRealRequestStart(e2.model, i2, s2), this.R = null;
    for (let r2 = 1;r2 <= this.maxRetries + 1; r2++) {
      if (e2.signal?.aborted)
        throw new q("Aborted");
      try {
        return yield* this.doStreamRequest(i2, s2, e2.signal), void (this.R && (this.keepalive.notifyRealRequestComplete(this.R), this.R = null));
      } catch (i3) {
        if (t2 = i3, i3 instanceof G) {
          if (i3.status === 401 && r2 <= this.maxRetries) {
            await this.handleAuth401(), s2.Authorization = `Bearer ${this.accessToken}`;
            continue;
          }
          if (i3.status === 429)
            throw i3 instanceof Q ? i3 : new Q("Rate limited", this.lastRateLimitInfo, 429, i3);
          if (i3.status >= 500 && r2 <= this.maxRetries) {
            let t3 = this.getRetryDelay(r2, this.lastRateLimitInfo.retryAfter?.toString() ?? null);
            await this.sleep(t3, e2.signal);
            continue;
          }
        }
        throw i3;
      }
    }
    throw t2;
  }
  getRateLimitInfo() {
    return this.lastRateLimitInfo;
  }
  async* doStreamRequest(e2, t2, i2) {
    let r2 = new AbortController, n2 = setTimeout(() => r2.abort(), this.timeout);
    i2 && i2.addEventListener("abort", () => r2.abort(), { once: true });
    let a2, o2 = Date.now(), l2 = JSON.stringify(e2);
    try {
      let { appendFileSync: i3 } = s("fs");
      i3(j(K(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_START pid=${process.pid} model=${e2.model} msgs=${e2.messages?.length ?? 0}
`);
      let r3 = e2.tools?.map((e3) => e3.name).join(",") ?? "none", n3 = typeof e2.system == "string" ? e2.system.substring(0, 200) : JSON.stringify(e2.system)?.substring(0, 200);
      if (i3(j(K(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_REQ pid=${process.pid} headers=${JSON.stringify(t2).substring(0, 300)} tools=[${r3.substring(0, 500)}] sys=${n3} bodyLen=${l2.length}
`), process.env.CLAUDE_MAX_DUMP_REQUESTS === "1") {
        let s2 = { ...e2, messages: `[${e2.messages?.length ?? 0} messages]`, system: `[${typeof e2.system == "string" ? e2.system.length : "array"}]` };
        i3(j(K(), ".claude", "claude-max-request-dump.jsonl"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, headers: t2, body: s2 }) + `
`);
      }
    } catch {}
    try {
      a2 = await fetch("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", headers: t2, body: l2, signal: r2.signal });
    } catch (e3) {
      clearTimeout(n2);
      try {
        let { appendFileSync: t3 } = s("fs");
        t3(j(K(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_ERROR pid=${process.pid} ttfb=${Date.now() - o2}ms err=${e3.message}
`);
      } catch {}
      throw new q("Network error", e3);
    }
    clearTimeout(n2);
    try {
      let { appendFileSync: e3 } = s("fs"), t3 = {};
      a2.headers.forEach((e4, i4) => {
        t3[i4] = e4;
      });
      let i3 = { ts: new Date().toISOString(), pid: process.pid, status: a2.status, statusText: a2.statusText, ttfbMs: Date.now() - o2, headers: t3 };
      e3(j(K(), ".claude", "claude-max-api-responses.log"), JSON.stringify(i3) + `
`), e3(j(K(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_RESPONSE pid=${process.pid} status=${a2.status} ttfb=${Date.now() - o2}ms
`);
    } catch {}
    if (this.lastRateLimitInfo = this.parseRateLimitHeaders(a2.headers), !a2.ok) {
      let e3 = "";
      try {
        e3 = await a2.text();
      } catch {}
      let t3 = a2.headers.get("request-id");
      try {
        let { appendFileSync: i3 } = s("fs"), r3 = {};
        a2.headers.forEach((e4, t4) => {
          r3[t4] = e4;
        }), i3(j(K(), ".claude", "claude-max-api-responses.log"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, type: "ERROR", status: a2.status, requestId: t3, headers: r3, body: e3.slice(0, 5000), rateLimitInfo: this.lastRateLimitInfo }) + `
`);
      } catch {}
      throw a2.status === 429 ? new Q(`Rate limited: ${e3}`, this.lastRateLimitInfo, 429) : new G(`API error ${a2.status}: ${e3}`, a2.status, t3);
    }
    if (!a2.body)
      throw new q("No response body");
    yield* this.parseSSE(a2.body, i2);
  }
  async* parseSSE(e2, t2) {
    let i2 = new TextDecoder, r2 = e2.getReader(), n2 = "", a2 = new Map, o2 = { inputTokens: 0, outputTokens: 0 }, l2 = null;
    try {
      for (;; ) {
        if (t2?.aborted)
          return void r2.cancel();
        let { done: e3, value: h2 } = await r2.read();
        if (e3)
          break;
        n2 += i2.decode(h2, { stream: true });
        let c2 = n2.split(`
`);
        n2 = c2.pop() ?? "";
        for (let e4 of c2) {
          if (!e4.startsWith("data: "))
            continue;
          let t3, i3 = e4.slice(6);
          if (i3 === "[DONE]")
            continue;
          try {
            t3 = JSON.parse(i3);
          } catch {
            continue;
          }
          let r3 = t3.type;
          if (r3 === "message_start") {
            try {
              let { appendFileSync: e6 } = s("fs"), { join: i4 } = s("path"), { homedir: r4 } = s("os");
              e6(i4(r4(), ".claude", "claude-max-headers.log"), `[${new Date().toISOString()}] MESSAGE_START: ${JSON.stringify(t3).slice(0, 2000)}
`);
            } catch {}
            let e5 = t3.message?.usage;
            if (e5) {
              o2 = { inputTokens: e5.input_tokens ?? 0, outputTokens: e5.output_tokens ?? 0, cacheCreationInputTokens: e5.cache_creation_input_tokens, cacheReadInputTokens: e5.cache_read_input_tokens };
              try {
                H(j(K(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] RAW_USAGE: ${JSON.stringify(e5)}
`);
              } catch {}
            }
            continue;
          }
          if (r3 === "content_block_start") {
            let { index: e5, content_block: i4 } = t3;
            if (i4.type === "tool_use") {
              let t4 = He(i4.name);
              a2.set(e5, { type: "tool_use", id: i4.id, name: t4, input: "" }), yield { type: "tool_use_start", id: i4.id, name: t4 };
            } else
              i4.type === "text" ? a2.set(e5, { type: "text", text: "" }) : i4.type === "thinking" && a2.set(e5, { type: "thinking", thinking: "", signature: i4.signature ?? undefined });
            continue;
          }
          if (r3 === "content_block_delta") {
            let e5 = t3.index, i4 = a2.get(e5), s2 = t3.delta;
            s2.type === "text_delta" && s2.text !== undefined ? (i4 && (i4.text = (i4.text ?? "") + s2.text), s2.text && (yield { type: "text_delta", text: s2.text })) : s2.type === "thinking_delta" && s2.thinking !== undefined ? (i4 && (i4.thinking = (i4.thinking ?? "") + s2.thinking), s2.thinking && (yield { type: "thinking_delta", text: s2.thinking })) : s2.type === "signature_delta" && s2.signature !== undefined ? i4 && (i4.signature = (i4.signature ?? "") + s2.signature) : s2.type === "input_json_delta" && s2.partial_json !== undefined && (i4 && (i4.input = (i4.input ?? "") + s2.partial_json), s2.partial_json && (yield { type: "tool_use_delta", partialInput: s2.partial_json }));
            continue;
          }
          if (r3 === "content_block_stop") {
            let e5 = t3.index, i4 = a2.get(e5);
            if (i4?.type === "tool_use" && i4.id && i4.name) {
              let e6 = {};
              try {
                e6 = JSON.parse(i4.input ?? "{}");
              } catch {}
              yield { type: "tool_use_end", id: i4.id, name: i4.name, input: e6 };
            }
            if (i4?.type === "thinking") {
              let e6 = t3.signature ?? t3.content_block?.signature;
              e6 && (i4.signature = e6), yield { type: "thinking_end", signature: i4.signature ?? undefined };
            }
            continue;
          }
          if (r3 === "message_delta") {
            let e5 = t3.delta;
            e5?.stop_reason && (l2 = e5.stop_reason);
            let i4 = t3.usage;
            i4?.output_tokens && (o2 = { ...o2, outputTokens: i4.output_tokens });
            continue;
          }
          r3 === "message_stop" && (this.R = o2, yield { type: "message_stop", usage: o2, stopReason: l2 });
        }
      }
    } finally {
      r2.releaseLock();
    }
  }
  stopKeepalive() {
    this.keepalive.stop(), this.tokenRotationTimer && (clearTimeout(this.tokenRotationTimer), this.tokenRotationTimer = null);
  }
  buildHeaders(e2) {
    let t2 = this.buildBetas(e2);
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}`, "anthropic-version": "2023-06-01", "anthropic-beta": t2.join(","), "anthropic-dangerous-direct-browser-access": "true", "x-app": "cli", "User-Agent": `claude-cli/${Ue}`, "X-Claude-Code-Session-Id": this.sessionId };
  }
  buildRequestBody(e2) {
    let t2, i2 = this.computeFingerprint(e2.messages), s2 = `x-anthropic-billing-header: cc_version=${Ue}.${i2}; cc_entrypoint=cli; cch=00000;`;
    t2 = (typeof e2.system == "string" ? e2.system : Array.isArray(e2.system) ? JSON.stringify(e2.system) : "").includes("x-anthropic-billing-header") ? e2.system : typeof e2.system == "string" ? s2 + `
` + e2.system : Array.isArray(e2.system) ? [{ type: "text", text: s2 }, ...e2.system] : s2;
    let r2 = { model: e2.model, messages: e2.messages, max_tokens: Z(e2.model, e2.maxTokens), stream: true, system: t2, metadata: { user_id: JSON.stringify({ device_id: this.deviceId, account_uuid: this.accountUuid, session_id: this.sessionId }) } };
    if (e2.tools && e2.tools.length > 0) {
      let { remapped: t3 } = We(e2.tools);
      if (r2.tools = t3, e2.toolChoice) {
        let t4 = typeof e2.toolChoice == "string" ? { type: e2.toolChoice } : { ...e2.toolChoice };
        t4.type === "tool" && t4.name && Be[t4.name] && (t4.name = Be[t4.name]), r2.tool_choice = t4;
      }
    }
    e2.caching !== false && this.addCacheMarkers(r2);
    let n2 = e2.model.toLowerCase(), a2 = n2.includes("opus-4-6") || n2.includes("sonnet-4-6") || n2.includes("opus-4-7") || n2.includes("sonnet-4-7"), o2 = e2.thinking?.type === "disabled";
    return !o2 && a2 ? r2.thinking = { type: "adaptive" } : e2.thinking?.type === "enabled" && (r2.thinking = { type: "enabled", budget_tokens: e2.thinking.budgetTokens }), !(!o2 && (a2 || e2.thinking?.type === "enabled")) && e2.temperature !== undefined && (r2.temperature = e2.temperature), e2.topP !== undefined && (r2.top_p = e2.topP), e2.effort && a2 && (r2.output_config = { effort: e2.effort }), e2.stopSequences?.length && (r2.stop_sequences = e2.stopSequences), e2.fast && (r2.speed = "fast"), r2;
  }
  addCacheMarkers(e2) {
    let t2 = { cache_control: { type: "ephemeral", ttl: "1h" } }, i2 = e2.system;
    if (typeof i2 == "string")
      e2.system = [{ type: "text", text: i2, ...t2 }];
    else if (Array.isArray(i2)) {
      let e3 = i2;
      e3.length > 0 && (e3[e3.length - 1] = { ...e3[e3.length - 1], ...t2 });
    }
    let s2 = e2.tools;
    s2 && s2.length > 0 && (s2[s2.length - 1] = { ...s2[s2.length - 1], ...t2 });
    let r2 = e2.messages;
    if (r2.length === 0)
      return;
    let n2 = r2[r2.length - 1];
    if (typeof n2.content == "string")
      n2.content = [{ type: "text", text: n2.content, ...t2 }];
    else if (Array.isArray(n2.content) && n2.content.length > 0) {
      let e3 = n2.content[n2.content.length - 1];
      n2.content[n2.content.length - 1] = { ...e3, ...t2 };
    }
  }
  buildBetas(e2) {
    let t2 = [], i2 = e2.model.toLowerCase().includes("haiku");
    return i2 || t2.push("claude-code-20250219"), t2.push("oauth-2025-04-20"), /\[1m\]/i.test(e2.model) && t2.push("context-1m-2025-08-07"), !i2 && e2.thinking?.type !== "disabled" && t2.push("interleaved-thinking-2025-05-14"), e2.effort && t2.push("effort-2025-11-24"), e2.fast && t2.push("fast-mode-2026-02-01"), i2 || t2.push("context-management-2025-06-27"), t2.push("task-budgets-2026-03-13"), t2.push("redact-thinking-2026-02-12"), t2.push("prompt-caching-scope-2026-01-05"), t2.push("fine-grained-tool-streaming-2025-05-14"), e2.extraBetas && t2.push(...e2.extraBetas), t2;
  }
  async ensureAuth() {
    if (!this.accessToken || this.isTokenExpired())
      return this.pendingAuth || (this.pendingAuth = this.S().finally(() => {
        this.pendingAuth = null;
      })), this.pendingAuth;
  }
  async S() {
    this.credentialStore.hasChanged && await this.credentialStore.hasChanged() && await this.loadFromStore(), (!this.accessToken || this.isTokenExpired()) && (!this.accessToken && (await this.loadFromStore(), this.accessToken && !this.isTokenExpired()) || this.accessToken && this.isTokenExpired() && await this.refreshTokenWithTripleCheck());
  }
  async loadFromStore() {
    let e2 = await this.credentialStore.read();
    if (!e2?.accessToken)
      throw new z('No OAuth tokens found. Run "claude login" first or provide credentials.');
    this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken, this.expiresAt = e2.expiresAt, !this.tokenIssuedAt && this.expiresAt && (this.tokenIssuedAt = Date.now()), this.scheduleProactiveRotation();
  }
  isTokenExpired() {
    return !!this.expiresAt && Date.now() + Ne >= this.expiresAt;
  }
  async forceRefreshToken() {
    if (this.dbg("FORCE REFRESH requested by caller"), this.initialLoad && await this.initialLoad, !this.refreshToken)
      try {
        await this.loadFromStore();
      } catch {}
    this.clearRefreshCooldown(), this.lastRefreshAttemptAt = 0;
    try {
      return await this.doTokenRefresh(true), this.proactiveRefreshFailures = 0, this.refreshConsecutive429s = 0, this.emitTokenStatus("rotated", "Token force-refreshed successfully"), this.scheduleProactiveRotation(), true;
    } catch (e2) {
      let t2 = e2?.message ?? String(e2);
      return this.dbg(`FORCE REFRESH FAILED: ${t2}`), this.emitTokenStatus("warning", `Force refresh failed: ${t2}`), false;
    }
  }
  async forceReLogin() {
    this.initialLoad && await this.initialLoad, this.dbg("FORCE RE-LOGIN requested \u2014 opening browser OAuth flow"), this.emitTokenStatus("critical", "Initiating browser re-login \u2014 refresh token may be dead");
    try {
      let { oauthLogin: e2 } = await Promise.resolve().then(() => (A(), r)), t2 = this.credentialStore instanceof Ge ? this.credentialStore.path : j(K(), ".claude", ".credentials.json"), i2 = await e2({ credentialsPath: t2 });
      return this.accessToken = i2.accessToken, this.refreshToken = i2.refreshToken, this.expiresAt = i2.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.refreshConsecutive429s = 0, this.clearRefreshCooldown(), this.emitTokenStatus("rotated", "Re-login successful \u2014 fresh tokens"), this.scheduleProactiveRotation(), this.dbg(`RE-LOGIN SUCCESS \u2014 new token expires at ${new Date(this.expiresAt).toISOString()}`), true;
    } catch (e2) {
      let t2 = e2?.message ?? String(e2);
      return this.dbg(`RE-LOGIN FAILED: ${t2}`), this.emitTokenStatus("expired", `Re-login failed: ${t2}`), false;
    }
  }
  getTokenHealth() {
    if (!this.expiresAt)
      return { expiresAt: null, expiresInMs: 0, lifetimePct: 0, failedRefreshes: this.proactiveRefreshFailures, status: "unknown" };
    let e2, t2 = Date.now(), i2 = this.expiresAt - t2, s2 = this.tokenIssuedAt > 0 ? this.expiresAt - this.tokenIssuedAt : 2 * i2, r2 = s2 > 0 ? Math.max(0, i2 / s2) : 0;
    return e2 = i2 <= 0 ? "expired" : r2 < 0.1 ? "critical" : r2 < Ie ? "warning" : "healthy", { expiresAt: this.expiresAt, expiresInMs: i2, lifetimePct: r2, failedRefreshes: this.proactiveRefreshFailures, status: e2 };
  }
  async getTokenHealthAsync() {
    return this.initialLoad && await this.initialLoad, this.getTokenHealth();
  }
  scheduleProactiveRotation() {
    if (this.tokenRotationTimer && (clearTimeout(this.tokenRotationTimer), this.tokenRotationTimer = null), !this.expiresAt || !this.refreshToken)
      return;
    let e2 = Date.now(), t2 = this.expiresAt - e2;
    if (t2 <= 0)
      return void this.emitTokenStatus("expired", "Token has expired");
    let i2 = Math.max(0.8 * t2, xe), s2 = Math.floor(60000 * Math.random()), r2 = Math.min(i2 + s2, t2 - Ne);
    if (r2 <= 0)
      return this.dbg(`proactive rotation: delay=${r2}ms <= 0, scheduling emergency refresh in 30s`), void (this.tokenRotationTimer || (this.tokenRotationTimer = setTimeout(() => {
        this.tokenRotationTimer = null, this.proactiveRefresh();
      }, 30000), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && ("unref" in this.tokenRotationTimer) && this.tokenRotationTimer.unref()));
    let n2 = this.tokenIssuedAt > 0 ? this.expiresAt - this.tokenIssuedAt : 2 * t2, a2 = n2 > 0 ? t2 / n2 : 1;
    a2 < 0.1 && this.proactiveRefreshFailures > 0 ? (this.dbg(`\u26A0\uFE0F CRITICAL: token ${Math.round(100 * a2)}% life left, ${this.proactiveRefreshFailures} failed refreshes`), this.emitTokenStatus("critical", `Token ${Math.round(100 * a2)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)) : a2 < Ie && this.proactiveRefreshFailures > 0 && (this.dbg(`\u26A0 WARNING: token ${Math.round(100 * a2)}% life left, ${this.proactiveRefreshFailures} failed refreshes`), this.emitTokenStatus("warning", `Token ${Math.round(100 * a2)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)), this.dbg(`proactive rotation scheduled in ${Math.round(r2 / 1000)}s (expires in ${Math.round(t2 / 1000)}s, ${Math.round(100 * a2)}% life, failures=${this.proactiveRefreshFailures})`), this.tokenRotationTimer = setTimeout(() => {
      this.tokenRotationTimer = null, this.proactiveRefresh();
    }, r2), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && "unref" in this.tokenRotationTimer && this.tokenRotationTimer.unref();
  }
  async proactiveRefresh() {
    if (this.isRefreshOnCooldown()) {
      try {
        let e3 = await this.credentialStore.read();
        if (e3 && !(Date.now() + Ne >= e3.expiresAt)) {
          let t3 = e3.expiresAt - Date.now();
          if (t3 >= Le)
            return this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.dbg(`proactive refresh: picked up fresh token during cooldown (${Math.round(t3 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(t3 / 60000)}min remaining)`), void this.scheduleProactiveRotation();
          this.dbg(`proactive refresh: disk token has only ${Math.round(t3 / 60000)}min left (need ${Math.round(20)}min) \u2014 waiting for cooldown`);
        }
      } catch {}
      if (this.dbg("proactive refresh skipped: global cooldown active, no fresh token found"), !this.tokenRotationTimer) {
        let e3 = Math.max(xe, 60000);
        this.tokenRotationTimer = setTimeout(() => {
          this.tokenRotationTimer = null, this.proactiveRefresh();
        }, e3), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && "unref" in this.tokenRotationTimer && this.tokenRotationTimer.unref();
      }
      return;
    }
    let e2 = Date.now();
    if (e2 - this.lastRefreshAttemptAt < xe)
      return void this.dbg("proactive refresh skipped: too recent");
    this.lastRefreshAttemptAt = e2, this.dbg("proactive rotation: refreshing token silently...");
    let t2 = await Ke();
    if (!t2) {
      this.dbg("proactive rotation: lock unavailable (another PID refreshing) \u2014 polling disk");
      let e3 = await qe(this.credentialStore, 45000, Le);
      if (e3) {
        this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0;
        let t3 = e3.expiresAt - Date.now();
        this.dbg(`proactive rotation: picked up fresh token from disk (${Math.round(t3 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(t3 / 60000)}min remaining)`);
      } else
        this.dbg("proactive rotation: lock unavailable and no fresh token appeared \u2014 will retry on next schedule");
      return void this.scheduleProactiveRotation();
    }
    try {
      let e3 = await this.credentialStore.read();
      if (e3 && !(Date.now() + Ne >= e3.expiresAt)) {
        let t4 = e3.expiresAt - Date.now();
        if (t4 >= Le)
          return this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.dbg(`proactive rotation: picked up fresh token from lock winner (${Math.round(t4 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(t4 / 60000)}min remaining)`), void this.scheduleProactiveRotation();
      }
      let t3 = this.expiresAt ?? 0;
      await this.doTokenRefresh(true), this.proactiveRefreshFailures = 0, this.refreshConsecutive429s = 0, this.clearRefreshCooldown(), this.tokenIssuedAt = Date.now();
      let i2 = (this.expiresAt ?? 0) - Date.now(), s2 = t3 > 0 ? t3 - (this.tokenIssuedAt - 1000) : 2 * i2;
      i2 > 0 && i2 < 0.5 * s2 && this.dbg(`\u26A0\uFE0F SHRINKING TOKEN: new ${Math.round(i2 / 60000)}min vs prev ${Math.round(s2 / 60000)}min \u2014 backing off rotation`), this.dbg(`proactive rotation SUCCESS \u2014 new token expires at ${new Date(this.expiresAt).toISOString()} (${Math.round(i2 / 60000)}min lifetime)`), this.emitTokenStatus("rotated", `Token rotated silently \u2014 expires ${new Date(this.expiresAt).toISOString()}`), this.scheduleProactiveRotation();
    } catch (e3) {
      this.proactiveRefreshFailures++;
      let t3 = e3?.message ?? String(e3);
      if (this.dbg(`proactive rotation FAILED (#${this.proactiveRefreshFailures}): ${t3}`), t3.includes("429") || t3.includes("rate limit")) {
        this.refreshConsecutive429s++;
        let e4 = Math.min(xe * Math.pow(2, this.refreshConsecutive429s), Pe);
        this.setRefreshCooldown(e4), this.dbg(`proactive rotation: 429 cooldown ${Math.round(e4 / 1000)}s (attempt #${this.refreshConsecutive429s})`);
      }
      let i2 = this.expiresAt ? this.expiresAt - Date.now() : 0, s2 = this.tokenIssuedAt > 0 && this.expiresAt ? this.expiresAt - this.tokenIssuedAt : 2 * i2, r2 = s2 > 0 ? i2 / s2 : 0;
      i2 <= Ne ? this.emitTokenStatus("expired", `Token expired after ${this.proactiveRefreshFailures} failed refresh attempts: ${t3}`) : r2 < 0.1 ? this.emitTokenStatus("critical", `CRITICAL: ${Math.round(i2 / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${t3}. Consider forceReLogin()`) : r2 < Ie && this.emitTokenStatus("warning", `WARNING: ${Math.round(i2 / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${t3}`), this.expiresAt && this.expiresAt > Date.now() + Ne ? this.scheduleProactiveRotation() : (this.dbg("proactive rotation: token nearly expired \u2014 emitting expired status"), this.emitTokenStatus("expired", `Token expired \u2014 refresh failed ${this.proactiveRefreshFailures} times. Call forceReLogin() to recover.`));
    } finally {
      t2 && t2();
    }
  }
  emitTokenStatus(e2, t2) {
    let i2 = this.expiresAt ? this.expiresAt - Date.now() : 0, s2 = { level: e2, message: t2, expiresInMs: i2, failedAttempts: this.proactiveRefreshFailures, needsReLogin: e2 === "expired" || e2 === "critical" && this.proactiveRefreshFailures >= 3 }, r2 = e2 === "rotated" ? "\u2705" : e2 === "warning" ? "\u26A0\uFE0F" : e2 === "critical" ? "\uD83D\uDD34" : "\uD83D\uDC80";
    this.dbg(`${r2} [${e2.toUpperCase()}] ${t2} (expires in ${Math.round(i2 / 60000)}min, failures=${this.proactiveRefreshFailures})`), this.onTokenStatus?.(s2);
  }
  isRefreshOnCooldown() {
    try {
      let e2 = L(Fe, "utf8"), t2 = parseInt(e2.trim());
      if (Date.now() < t2)
        return true;
      try {
        W(Fe);
      } catch {}
    } catch {}
    return false;
  }
  setRefreshCooldown(e2) {
    try {
      let t2 = j(K(), ".claude");
      try {
        U(t2, { recursive: true });
      } catch {}
      F(Fe, `${Date.now() + e2}
`);
    } catch {}
  }
  clearRefreshCooldown() {
    try {
      W(Fe);
    } catch {}
    this.refreshConsecutive429s = 0;
  }
  dbg(e2) {
    try {
      H(j(K(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_ROTATION pid=${process.pid} ${e2}
`);
    } catch {}
  }
  async refreshTokenWithTripleCheck() {
    let e2 = await this.credentialStore.read();
    if (e2 && !(Date.now() + Ne >= e2.expiresAt))
      return this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken, void (this.expiresAt = e2.expiresAt);
    let t2 = await Ke();
    if (!t2) {
      this.dbg("refresh: lock unavailable (another PID refreshing) \u2014 polling disk");
      let e3 = await qe(this.credentialStore, 45000, Ne);
      return e3 ? (this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, void this.dbg(`refresh: picked up fresh token from disk (${Math.round((e3.expiresAt - Date.now()) / 60000)}min remaining)`)) : (this.dbg("refresh: no fresh token from disk after 45s wait \u2014 attempting unlocked refresh as last resort"), void await this.doTokenRefresh());
    }
    try {
      let e3 = await this.credentialStore.read();
      if (e3 && !(Date.now() + Ne >= e3.expiresAt))
        return this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, void (this.expiresAt = e3.expiresAt);
      await this.doTokenRefresh();
    } finally {
      t2();
    }
  }
  async handleAuth401() {
    let e2 = this.accessToken;
    this.pending401 && this.lastFailedToken === e2 || (this.lastFailedToken = e2, this.pending401 = (async () => {
      let t2 = await this.credentialStore.read();
      if (t2 && t2.accessToken !== e2)
        return this.accessToken = t2.accessToken, this.refreshToken = t2.refreshToken, this.expiresAt = t2.expiresAt, true;
      let i2 = await Ke();
      if (!i2) {
        this.dbg("handleAuth401: lock unavailable \u2014 polling disk for fresh token");
        let t3 = await qe(this.credentialStore, 45000, Ne);
        return t3 && t3.accessToken !== e2 ? (this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, this.dbg(`handleAuth401: picked up fresh token from disk (${Math.round((t3.expiresAt - Date.now()) / 60000)}min remaining)`), true) : (this.dbg("handleAuth401: no fresh token from disk after 45s wait \u2014 attempting unlocked refresh"), await this.doTokenRefresh(), true);
      }
      try {
        let t3 = await this.credentialStore.read();
        if (t3 && t3.accessToken !== e2 && !(Date.now() + Ne >= t3.expiresAt))
          return this.accessToken = t3.accessToken, this.refreshToken = t3.refreshToken, this.expiresAt = t3.expiresAt, true;
        await this.doTokenRefresh();
      } finally {
        i2();
      }
      return true;
    })().finally(() => {
      this.pending401 = null, this.lastFailedToken = null;
    })), await this.pending401;
  }
  async doTokenRefresh(e2 = false) {
    if (!this.refreshToken)
      throw new z("Token expired and no refresh token available.");
    if (this.isRefreshOnCooldown() && !e2) {
      let e3 = await this.credentialStore.read();
      if (e3 && !(Date.now() + Ne >= e3.expiresAt))
        return this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, void this.dbg("refresh skipped (cooldown) \u2014 another process already refreshed");
      if (this.expiresAt && this.expiresAt > Date.now() + 600000)
        throw new z("Token refresh on cooldown due to rate limiting. Will retry later.");
      this.dbg("refresh: ignoring cooldown \u2014 token critically close to expiry");
    }
    let t2 = [500, 1500, 3000, 5000, 8000], i2 = this.credentialStore.path ?? j(K(), ".claude", ".credentials.json");
    try {
      let t3 = J(i2).mtimeMs, s3 = Date.now() - t3;
      if (s3 < 60000) {
        let t4 = await this.credentialStore.read();
        if (t4 && !(Date.now() + Ne >= t4.expiresAt)) {
          let i3 = t4.expiresAt - Date.now(), r2 = t4.accessToken !== this.accessToken;
          if (!e2 || r2 && i3 >= Le)
            return this.accessToken = t4.accessToken, this.refreshToken = t4.refreshToken, this.expiresAt = t4.expiresAt, this.tokenIssuedAt = Date.now(), this.dbg(`refresh: skipped (mtime fresh ${Math.round(s3 / 1000)}s ago, ${Math.round(i3 / 60000)}min remaining) \u2014 picked up sibling/CLI write`), void this.scheduleProactiveRotation();
        }
      }
    } catch {}
    for (let i3 = 0;i3 < 5; i3++) {
      let s3 = await this.credentialStore.read();
      if (s3 && !(Date.now() + Ne >= s3.expiresAt)) {
        if (!e2)
          return this.accessToken = s3.accessToken, this.refreshToken = s3.refreshToken, this.expiresAt = s3.expiresAt, void this.dbg(`refresh: another process already refreshed (attempt ${i3})`);
        let t3 = s3.expiresAt - Date.now();
        if (s3.accessToken !== this.accessToken && t3 >= Le)
          return this.accessToken = s3.accessToken, this.refreshToken = s3.refreshToken, this.expiresAt = s3.expiresAt, void this.dbg(`refresh: another process got fresh token (${Math.round(t3 / 60000)}min remaining) (attempt ${i3})`);
        s3.accessToken !== this.accessToken ? (this.accessToken = s3.accessToken, this.refreshToken = s3.refreshToken, this.expiresAt = s3.expiresAt, this.dbg(`refresh: force=true, disk token different but only ${Math.round(t3 / 60000)}min left \u2014 proceeding to actual refresh (attempt ${i3})`)) : this.dbg(`refresh: force=true, token still same, proceeding to actual refresh (attempt ${i3})`);
      }
      let r2 = await fetch("https://platform.claude.com/v1/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: this.refreshToken, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }), signal: AbortSignal.timeout(15000) });
      if (r2.ok) {
        let e3 = await r2.json();
        this.accessToken = e3.access_token, this.refreshToken = e3.refresh_token ?? this.refreshToken, this.expiresAt = Date.now() + 1000 * e3.expires_in, this.tokenIssuedAt = Date.now();
        let t3 = await this.credentialStore.read(), i4 = t3?.scopes?.length ? t3.scopes : ["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"];
        return await this.credentialStore.write({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt, scopes: i4 }), this.dbg(`token refreshed OK \u2014 expires in ${Math.round(e3.expires_in / 60)}min at ${new Date(this.expiresAt).toISOString()}`), void this.scheduleProactiveRotation();
      }
      if (r2.status === 429) {
        let e3 = Math.min(60000, Pe);
        throw this.setRefreshCooldown(e3), this.dbg(`TOKEN_REFRESH_RETRY status=429 attempt=${i3 + 1}/5 \u2014 bailing out, cooldown ${e3}ms (per-token rate limit)`), new z("Token refresh rate-limited (429) \u2014 will pickup from disk or retry after cooldown");
      }
      if (r2.status >= 500 && i3 < 4) {
        let e3 = t2[i3] ?? 8000, s4 = Math.random() * e3 * 0.5;
        this.dbg(`TOKEN_REFRESH_RETRY status=${r2.status} attempt=${i3 + 1}/5 delay=${Math.round(e3 + s4)}ms`), await new Promise((t3) => setTimeout(t3, e3 + s4));
        continue;
      }
      throw new z(`Token refresh failed: ${r2.status} ${r2.statusText}`);
    }
    let s2 = await this.credentialStore.read();
    if (!s2 || Date.now() + Ne >= s2.expiresAt)
      throw new z("Token refresh failed after all retries and race recovery");
    this.accessToken = s2.accessToken, this.refreshToken = s2.refreshToken, this.expiresAt = s2.expiresAt;
    try {
      H(j(K(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_REFRESH_RACE_RECOVERY pid=${process.pid}
`);
    } catch {}
  }
  assembleResponse(e2, t2) {
    let i2, s2 = [], r2 = [], n2 = [], a2 = { inputTokens: 0, outputTokens: 0 }, o2 = null, l2 = "", h2 = "";
    for (let t3 of e2)
      switch (t3.type) {
        case "text_delta":
          l2 += t3.text;
          break;
        case "thinking_delta":
          h2 += t3.text;
          break;
        case "thinking_end":
          i2 = t3.signature, h2 && (r2.push({ type: "thinking", thinking: h2, signature: i2 }), h2 = "");
          break;
        case "tool_use_end":
          n2.push({ type: "tool_use", id: t3.id, name: t3.name, input: t3.input });
          break;
        case "message_stop":
          a2 = t3.usage, o2 = t3.stopReason;
          break;
        case "error":
          throw t3.error;
      }
    return l2 && s2.push({ type: "text", text: l2 }), h2 && r2.push({ type: "thinking", thinking: h2, signature: i2 }), s2.push(...n2), { content: s2, thinking: r2.length > 0 ? r2 : undefined, toolCalls: n2.length > 0 ? n2 : undefined, usage: a2, stopReason: o2, rateLimitInfo: this.lastRateLimitInfo, model: t2 };
  }
  parseRateLimitHeaders(e2) {
    let t2 = {};
    if (e2.forEach((e3, i3) => {
      (i3.includes("ratelimit") || i3.includes("anthropic") || i3.includes("retry") || i3.includes("x-")) && (t2[i3] = e3);
    }), Object.keys(t2).length > 0)
      try {
        let { appendFileSync: e3 } = s("fs"), { join: i3 } = s("path"), { homedir: r3 } = s("os");
        e3(i3(r3(), ".claude", "claude-max-headers.log"), `[${new Date().toISOString()}] ${JSON.stringify(t2)}
`);
      } catch {}
    let i2 = e2.get("retry-after"), r2 = e2.get("anthropic-ratelimit-unified-reset"), n2 = r2 ? Number(r2) : null, a2 = e2.get("anthropic-ratelimit-unified-5h-utilization"), o2 = e2.get("anthropic-ratelimit-unified-7d-utilization");
    return { status: e2.get("anthropic-ratelimit-unified-status"), resetAt: Number.isFinite(n2) ? n2 : null, claim: e2.get("anthropic-ratelimit-unified-representative-claim"), retryAfter: i2 ? parseFloat(i2) : null, utilization5h: a2 ? parseFloat(a2) : null, utilization7d: o2 ? parseFloat(o2) : null };
  }
  getRetryDelay(e2, t2) {
    if (t2) {
      let e3 = parseInt(t2, 10);
      if (!isNaN(e3))
        return 1000 * e3;
    }
    let i2 = Math.min(300 * Math.pow(2, e2 - 1), 5000);
    return i2 + 0.25 * Math.random() * i2;
  }
  sleep(e2, t2) {
    return new Promise((i2, s2) => {
      if (t2?.aborted)
        return void s2(new q("Aborted"));
      let r2 = setTimeout(i2, e2);
      t2?.addEventListener("abort", () => {
        clearTimeout(r2), s2(new q("Aborted"));
      }, { once: true });
    });
  }
  computeFingerprint(e2) {
    let t2 = "";
    for (let i3 of e2) {
      let e3 = i3;
      if (e3.role === "user") {
        if (typeof e3.content == "string") {
          t2 = e3.content;
          break;
        }
        if (Array.isArray(e3.content)) {
          for (let i4 of e3.content)
            if (i4.type === "text") {
              t2 = i4.text;
              break;
            }
          if (t2)
            break;
        }
      }
    }
    let i2 = `59cf53e54c78${[4, 7, 20].map((e3) => t2[e3] || "0").join("")}${Ue}`;
    return N("sha256").update(i2).digest("hex").slice(0, 3);
  }
  readAccountUuid() {
    try {
      let e2 = j(K(), ".claude", "claude_code_config.json");
      return JSON.parse(L(e2, "utf8")).oauthAccount?.accountUuid ?? "";
    } catch {
      return "";
    }
  }
};
var Ge = class {
  constructor(e2) {
    this.path = e2;
  }
  static {
    i(this, "FileCredentialStore");
  }
  lastMtimeMs = 0;
  async read() {
    try {
      let e2 = L(this.path, "utf8");
      return this.lastMtimeMs = this.getMtime(), JSON.parse(e2).claudeAiOauth ?? null;
    } catch {
      return null;
    }
  }
  async write(e2) {
    let t2 = {};
    try {
      t2 = JSON.parse(L(this.path, "utf8"));
    } catch {}
    t2.claudeAiOauth = e2;
    let i2 = j(this.path, "..");
    try {
      U(i2, { recursive: true });
    } catch {}
    F(this.path, JSON.stringify(t2, null, 2), "utf8"), P(this.path, 384), this.lastMtimeMs = this.getMtime();
  }
  async hasChanged() {
    let e2 = this.getMtime();
    return e2 !== this.lastMtimeMs && (this.lastMtimeMs = e2, true);
  }
  getMtime() {
    try {
      return J(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }
};
var Qe = class {
  static {
    i(this, "MemoryCredentialStore");
  }
  credentials;
  constructor(e2) {
    this.credentials = { ...e2 };
  }
  async read() {
    return this.credentials.accessToken ? { ...this.credentials } : null;
  }
  async write(e2) {
    this.credentials = { ...e2 };
  }
};
var Ye = class _Conversation {
  static {
    i(this, "Conversation");
  }
  sdk;
  options;
  $ = [];
  M = { inputTokens: 0, outputTokens: 0 };
  constructor(e2, t2) {
    this.sdk = e2, this.options = t2;
  }
  get messages() {
    return this.$;
  }
  get totalUsage() {
    return { ...this.M };
  }
  get length() {
    return this.$.length;
  }
  async send(e2, t2) {
    this.appendUserMessage(e2);
    let i2 = this.buildGenerateOptions(t2), s2 = await this.sdk.generate(i2);
    return this.appendAssistantFromResponse(s2), this.accumulateUsage(s2.usage), s2;
  }
  async* stream(e2, t2) {
    this.appendUserMessage(e2);
    let i2 = this.buildGenerateOptions(t2), s2 = [], r2 = [], n2 = [], a2 = { inputTokens: 0, outputTokens: 0 };
    for await (let e3 of this.sdk.stream(i2))
      switch (yield e3, e3.type) {
        case "text_delta":
          s2.push(e3.text);
          break;
        case "thinking_delta":
          r2.push(e3.text);
          break;
        case "tool_use_end":
          n2.push({ type: "tool_use", id: e3.id, name: e3.name, input: e3.input });
          break;
        case "message_stop":
          a2 = e3.usage;
      }
    let o2 = [];
    s2.length > 0 && o2.push({ type: "text", text: s2.join("") });
    for (let e3 of n2)
      o2.push({ type: "tool_use", id: e3.id, name: e3.name, input: e3.input });
    o2.length > 0 && this.$.push({ role: "assistant", content: o2 }), this.accumulateUsage(a2);
  }
  addToolResult(e2, t2, i2) {
    let s2 = { type: "tool_result", tool_use_id: e2, content: t2, ...i2 && { is_error: true } };
    this.$.push({ role: "user", content: [s2] });
  }
  addToolResults(e2) {
    let t2 = e2.map((e3) => ({ type: "tool_result", tool_use_id: e3.toolUseId, content: e3.content, ...e3.isError && { is_error: true } }));
    this.$.push({ role: "user", content: t2 });
  }
  async continue(e2) {
    let t2 = this.buildGenerateOptions(e2), i2 = await this.sdk.generate(t2);
    return this.appendAssistantFromResponse(i2), this.accumulateUsage(i2.usage), i2;
  }
  async* continueStream(e2) {
    let t2 = this.buildGenerateOptions(e2), i2 = [], s2 = [], r2 = { inputTokens: 0, outputTokens: 0 };
    for await (let e3 of this.sdk.stream(t2))
      switch (yield e3, e3.type) {
        case "text_delta":
          i2.push(e3.text);
          break;
        case "tool_use_end":
          s2.push({ type: "tool_use", id: e3.id, name: e3.name, input: e3.input });
          break;
        case "message_stop":
          r2 = e3.usage;
      }
    let n2 = [];
    i2.length > 0 && n2.push({ type: "text", text: i2.join("") });
    for (let e3 of s2)
      n2.push({ type: "tool_use", id: e3.id, name: e3.name, input: e3.input });
    n2.length > 0 && this.$.push({ role: "assistant", content: n2 }), this.accumulateUsage(r2);
  }
  rewind(e2) {
    if (e2 < 0 || e2 >= this.$.length)
      throw new Error(`Invalid rewind index: ${e2}`);
    return this.$.splice(e2);
  }
  undoLastTurn() {
    for (let e2 = this.$.length - 1;e2 >= 0; e2--) {
      let t2 = this.$[e2];
      if (t2.role === "user") {
        let i2 = t2.content;
        if (!(Array.isArray(i2) && i2.length > 0 && i2[0].type === "tool_result"))
          return this.rewind(e2);
      }
    }
    return [];
  }
  branch() {
    let e2 = new _Conversation(this.sdk, { ...this.options });
    return e2.$ = [...this.$], e2.M = { ...this.M }, e2;
  }
  getHistory() {
    return this.$.map((e2, t2) => {
      let i2 = "";
      if (typeof e2.content == "string")
        i2 = e2.content.slice(0, 100);
      else if (Array.isArray(e2.content)) {
        let t3 = e2.content[0];
        t3?.type === "text" ? i2 = t3.text?.slice(0, 100) ?? "" : t3?.type === "tool_result" ? i2 = `[tool_result: ${t3.tool_use_id}]` : t3?.type === "tool_use" && (i2 = `[tool_use: ${t3.name}]`);
      }
      return { index: t2, role: e2.role, preview: i2 };
    });
  }
  appendUserMessage(e2) {
    this.$.push({ role: "user", content: e2 });
  }
  appendAssistantFromResponse(e2) {
    let t2 = [];
    for (let i2 of e2.content)
      i2.type === "text" ? t2.push({ type: "text", text: i2.text }) : i2.type === "tool_use" && t2.push({ type: "tool_use", id: i2.id, name: i2.name, input: i2.input });
    t2.length > 0 && this.$.push({ role: "assistant", content: t2 });
  }
  buildGenerateOptions(e2) {
    return { model: this.options.model, messages: [...this.$], system: this.options.system, tools: e2?.tools ?? this.options.tools, toolChoice: e2?.toolChoice ?? this.options.toolChoice, maxTokens: this.options.maxTokens, thinking: this.options.thinking, effort: this.options.effort, fast: this.options.fast, signal: e2?.signal ?? this.options.signal, extraBetas: this.options.extraBetas, caching: this.options.caching };
  }
  accumulateUsage(e2) {
    this.M.inputTokens += e2.inputTokens, this.M.outputTokens += e2.outputTokens, this.M.cacheCreationInputTokens = (this.M.cacheCreationInputTokens ?? 0) + (e2.cacheCreationInputTokens ?? 0), this.M.cacheReadInputTokens = (this.M.cacheReadInputTokens ?? 0) + (e2.cacheReadInputTokens ?? 0);
  }
};
function it(e2, t2) {
  Ze(et(e2), { recursive: true });
  let i2 = null, s2 = [];
  for (let e3 of t2) {
    let t3 = tt(), r2 = { type: e3.role === "user" ? "user" : "assistant", uuid: t3, parentUuid: i2, timestamp: Date.now(), content: e3.content };
    s2.push(JSON.stringify(r2)), i2 = t3;
  }
  Xe(e2, s2.join(`
`) + `
`, "utf8");
}
function st(e2) {
  let t2 = Ve(e2, "utf8"), i2 = [];
  for (let e3 of t2.split(`
`)) {
    if (!e3.trim())
      continue;
    let t3;
    try {
      t3 = JSON.parse(e3);
    } catch {
      continue;
    }
    (t3.type === "user" || t3.type === "assistant") && i2.push({ role: t3.type === "user" ? "user" : "assistant", content: t3.content });
  }
  return i2;
}
i(it, "saveSession"), i(st, "loadSession");
var rt = class {
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
  constructor(e2 = {}) {
    this.windowMs = e2.windowMs ?? 60000, this.reportIntervalMs = e2.reportIntervalMs ?? this.windowMs, this.regressionThreshold = e2.regressionThreshold ?? 0.7, this.regressionPreviousFloor = e2.regressionPreviousFloor ?? 0.85, this.regressionMinSamples = e2.regressionMinSamples ?? 50, this.onSummary = e2.onSummary, this.onRegression = e2.onRegression, this.reportIntervalMs > 0 && (this.timer = setInterval(() => this.report(), this.reportIntervalMs), typeof this.timer == "object" && ("unref" in this.timer) && this.timer.unref());
  }
  recordRequest(e2) {
    this.samples.push({ ts: Date.now(), ...e2 });
  }
  summary() {
    this.prune();
    let e2 = this.samples.length, t2 = this.samples.filter((e3) => e3.cacheRead > 0).length, i2 = this.samples.filter((e3) => e3.firstCall && e3.cacheRead === 0).length, s2 = this.samples.filter((e3) => e3.kind === "real").length, r2 = this.samples.filter((e3) => e3.kind === "ka").length, n2 = this.samples.reduce((e3, t3) => e3 + t3.cacheRead, 0), a2 = this.samples.reduce((e3, t3) => e3 + t3.cacheWrite, 0), o2 = this.samples.reduce((e3, t3) => e3 + t3.input, 0), l2 = this.samples.reduce((e3, t3) => Math.max(e3, t3.cacheRead), 0), h2 = new Set(this.samples.map((e3) => e3.sysHash).filter(Boolean)).size, c2 = Math.round(0.9 * n2);
    return { windowMs: this.windowMs, windowEndsAt: new Date().toISOString(), total: e2, hitRate: e2 > 0 ? t2 / e2 : 0, coldStartCount: i2, realCount: s2, kaCount: r2, avgCacheRead: e2 > 0 ? n2 / e2 : 0, avgCacheWrite: e2 > 0 ? a2 / e2 : 0, avgInput: e2 > 0 ? o2 / e2 : 0, maxCacheRead: l2, distinctSysHash: h2, estimatedSavedTokens: c2 };
  }
  report() {
    let e2 = this.summary();
    e2.total !== 0 && (this.onSummary?.(e2), this.previousSampleCount >= this.regressionMinSamples && this.previousHitRate >= this.regressionPreviousFloor && e2.total >= this.regressionMinSamples && e2.hitRate < this.regressionThreshold && this.onRegression?.({ detectedAt: e2.windowEndsAt, windowMs: this.windowMs, currentHitRate: e2.hitRate, previousHitRate: this.previousHitRate, drop: this.previousHitRate - e2.hitRate, reason: `hit_rate dropped from ${this.previousHitRate.toFixed(3)} to ${e2.hitRate.toFixed(3)} (\u0394=${(this.previousHitRate - e2.hitRate).toFixed(3)}); ${e2.total} samples in current window` }), this.previousHitRate = e2.hitRate, this.previousSampleCount = e2.total);
  }
  prune() {
    let e2 = Date.now() - this.windowMs;
    for (;this.samples.length > 0 && this.samples[0].ts < e2; )
      this.samples.shift();
  }
  stop() {
    this.timer && (clearInterval(this.timer), this.timer = null);
  }
  get D() {
    return this.samples;
  }
};
var ot = class {
  static {
    i(this, "FileCredentialsProvider");
  }
  path;
  expiryBufferMs;
  cached = null;
  lastMtimeMs = 0;
  constructor(e2 = {}) {
    this.path = e2.path ?? lt(), this.expiryBufferMs = e2.expiryBufferMs ?? 300000;
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
      let e2 = nt(this.path, "utf8");
      return this.lastMtimeMs = this.getMtime(), JSON.parse(e2).claudeAiOauth ?? null;
    } catch {
      return null;
    }
  }
  mtimeChanged() {
    return this.getMtime() !== this.lastMtimeMs;
  }
  getMtime() {
    try {
      return at(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }
  isExpired(e2) {
    return !!e2.expiresAt && Date.now() + this.expiryBufferMs >= e2.expiresAt;
  }
};
function lt() {
  let e2 = process.env.HOME || process.env.USERPROFILE || "";
  return `${process.env.CLAUDE_CONFIG_DIR || `${e2}/.claude`}/.credentials.json`;
}
i(lt, "defaultCredentialsPath");
var ht = { error: 0, info: 1, debug: 2 };
var ct = class {
  static {
    i(this, "ConsoleEventEmitter");
  }
  minRank;
  format;
  write;
  constructor(e2 = {}) {
    this.minRank = ht[e2.minLevel ?? "info"] ?? 1, this.format = e2.format ?? "human", this.write = e2.writeTarget ?? ((e3) => process.stderr.write(e3 + `
`));
  }
  emit(e2) {
    try {
      if ((ht[e2.level] ?? 1) > this.minRank)
        return;
      let t2 = e2.ts ?? new Date().toISOString();
      if (this.format === "json")
        return void this.write(JSON.stringify({ ts: t2, ...e2 }));
      let i2 = t2.slice(11, 23), s2 = e2.level.toUpperCase().padEnd(5), r2 = e2.kind.padEnd(22), n2 = [];
      for (let [t3, i3] of Object.entries(e2)) {
        if (["ts", "level", "kind", "msg"].includes(t3) || i3 == null)
          continue;
        let e3 = typeof i3 == "object" ? JSON.stringify(i3) : String(i3);
        n2.push(`${t3}=${e3.length > 120 ? e3.slice(0, 117) + "..." : e3}`);
      }
      let a2 = e2.msg ? ` ${e2.msg}` : "", o2 = n2.length ? " " + n2.join(" ") : "";
      this.write(`${i2} ${s2} ${r2}${a2}${o2}`);
    } catch {}
  }
};
var ut = class {
  static {
    i(this, "NullEventEmitter");
  }
  emit(e2) {}
};
var dt = class {
  static {
    i(this, "InMemorySessionStore");
  }
  sessions = new Map;
  liveness;
  constructor(e2 = new ft) {
    this.liveness = e2;
  }
  getOrCreate(e2, t2, i2) {
    let s2 = this.sessions.get(e2);
    if (s2)
      return s2;
    let r2 = { sessionId: e2, pid: t2, firstSeenAt: Date.now(), lastRequestAt: Date.now(), engine: i2(), model: null, lastUsage: null };
    return this.sessions.set(e2, r2), r2;
  }
  get(e2) {
    return this.sessions.get(e2);
  }
  list() {
    return Array.from(this.sessions.values());
  }
  size() {
    return this.sessions.size;
  }
  isOwnerAlive(e2) {
    let t2 = this.sessions.get(e2);
    return !t2 || t2.pid === null || t2.pid !== 1 && this.liveness.isAlive(t2.pid);
  }
  reapDead() {
    let e2 = [];
    for (let [t2, i2] of this.sessions.entries())
      if (i2.pid !== null && (i2.pid === 1 || !this.liveness.isAlive(i2.pid))) {
        try {
          i2.engine?.stop?.();
        } catch {}
        this.sessions.delete(t2), e2.push(t2);
      }
    return e2;
  }
  stopAll() {
    for (let e2 of this.sessions.values())
      try {
        e2.engine?.stop?.();
      } catch {}
    this.sessions.clear();
  }
};
var ft = class {
  static {
    i(this, "DefaultLivenessChecker");
  }
  isAlive(e2) {
    if (!e2 || e2 < 1)
      return false;
    try {
      return process.kill(e2, 0), true;
    } catch (e3) {
      return e3.code === "EPERM";
    }
  }
};
var pt = class {
  static {
    i(this, "NativeFetchUpstream");
  }
  async fetch(e2, t2) {
    return fetch(e2, t2);
  }
};
var mt = { anthropicBaseUrl: "https://api.anthropic.com", kaIntervalSec: undefined, kaIdleTimeoutSec: 0, kaMinTokens: 2000, kaRewriteWarnIdleSec: 300, kaRewriteWarnTokens: 50000, kaRewriteBlockIdleSec: 0, kaRewriteBlockEnabled: false };
var yt = class {
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
  constructor(e2) {
    this.config = { ...mt, ...e2.config }, this.credentials = e2.credentialsProvider, this.events = e2.eventEmitter ?? new ct, this.liveness = e2.livenessChecker ?? new ft, this.store = e2.sessionStore ?? new dt(this.liveness), this.upstream = e2.upstreamFetcher ?? new pt, this.metrics = new rt({ windowMs: 60000, reportIntervalMs: 60000, onSummary: i((e3) => this.events.emit({ level: "info", kind: "CACHE_METRICS_SUMMARY", ...e3 }), "onSummary"), onRegression: i((e3) => this.events.emit({ level: "error", kind: "CACHE_REGRESSION_DETECTED", ...e3 }), "onRegression") }), this.reaperTimer = setInterval(() => {
      let e3 = this.store.reapDead();
      for (let t2 of e3)
        this.events.emit({ level: "info", kind: "SESSION_DEAD", sessionId: t2, reason: "pid_gone" });
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
  async handleRequest(e2, t2, i2) {
    let s2 = i2.sessionId, r2 = i2.sourcePid ?? null, n2 = this.store.getOrCreate(s2, r2, () => this.createEngine(s2));
    n2.lastRequestAt = Date.now();
    let a2, o2 = typeof e2 == "string" ? e2 : new TextDecoder().decode(e2), l2 = typeof e2 == "string" ? new TextEncoder().encode(e2).byteLength : e2.byteLength;
    try {
      a2 = JSON.parse(o2);
    } catch {
      return this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, msg: "Invalid JSON body" }), Tt(400, { error: "Invalid JSON" });
    }
    let h2 = a2.model ?? "unknown";
    n2.model = h2;
    let c2 = {};
    for (let [e3, i3] of Object.entries(t2)) {
      let t3 = e3.toLowerCase();
      gt.includes(t3) || (c2[e3] = i3);
    }
    c2["accept-encoding"] = "identity";
    try {
      let e3 = await this.credentials.getAccessToken();
      c2.Authorization = `Bearer ${e3}`;
    } catch (e3) {
      return this.events.emit({ level: "error", kind: "TOKEN_NEEDS_RELOGIN", sessionId: s2, msg: e3?.message ?? "No OAuth credentials" }), Tt(401, { error: { type: "authentication_error", message: e3?.message ?? "No OAuth credentials" } });
    }
    let u2 = c2["anthropic-beta"] ?? c2["Anthropic-Beta"] ?? "";
    if (!u2.includes("oauth-2025-04-20")) {
      let e3 = u2 ? u2 + "," : "";
      c2["anthropic-beta"] = e3 + "oauth-2025-04-20", delete c2["Anthropic-Beta"];
    }
    this.events.emit({ level: "info", kind: "REAL_REQUEST_START", sessionId: s2, model: h2, bodyBytes: l2 }), n2.engine.notifyRealRequestStart(h2, a2, c2);
    try {
      n2.engine.checkRewriteGuard(h2);
    } catch (e3) {
      if (e3?.code === "CACHE_REWRITE_BLOCKED")
        return Tt(429, { error: { type: "cache_rewrite_blocked", message: e3.message } });
      throw e3;
    }
    let d2, f2, p2, m2 = Date.now();
    try {
      d2 = await this.upstream.fetch(`${this.config.anthropicBaseUrl}/v1/messages?beta=true`, { method: "POST", headers: c2, body: o2, signal: i2.signal });
    } catch (e3) {
      return this.handleNetworkError(s2, e3);
    }
    if (this.lastRateLimit = kt(d2.headers), !d2.ok) {
      let e3 = await d2.text().catch(() => "");
      return d2.status === 401 && this.credentials.invalidate(), this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, status: d2.status, msg: e3.slice(0, 200) }), new Response(e3, { status: d2.status, headers: d2.headers });
    }
    if (!d2.body)
      return new Response("No upstream body", { status: 502 });
    try {
      let e3 = d2.body.tee();
      f2 = e3[0], p2 = e3[1];
    } catch (e3) {
      return this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, msg: `tee() failed: ${e3?.message}` }), new Response(d2.body, { status: d2.status, headers: d2.headers });
    }
    this.parseSSEAndNotify(p2, n2, s2, h2, m2).catch((e3) => {
      this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, msg: `parse promise rejected: ${e3?.message}` });
    });
    let y2 = new Headers(d2.headers);
    return y2.delete("content-encoding"), y2.delete("content-length"), new Response(f2, { status: d2.status, headers: y2 });
  }
  createEngine(e2) {
    let t2 = this.config;
    return new Ae({ config: { intervalMs: t2.kaIntervalSec !== undefined ? 1000 * t2.kaIntervalSec : undefined, idleTimeoutMs: t2.kaIdleTimeoutSec > 0 ? 1000 * t2.kaIdleTimeoutSec : 1 / 0, minTokens: t2.kaMinTokens, rewriteWarnIdleMs: 1000 * t2.kaRewriteWarnIdleSec, rewriteWarnTokens: t2.kaRewriteWarnTokens, rewriteBlockIdleMs: t2.kaRewriteBlockIdleSec > 0 ? 1000 * t2.kaRewriteBlockIdleSec : 1 / 0, rewriteBlockEnabled: t2.kaRewriteBlockEnabled, onHeartbeat: i((t3) => {
      this.metrics.recordRequest({ kind: "ka", cacheRead: t3.usage.cacheReadInputTokens ?? 0, cacheWrite: t3.usage.cacheCreationInputTokens ?? 0, input: t3.usage.inputTokens ?? 0, model: t3.model }), this.events.emit({ level: "info", kind: "KA_FIRE_COMPLETE", sessionId: e2, model: t3.model, durationMs: t3.durationMs, idleMs: t3.idleMs, usage: { inputTokens: t3.usage.inputTokens, outputTokens: t3.usage.outputTokens, cacheReadInputTokens: t3.usage.cacheReadInputTokens ?? 0, cacheCreationInputTokens: t3.usage.cacheCreationInputTokens ?? 0 }, rateLimit: t3.rateLimit });
    }, "onHeartbeat"), onTick: i((i2) => {
      let s2 = 1000 * (t2.kaIntervalSec ?? 120);
      i2.idleMs > 0.9 * s2 && this.events.emit({ level: "debug", kind: "KA_TICK_IDLE", sessionId: e2, idleMs: i2.idleMs, nextFireMs: i2.nextFireMs, model: i2.model, tokens: i2.tokens });
    }, "onTick"), onDisarmed: i((t3) => this.events.emit({ level: "error", kind: "KA_DISARM", sessionId: e2, reason: t3.reason, msg: `KA disarmed for session ${e2.slice(0, 8)} \u2014 reason=${t3.reason}` }), "onDisarmed"), onRewriteWarning: i((t3) => this.events.emit({ level: t3.blocked ? "error" : "info", kind: t3.blocked ? "REWRITE_BLOCK" : "REWRITE_WARN", sessionId: e2, idleMs: t3.idleMs, estimatedTokens: t3.estimatedTokens, blocked: t3.blocked, model: t3.model }), "onRewriteWarning"), onNetworkStateChange: i((t3) => this.events.emit({ level: t3.to === "degraded" ? "error" : "info", kind: t3.to === "degraded" ? "NETWORK_DEGRADED" : "NETWORK_HEALTHY", sessionId: e2, from: t3.from, to: t3.to }), "onNetworkStateChange") }, getToken: i(() => this.credentials.getAccessToken(), "getToken"), doFetch: i((e3, t3, i2) => this.engineDoFetch(e3, t3, i2), "doFetch"), getRateLimitInfo: i(() => this.lastRateLimit, "getRateLimitInfo"), isOwnerAlive: i(() => this.store.isOwnerAlive(e2), "isOwnerAlive") });
  }
  async* engineDoFetch(e2, t2, i2) {
    let s2 = JSON.stringify(e2), r2 = await this.upstream.fetch(`${this.config.anthropicBaseUrl}/v1/messages?beta=true`, { method: "POST", headers: t2, body: s2, signal: i2 });
    if (!r2.ok) {
      let e3 = await r2.text().catch(() => ""), t3 = new Error(`HTTP ${r2.status}: ${e3.slice(0, 200)}`);
      throw t3.status = r2.status, r2.status === 401 && this.credentials.invalidate(), t3;
    }
    if (!r2.body)
      throw new Error("No response body");
    yield* _t(r2.body, i2);
  }
  async parseSSEAndNotify(e2, t2, i2, s2, r2) {
    try {
      let n2 = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, a2 = new TextDecoder, o2 = e2.getReader(), l2 = "";
      for (;; ) {
        let e3, t3;
        try {
          let i3 = await o2.read();
          e3 = i3.done, t3 = i3.value;
        } catch (e4) {
          return void this.events.emit({ level: "debug", kind: "REAL_REQUEST_ERROR", sessionId: i2, msg: `stream read aborted: ${e4?.message}` });
        }
        if (e3)
          break;
        if (!t3)
          continue;
        l2 += a2.decode(t3, { stream: true });
        let s3 = l2.split(`
`);
        l2 = s3.pop() ?? "";
        for (let e4 of s3) {
          if (!e4.startsWith("data: "))
            continue;
          let t4 = e4.slice(6);
          if (t4 !== "[DONE]")
            try {
              let e5 = JSON.parse(t4);
              if (e5.type === "message_start" && e5.message?.usage) {
                let t5 = e5.message.usage;
                n2 = { inputTokens: t5.input_tokens ?? 0, outputTokens: t5.output_tokens ?? 0, cacheCreationInputTokens: t5.cache_creation_input_tokens ?? 0, cacheReadInputTokens: t5.cache_read_input_tokens ?? 0 };
              } else
                e5.type === "message_delta" && e5.usage?.output_tokens && (n2.outputTokens = e5.usage.output_tokens);
            } catch {}
        }
      }
      let h2 = t2.lastUsage === null;
      t2.lastUsage = n2;
      try {
        t2.engine.notifyRealRequestComplete(n2);
      } catch (e3) {
        this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: i2, msg: `engine.notifyRealRequestComplete: ${e3?.message}` });
      }
      this.metrics.recordRequest({ kind: "real", cacheRead: n2.cacheReadInputTokens ?? 0, cacheWrite: n2.cacheCreationInputTokens ?? 0, input: n2.inputTokens ?? 0, model: s2, firstCall: h2 }), this.events.emit({ level: "info", kind: "REAL_REQUEST_COMPLETE", sessionId: i2, model: s2, durationMs: Date.now() - r2, usage: n2, rateLimit: { util5h: this.lastRateLimit.utilization5h, util7d: this.lastRateLimit.utilization7d, status: this.lastRateLimit.status } });
    } catch (e3) {
      this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: i2, msg: `SSE parse error: ${e3?.message ?? e3}` });
    }
  }
  handleNetworkError(e2, t2) {
    let i2 = t2?.code ?? t2?.cause?.code ?? "", s2 = String(t2?.message ?? "").toLowerCase(), r2 = wt.has(i2) || s2.includes("unable to connect") || s2.includes("failed to open socket") || s2.includes("connection refused") || s2.includes("network");
    return this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: e2, status: r2 ? 503 : 502, msg: `upstream fetch threw: ${i2 || ""} ${s2}`.trim().slice(0, 200) }), r2 ? new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Upstream network error \u2014 proxy cannot reach Anthropic. Retrying will help once network is restored." } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "2" } }) : new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream request failed: ${s2 || i2 || "unknown"}` } }), { status: 502, headers: { "content-type": "application/json" } });
  }
};
var gt = ["host", "content-length", "connection", "authorization", "accept-encoding"];
var wt = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
function kt(e2) {
  return { status: e2.get("anthropic-ratelimit-unified-status"), resetAt: e2.get("anthropic-ratelimit-unified-reset") ? Number(e2.get("anthropic-ratelimit-unified-reset")) : null, claim: e2.get("anthropic-ratelimit-unified-representative-claim"), retryAfter: e2.get("retry-after") ? parseFloat(e2.get("retry-after")) : null, utilization5h: e2.get("anthropic-ratelimit-unified-5h-utilization") ? parseFloat(e2.get("anthropic-ratelimit-unified-5h-utilization")) : null, utilization7d: e2.get("anthropic-ratelimit-unified-7d-utilization") ? parseFloat(e2.get("anthropic-ratelimit-unified-7d-utilization")) : null };
}
function Tt(e2, t2) {
  return new Response(JSON.stringify(t2), { status: e2, headers: { "content-type": "application/json" } });
}
async function* _t(e2, t2) {
  let i2 = new TextDecoder, s2 = e2.getReader(), r2 = "", n2 = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  try {
    for (;; ) {
      if (t2?.aborted)
        return void s2.cancel();
      let { done: e3, value: a2 } = await s2.read();
      if (e3)
        break;
      r2 += i2.decode(a2, { stream: true });
      let o2 = r2.split(`
`);
      r2 = o2.pop() ?? "";
      for (let e4 of o2) {
        if (!e4.startsWith("data: "))
          continue;
        let t3, i3 = e4.slice(6);
        if (i3 !== "[DONE]") {
          try {
            t3 = JSON.parse(i3);
          } catch {
            continue;
          }
          if (t3.type === "message_start" && t3.message?.usage) {
            let e5 = t3.message.usage;
            n2 = { inputTokens: e5.input_tokens ?? 0, outputTokens: e5.output_tokens ?? 0, cacheCreationInputTokens: e5.cache_creation_input_tokens ?? 0, cacheReadInputTokens: e5.cache_read_input_tokens ?? 0 };
          } else
            t3.type === "message_delta" && t3.usage?.output_tokens ? n2.outputTokens = t3.usage.output_tokens : t3.type === "message_stop" && (yield { type: "message_stop", usage: n2, stopReason: null });
        }
      }
    }
  } finally {
    s2.releaseLock();
  }
}
i(kt, "parseRateLimitHeaders"), i(Tt, "jsonResponse"), i(_t, "parseSSEToEvents"), A(), A();
var $t = '{"type":"KeepAlive"}';
var Mt = 16000;
var Dt = Math.floor(3200);
async function Ct(e2, t2, s2) {
  let r2 = s2?.baseUrl ?? "https://api.anthropic.com", n2 = new URLSearchParams({ encoding: "linear16", sample_rate: String(Mt), channels: String(1), endpointing_ms: "300", utterance_end_ms: "1000", language: s2?.language ?? "en" });
  if (s2?.keyterms?.length)
    for (let e3 of s2.keyterms)
      n2.append("keyterms", e3);
  let a2 = `/api/ws/speech_to_text/voice_stream?${n2.toString()}`, o2 = St(16).toString("base64"), l2 = null, h2 = false, c2 = false, u2 = false, d2 = null, f2 = null, p2 = "", m2 = await new Promise((t3, i2) => {
    let s3 = setTimeout(() => {
      i2(new Error("voice_stream WebSocket connection timeout (10s)"));
    }, 1e4), n3 = new URL(r2), l3 = Rt({ hostname: n3.hostname, port: n3.port || 443, path: a2, method: "GET", headers: { Authorization: `Bearer ${e2}`, "User-Agent": "claude-cli/1.0.0 (subscriber, cli)", "x-app": "cli", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": o2 } });
    l3.on("upgrade", (e3, r3, n4) => {
      clearTimeout(s3);
      let a3 = bt("sha1").update(o2 + "258EAFA5-E914-47DA-95CA-5AB5DC11E5B3").digest("base64");
      if (e3.headers["sec-websocket-accept"] !== a3)
        return r3.destroy(), void i2(new Error("WebSocket handshake failed: invalid accept header"));
      t3(r3);
    }), l3.on("response", (e3) => {
      if (e3.statusCode === 101 && e3.socket)
        return clearTimeout(s3), void t3(e3.socket);
      clearTimeout(s3), i2(new Error(`WebSocket upgrade rejected: HTTP ${e3.statusCode}`));
    }), l3.on("error", (e3) => {
      clearTimeout(s3), i2(new Error(`voice_stream connection failed: ${e3.message}`));
    }), l3.end();
  });
  function y2(e3) {
    k2(Buffer.from(e3, "utf8"), 1);
  }
  function g2(e3) {
    k2(e3, 2);
  }
  function w2() {
    k2(Buffer.alloc(0), 8);
  }
  function k2(e3, t3) {
    if (m2.destroyed)
      return;
    let i2, s3 = St(4), r3 = Buffer.alloc(e3.length);
    for (let t4 = 0;t4 < e3.length; t4++)
      r3[t4] = e3[t4] ^ s3[t4 % 4];
    e3.length < 126 ? (i2 = Buffer.alloc(6), i2[0] = 128 | t3, i2[1] = 128 | e3.length, s3.copy(i2, 2)) : e3.length < 65536 ? (i2 = Buffer.alloc(8), i2[0] = 128 | t3, i2[1] = 254, i2.writeUInt16BE(e3.length, 2), s3.copy(i2, 4)) : (i2 = Buffer.alloc(14), i2[0] = 128 | t3, i2[1] = 255, i2.writeBigUInt64BE(BigInt(e3.length), 2), s3.copy(i2, 10)), m2.write(Buffer.concat([i2, r3]));
  }
  h2 = true, i(y2, "wsSendText"), i(g2, "wsSendBinary"), i(w2, "wsSendClose"), i(k2, "wsSendFrame");
  let T2 = Buffer.alloc(0);
  function _2() {
    for (;T2.length >= 2; ) {
      let e3 = T2[0], t3 = T2[1], i2 = 15 & e3, s3 = !!(128 & t3), r3 = 127 & t3, n3 = 2;
      if (r3 === 126) {
        if (T2.length < 4)
          return;
        r3 = T2.readUInt16BE(2), n3 = 4;
      } else if (r3 === 127) {
        if (T2.length < 10)
          return;
        r3 = Number(T2.readBigUInt64BE(2)), n3 = 10;
      }
      s3 && (n3 += 4);
      let a3 = n3 + r3;
      if (T2.length < a3)
        return;
      let o3 = T2.subarray(n3, a3);
      if (s3) {
        let e4 = T2.subarray(n3 - 4, n3);
        o3 = Buffer.from(o3);
        for (let t4 = 0;t4 < o3.length; t4++)
          o3[t4] = o3[t4] ^ e4[t4 % 4];
      }
      if (T2 = T2.subarray(a3), i2 === 1)
        v2(o3.toString("utf8"));
      else {
        if (i2 === 8)
          return void E2(o3.length >= 2 ? o3.readUInt16BE(0) : 1005, o3.length > 2 ? o3.subarray(2).toString("utf8") : "");
        i2 === 9 && k2(o3, 10);
      }
    }
  }
  function v2(e3) {
    let i2;
    try {
      i2 = JSON.parse(e3);
    } catch {
      return;
    }
    switch (i2.type) {
      case "TranscriptText": {
        let e4 = i2.data;
        c2 && f2?.(), e4 && (p2 = e4, t2.onTranscript(e4, false));
        break;
      }
      case "TranscriptEndpoint": {
        let e4 = p2;
        p2 = "", e4 && t2.onTranscript(e4, true), c2 && d2?.("post_closestream_endpoint");
        break;
      }
      case "TranscriptError": {
        let e4 = i2.description ?? i2.error_code ?? "unknown transcription error";
        u2 || t2.onError(e4);
        break;
      }
      case "error": {
        let e4 = i2.message ?? JSON.stringify(i2);
        u2 || t2.onError(e4);
        break;
      }
    }
  }
  function E2(e3, i2) {
    if (h2 = false, l2 && (clearInterval(l2), l2 = null), p2) {
      let e4 = p2;
      p2 = "", t2.onTranscript(e4, true);
    }
    d2?.("ws_close"), !u2 && e3 !== 1000 && e3 !== 1005 && t2.onError(`Connection closed: code ${e3}${i2 ? ` \u2014 ${i2}` : ""}`), t2.onClose(), m2.destroy();
  }
  return i(_2, "processFrames"), i(v2, "handleMessage"), i(E2, "handleClose"), m2.on("data", (e3) => {
    T2 = Buffer.concat([T2, e3]), _2();
  }), m2.on("close", () => {
    h2 && E2(1006, "connection lost");
  }), m2.on("error", (e3) => {
    u2 || t2.onError(`Socket error: ${e3.message}`);
  }), y2($t), l2 = setInterval(() => {
    h2 && y2($t);
  }, 8000), { send(e3) {
    !h2 || c2 || g2(Buffer.from(e3));
  }, finalize: () => u2 || c2 ? Promise.resolve("already_closed") : (u2 = true, new Promise((e3) => {
    let s3 = setTimeout(() => d2?.("safety_timeout"), 5000), r3 = setTimeout(() => d2?.("no_data_timeout"), 1500);
    f2 = i(() => {
      clearTimeout(r3), f2 = null;
    }, "cancelNoDataTimer"), d2 = i((i2) => {
      if (clearTimeout(s3), clearTimeout(r3), d2 = null, f2 = null, p2) {
        let e4 = p2;
        p2 = "", t2.onTranscript(e4, true);
      }
      e3(i2);
    }, "resolveFinalize"), m2.destroyed ? d2("ws_already_closed") : setTimeout(() => {
      c2 = true, h2 && y2('{"type":"CloseStream"}');
    }, 0);
  })), close() {
    c2 = true, l2 && (clearInterval(l2), l2 = null), h2 = false, m2.destroyed || (w2(), m2.destroy());
  }, isConnected: () => h2 && !m2.destroyed };
}
async function Ot(e2, t2, s2) {
  let r2 = [], n2 = null, a2 = await Ct(e2, { onTranscript: i((e3, t3) => {
    t3 ? r2.push(e3.trim()) : s2?.onInterim?.(e3);
  }, "onTranscript"), onError: i((e3) => {
    n2 = e3;
  }, "onError"), onClose: i(() => {}, "onClose") }, s2);
  try {
    let e3 = await Ft(t2), i2 = e3;
    e3.length > 44 && e3[0] === 82 && e3[1] === 73 && e3[2] === 70 && e3[3] === 70 && (i2 = e3.subarray(44));
    let r3 = s2?.realtime !== false;
    for (let e4 = 0;e4 < i2.length && a2.isConnected(); e4 += Dt) {
      let t3 = i2.subarray(e4, Math.min(e4 + Dt, i2.length));
      a2.send(t3), r3 && e4 + Dt < i2.length && await Lt(80);
    }
    await a2.finalize();
  } finally {
    a2.close();
  }
  if (n2)
    throw new Error(`Transcription error: ${n2}`);
  return r2.join(" ");
}
async function At(e2, t2, s2) {
  let r2 = [], n2 = null, a2 = await Ct(e2, { onTranscript: i((e3, t3) => {
    t3 ? r2.push(e3.trim()) : s2?.onInterim?.(e3);
  }, "onTranscript"), onError: i((e3) => {
    n2 = e3;
  }, "onError"), onClose: i(() => {}, "onClose") }, s2);
  try {
    let e3 = Pt();
    if (!e3)
      throw new Error("No audio converter found. Install ffmpeg or sox.");
    await Ut(a2, t2, e3, s2?.realtime !== false), await a2.finalize();
  } finally {
    a2.close();
  }
  if (n2)
    throw new Error(`Transcription error: ${n2}`);
  return r2.join(" ");
}
function Nt(e2, t2) {
  if (xt("rec")) {
    let i2 = vt("rec", ["-q", "--buffer", "1024", "-t", "raw", "-r", String(Mt), "-e", "signed", "-b", String(16), "-c", String(1), "-", "silence", "1", "0.1", "3%", "1", "2.0", "3%"], { stdio: ["pipe", "pipe", "pipe"] });
    return i2.stdout?.on("data", e2), i2.stderr?.on("data", () => {}), i2.on("close", t2), i2.on("error", t2), { stop() {
      i2.kill("SIGTERM");
    } };
  }
  if (xt("arecord")) {
    let i2 = vt("arecord", ["-f", "S16_LE", "-r", String(Mt), "-c", String(1), "-t", "raw", "-q", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    return i2.stdout?.on("data", e2), i2.stderr?.on("data", () => {}), i2.on("close", t2), i2.on("error", t2), { stop() {
      i2.kill("SIGTERM");
    } };
  }
  return null;
}
function It() {
  return xt("rec") ? { available: true, tool: "sox", installHint: null } : xt("arecord") ? { available: true, tool: "arecord", installHint: null } : { available: false, tool: null, installHint: { darwin: "brew install sox", linux: "sudo apt-get install sox  # or: sudo apt-get install alsa-utils" }[process.platform] ?? "Install SoX (sox) or ALSA utils (arecord)" };
}
function xt(e2) {
  return Et(e2, ["--version"], { stdio: "ignore", timeout: 3000 }).error === undefined;
}
function Lt(e2) {
  return new Promise((t2) => setTimeout(t2, e2));
}
async function Ft(e2) {
  let { readFile: t2 } = await import("fs/promises");
  return t2(e2);
}
function Pt() {
  return xt("ffmpeg") ? "ffmpeg" : xt("sox") ? "sox" : null;
}
async function Ut(e2, t2, i2, s2) {
  let r2 = i2 === "ffmpeg" ? ["-i", t2, "-f", "s16le", "-ar", String(Mt), "-ac", String(1), "pipe:1"] : [t2, "-t", "raw", "-r", String(Mt), "-e", "signed", "-b", String(16), "-c", String(1), "-"], n2 = vt(i2, r2, { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((t3, r3) => {
    let a2 = Date.now();
    n2.stdout?.on("data", async (t4) => {
      if (e2.isConnected()) {
        if (e2.send(t4), s2) {
          let e3 = t4.length / 32000 * 1000, i3 = Date.now() - a2, s3 = Math.max(0, 0.8 * e3 - i3);
          s3 > 10 && (n2.stdout?.pause(), await Lt(s3), n2.stdout?.resume()), a2 = Date.now();
        }
      } else
        n2.kill("SIGTERM");
    }), n2.stderr?.on("data", () => {}), n2.on("close", (e3) => {
      e3 !== 0 && e3 !== null ? r3(new Error(`${i2} exited with code ${e3}`)) : t3();
    }), n2.on("error", r3);
  });
}
i(Ct, "connectVoiceStream"), i(Ot, "transcribeFile"), i(At, "transcribeAudioFile"), i(Nt, "startMicRecording"), i(It, "checkVoiceDeps"), i(xt, "hasCommand"), i(Lt, "sleep"), i(Ft, "readFileAsBuffer"), i(Pt, "findConverter"), i(Ut, "streamConvertedAudio");

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
          const isAdaptive = te(id);
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
