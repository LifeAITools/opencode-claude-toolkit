// @bun
var __require_gv7hsff9 = import.meta.require;

// index.ts
import { createHash, randomBytes } from "crypto";
import { readFileSync as readFileSync4, writeFileSync as writeFileSync4, mkdirSync as mkdirSync4, chmodSync, existsSync as existsSync4, statSync as statSync2 } from "fs";
import { join as join9, dirname as dirname4 } from "path";
import { homedir as homedir9 } from "os";

// provider.ts
import { appendFileSync as _traceWrite } from "fs";

// ../../dist/index.js
import { createHash as n, randomBytes as a } from "crypto";
import { writeFileSync as o, readFileSync as l, mkdirSync as h, chmodSync as c } from "fs";
import { dirname as u, join as d } from "path";
import { homedir as f } from "os";
import { createHash as x, randomBytes as I, randomUUID as M } from "crypto";
import { readFileSync as L, writeFileSync as F, chmodSync as U, mkdirSync as K, rmdirSync as P, statSync as B, unlinkSync as J, appendFileSync as H } from "fs";
import { join as j } from "path";
import { homedir as W } from "os";
import { mkdirSync as ie, readdirSync as se, statSync as re, unlinkSync as ne, writeFileSync as ae } from "fs";
import { createHash as oe } from "crypto";
import { homedir as le } from "os";
import { join as he } from "path";
import { readFileSync as xe, writeFileSync as Ie, mkdirSync as Me } from "fs";
import { dirname as Le } from "path";
import { randomUUID as Fe } from "crypto";
import { readFileSync as Pe, statSync as Be } from "fs";
import { spawn as st, spawnSync as rt } from "child_process";
import { request as nt } from "https";
import { randomBytes as at, createHash as ot } from "crypto";
var e = Object.defineProperty;
var t = Object.getOwnPropertyNames;
var i = (t2, i2) => e(t2, "name", { value: i2, configurable: true });
var s = ((e2) => "function" < "u" ? __require_gv7hsff9 : typeof Proxy < "u" ? new Proxy(e2, { get: (e3, t2) => ("function" < "u" ? __require_gv7hsff9 : e3)[t2] }) : e2)(function(e2) {
  if ("function" < "u")
    return __require_gv7hsff9.apply(this, arguments);
  throw Error('Dynamic require of "' + e2 + '" is not supported');
});
var r = {};
((t2, i2) => {
  for (var s2 in i2)
    e(t2, s2, { get: i2[s2], enumerable: true });
})(r, { getClaudeConfigDir: () => p, getDefaultCredentialsPath: () => m, oauthLogin: () => k });
function p() {
  return (process.env.CLAUDE_CONFIG_DIR ?? d(f(), ".claude")).normalize("NFC");
}
function m() {
  return d(p(), ".credentials.json");
}
function y() {
  return _(a(32));
}
function g(e2) {
  return _(n("sha256").update(e2).digest());
}
function w() {
  return _(a(32));
}
function _(e2) {
  return e2.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
async function k(e2 = {}) {
  let t2 = e2.credentialsPath ?? m(), i2 = y(), s2 = g(i2), r2 = w(), { port: n2, waitForCode: a2, close: d2 } = await E(r2, e2.port), f2 = `http://localhost:${n2}/callback`, p2 = e2.loginWithClaudeAi !== false ? b : S, _2 = new URLSearchParams({ client_id: R, response_type: "code", scope: A, code_challenge: s2, code_challenge_method: "S256", state: r2, code: "true" });
  e2.loginHint && _2.set("login_hint", e2.loginHint), e2.loginMethod && _2.set("login_method", e2.loginMethod), e2.orgUUID && _2.set("orgUUID", e2.orgUUID);
  let k2, v, D = `${p2}?${_2.toString()}&redirect_uri=${encodeURIComponent(f2)}`, C = `${p2}?${_2.toString()}&redirect_uri=${encodeURIComponent(O)}`;
  e2.onAuthUrl ? e2.onAuthUrl(D, C) : (console.log(`
\uD83D\uDD10 Login to Claude
`), console.log(`Open this URL in your browser:
`), console.log(`  ${C}
`)), e2.openBrowser !== false && T(D).catch(() => {});
  try {
    k2 = await a2, v = f2;
  } catch (e3) {
    throw d2(), e3;
  }
  d2();
  let N = await fetch($, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "authorization_code", code: k2, redirect_uri: v, client_id: R, code_verifier: i2, state: r2 }) });
  if (!N.ok) {
    let e3 = await N.text();
    throw new Error(`Token exchange failed (${N.status}): ${e3}`);
  }
  let x2 = await N.json(), I2 = Date.now() + 1000 * x2.expires_in, M2 = { accessToken: x2.access_token, refreshToken: x2.refresh_token, expiresAt: I2, scopes: x2.scope?.split(" ") ?? [] }, L2 = {};
  try {
    L2 = JSON.parse(l(t2, "utf8"));
  } catch {}
  L2.claudeAiOauth = M2;
  let F2 = u(t2);
  try {
    h(F2, { recursive: true });
  } catch {}
  return o(t2, JSON.stringify(L2, null, 2), "utf8"), c(t2, 384), console.log(`
\u2705 Login successful! Credentials saved to ${t2}
`), { accessToken: M2.accessToken, refreshToken: M2.refreshToken, expiresAt: M2.expiresAt, credentialsPath: t2 };
}
async function E(e2, t2) {
  let s2, r2, n2 = new Promise((e3, t3) => {
    s2 = e3, r2 = t3;
  }), a2 = Bun.serve({ port: t2 ?? 0, async fetch(t3) {
    let i2 = new URL(t3.url);
    if (i2.pathname !== "/callback")
      return new Response("Not found", { status: 404 });
    let n3 = i2.searchParams.get("code"), a3 = i2.searchParams.get("state"), o3 = i2.searchParams.get("error");
    return o3 ? (r2(new Error(`OAuth error: ${o3} \u2014 ${i2.searchParams.get("error_description") ?? ""}`)), new Response("<html><body><h1>Login failed</h1><p>You can close this tab.</p></body></html>", { status: 400, headers: { "Content-Type": "text/html" } })) : n3 && a3 === e2 ? (s2(n3), new Response(null, { status: 302, headers: { Location: `${v}/oauth/code/success?app=claude-code` } })) : (r2(new Error("Invalid callback: missing code or state mismatch")), new Response("Invalid request", { status: 400 }));
  } }), o2 = setTimeout(() => {
    r2(new Error("Login timed out (5 minutes). Try again.")), a2.stop();
  }, 300000);
  return { port: a2.port, waitForCode: n2.finally(() => clearTimeout(o2)), close: i(() => {
    clearTimeout(o2), a2.stop();
  }, "close") };
}
async function T(e2) {
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
var R;
var v;
var S;
var b;
var $;
var O;
var A;
var D;
var C;
var N = (D = { "src/auth.ts"() {
  R = "9d1c250a-e61b-44d9-88ed-5944d1962f5e", S = (v = "https://platform.claude.com") + "/oauth/authorize", b = "https://claude.com/cai/oauth/authorize", $ = `${v}/v1/oauth/token`, O = `${v}/oauth/code/callback`, i(p, "getClaudeConfigDir"), i(m, "getDefaultCredentialsPath"), A = ["user:profile", "user:inference", "org:create_api_key", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"].join(" "), i(y, "generateCodeVerifier"), i(g, "generateCodeChallenge"), i(w, "generateState"), i(_, "base64url"), i(k, "oauthLogin"), i(E, "startCallbackServer"), i(T, "tryOpenBrowser");
} }, function() {
  return D && (C = (0, D[t(D)[0]])(D = 0)), C;
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
var ce = he(le(), ".claude", "keepalive.json");
var ue = 0;
var de = null;
function fe() {
  try {
    let e2 = re(ce);
    if (e2.mtimeMs === ue && de)
      return de;
    ue = e2.mtimeMs;
    let { readFileSync: t2 } = s("fs");
    return de = JSON.parse(t2(ce, "utf8"));
  } catch {
    return null;
  }
}
function pe(e2) {
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
  let s2 = t2.code ?? t2.cause?.code ?? "", r2 = (t2.message ?? "").toLowerCase();
  return s2 && new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EHOSTDOWN", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_ABORTED", "ConnectionRefused", "FailedToOpenSocket"]).has(s2) || r2.includes("unable to connect") || r2.includes("failed to open socket") || r2.includes("connection refused") || r2.includes("network is unreachable") || r2.includes("timeout") || r2.includes("dns") ? "network" : "server_transient";
}
i(fe, "readKeepaliveConfig"), i(pe, "classifyError");
var me = class _KeepaliveEngine {
  static {
    i(this, "KeepaliveEngine");
  }
  static CACHE_TTL_MS = 300000;
  static CACHE_SAFETY_MARGIN_MS = 15000;
  static KEEPALIVE_RETRY_DELAYS = [2, 3, 5, 7, 10, 12, 15, 17, 20, 20, 20, 20, 20];
  static SNAPSHOT_TTL_MS = 60 * (parseInt(process.env.CLAUDE_SDK_SNAPSHOT_TTL_MIN ?? "1440", 10) || 1440) * 1000;
  static DUMP_BODY = process.env.CLAUDE_SDK_DUMP_BODY === "1";
  static HEALTH_PROBE_INTERVALS_MS = [3000, 5000, 7000, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4, 1e4];
  static HEALTH_PROBE_TIMEOUT_MS = 3000;
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
  t = "";
  i = null;
  o = null;
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
    let t2 = e2.config ?? {}, i2 = t2.intervalMs ?? 120000;
    i2 < 60000 && (console.error(`[claude-sdk] keepalive intervalMs=${i2} below safe min (60000); clamped`), i2 = 60000), i2 > 240000 && (console.error(`[claude-sdk] keepalive intervalMs=${i2} above safe max (240000, cache TTL - 60s); clamped`), i2 = 240000), this.config = { enabled: t2.enabled ?? true, intervalMs: i2, idleTimeoutMs: t2.idleTimeoutMs ?? 1 / 0, minTokens: t2.minTokens ?? 2000, rewriteWarnIdleMs: t2.rewriteWarnIdleMs ?? 300000, rewriteWarnTokens: t2.rewriteWarnTokens ?? 50000, rewriteBlockIdleMs: t2.rewriteBlockIdleMs ?? 1 / 0, rewriteBlockEnabled: t2.rewriteBlockEnabled ?? false, onHeartbeat: t2.onHeartbeat, onTick: t2.onTick, onDisarmed: t2.onDisarmed, onRewriteWarning: t2.onRewriteWarning, onNetworkStateChange: t2.onNetworkStateChange };
  }
  notifyRealRequestStart(e2, t2, i2) {
    this.t = e2, this.i = JSON.parse(JSON.stringify(t2)), this.o = { ...i2 }, this.abortController?.abort(), this.inFlight = false;
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
    let i2 = this.t, s2 = this.i, r2 = this.o;
    if (i2 && s2 && r2) {
      let t3 = (e2.inputTokens ?? 0) + (e2.cacheReadInputTokens ?? 0) + (e2.cacheCreationInputTokens ?? 0), n2 = this.registry.get(i2);
      t3 >= this.config.minTokens && (!n2 || t3 >= n2.inputTokens) && this.registry.set(i2, { body: s2, headers: r2, model: i2, inputTokens: t3 }), t3 > (this.lastKnownCacheTokensByModel.get(i2) ?? 0) && this.lastKnownCacheTokensByModel.set(i2, t3), this.writeSnapshotDebug(i2, s2, e2), this.i = null, this.o = null;
    }
    this.registry.size > 0 && this.startTimer();
  }
  checkRewriteGuard(e2) {
    let t2 = this.lastRealActivityAt;
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
    if (this.cacheWrittenAt > 0 && Date.now() - this.cacheWrittenAt > _KeepaliveEngine.CACHE_TTL_MS)
      return this.registry.clear(), void this.onDisarmed("cache_expired_during_sleep");
    let e2 = fe();
    if (e2) {
      if (e2.enabled === false)
        return this.registry.clear(), void this.stop();
      typeof e2.intervalSec == "number" && e2.intervalSec > 0 && (this.config.intervalMs = 1000 * e2.intervalSec), typeof e2.idleTimeoutSec == "number" && e2.idleTimeoutSec > 0 ? this.config.idleTimeoutMs = 1000 * e2.idleTimeoutSec : (e2.idleTimeoutSec === null || e2.idleTimeoutSec === 0) && (this.config.idleTimeoutMs = 1 / 0), typeof e2.minTokens == "number" && (this.config.minTokens = e2.minTokens);
    }
    let t2 = Date.now() - this.lastRealActivityAt;
    if (this.config.idleTimeoutMs !== 1 / 0 && t2 > this.config.idleTimeoutMs)
      return this.registry.clear(), void this.stop();
    let i2 = null;
    for (let e3 of this.registry.values())
      (!i2 || e3.inputTokens > i2.inputTokens) && (i2 = e3);
    if (!i2)
      return;
    let s2 = Date.now() - this.lastActivityAt;
    if (this.jitterMs || (this.jitterMs = Math.floor(30000 * Math.random())), s2 < 0.9 * this.config.intervalMs + this.jitterMs)
      this.config.onTick?.({ idleMs: s2, nextFireMs: Math.max(0, this.config.intervalMs - s2), model: i2.model, tokens: i2.inputTokens });
    else {
      this.inFlight = true;
      try {
        let e3 = await this.getToken(), t3 = JSON.parse(JSON.stringify(i2.body)), r2 = t3.thinking?.budget_tokens ?? 0;
        t3.max_tokens = r2 > 0 ? r2 + 1 : 1;
        let n2 = { ...i2.headers, Authorization: `Bearer ${e3}` }, a2 = new AbortController;
        this.abortController = a2;
        let o2 = Date.now(), l2 = { inputTokens: 0, outputTokens: 0 };
        for await (let e4 of this.doFetch(t3, n2, a2.signal))
          e4.type === "message_stop" && (l2 = e4.usage);
        let h2 = Date.now() - o2;
        this.lastActivityAt = Date.now(), this.cacheWrittenAt = Date.now();
        let c2 = this.getRateLimitInfo();
        this.config.onHeartbeat?.({ usage: l2, durationMs: h2, idleMs: s2, model: i2.model, rateLimit: { status: c2.status, claim: c2.claim, resetAt: c2.resetAt } });
      } catch (e3) {
        let t3 = pe(e3);
        if (t3 === "network") {
          let e4 = Date.now() - this.cacheWrittenAt, t4 = _KeepaliveEngine.CACHE_TTL_MS - e4 <= 15000;
          this.onDisarmed("network_error"), this.startHealthProbe({ reviveMode: t4 });
        } else
          t3 === "server_transient" ? this.retryChain(i2) : t3 === "auth" ? (this.registry.clear(), this.onDisarmed("auth_error")) : (this.registry.clear(), this.onDisarmed("permanent_error"));
      } finally {
        this.inFlight = false, this.abortController = null;
      }
    }
  }
  retryChain(e2, t2 = 0) {
    if (t2 >= _KeepaliveEngine.KEEPALIVE_RETRY_DELAYS.length)
      return this.registry.clear(), void this.onDisarmed("retry_exhausted");
    let i2 = Date.now() - this.cacheWrittenAt, s2 = _KeepaliveEngine.CACHE_TTL_MS - i2, r2 = 1000 * _KeepaliveEngine.KEEPALIVE_RETRY_DELAYS[t2];
    if (s2 < r2 + _KeepaliveEngine.CACHE_SAFETY_MARGIN_MS)
      return this.registry.clear(), void this.onDisarmed("cache_ttl_exhausted");
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try {
        if (!this.isOwnerAlive())
          return this.registry.clear(), this.stop(), void this.onDisarmed("owner_dead");
      } catch {}
      if (!(this.lastRealActivityAt > this.cacheWrittenAt)) {
        if (Date.now() - this.cacheWrittenAt > _KeepaliveEngine.CACHE_TTL_MS - _KeepaliveEngine.CACHE_SAFETY_MARGIN_MS)
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
          let s3 = pe(i3);
          if (s3 === "network") {
            this.inFlight = false, this.abortController = null;
            let e3 = _KeepaliveEngine.CACHE_TTL_MS - (Date.now() - this.cacheWrittenAt) <= _KeepaliveEngine.CACHE_SAFETY_MARGIN_MS;
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
    if (new Set(["retry_exhausted", "cache_ttl_exhausted", "cache_ttl_expired_mid_retry"]).has(e2) && !this.healthProbeTimer) {
      let e3 = Date.now() - this.cacheWrittenAt, t2 = _KeepaliveEngine.CACHE_TTL_MS - e3 <= _KeepaliveEngine.CACHE_SAFETY_MARGIN_MS;
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
      let e3 = _KeepaliveEngine.HEALTH_PROBE_INTERVALS_MS, t3 = e3[Math.min(this.healthProbeAttempt, e3.length - 1)];
      this.healthProbeTimer = setTimeout(r2, t3), this.healthProbeTimer && typeof this.healthProbeTimer == "object" && "unref" in this.healthProbeTimer && this.healthProbeTimer.unref();
    }, "scheduleNext"), r2 = i(async () => {
      if (this.healthProbeTimer = null, this.healthProbeAttempt++, Date.now() - this.cacheWrittenAt >= _KeepaliveEngine.CACHE_TTL_MS - _KeepaliveEngine.CACHE_SAFETY_MARGIN_MS && !e2.reviveMode)
        return void this.stopHealthProbe();
      if (this.healthProbeAttempt > _KeepaliveEngine.HEALTH_PROBE_INTERVALS_MS.length)
        return void this.stopHealthProbe();
      let t3 = false;
      try {
        let { connect: e3 } = await import("net");
        await new Promise((t4, i3) => {
          let s3 = e3({ host: "api.anthropic.com", port: 443 }), r4 = setTimeout(() => {
            s3.destroy(), i3(new Error("timeout"));
          }, _KeepaliveEngine.HEALTH_PROBE_TIMEOUT_MS);
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
      let r3 = _KeepaliveEngine.CACHE_TTL_MS - (Date.now() - this.cacheWrittenAt);
      this.registry.size > 0 && r3 > _KeepaliveEngine.CACHE_SAFETY_MARGIN_MS && this.tick();
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
  get l() {
    return this.registry;
  }
  get h() {
    return this.timer;
  }
  get u() {
    return this.config;
  }
  get p() {
    return this.lastKnownCacheTokensByModel;
  }
  m(e2) {
    this.lastRealActivityAt = e2;
  }
  _(e2, t2, i2) {
    this.t = e2, this.i = t2, this.o = i2;
  }
};
var ye = 300000;
var ge = 0.25;
var we = 300000;
var _e = 1200000;
var ke = j(W(), ".claude", ".refresh-cooldown");
var Ee = 1800000;
var Te = "2.1.90";
var Re = { todowrite: "todo_write" };
var ve = Object.fromEntries(Object.entries(Re).map(([e2, t2]) => [t2, e2]));
function Se(e2) {
  if (!e2?.length)
    return { remapped: e2, didRemap: false };
  let t2 = false;
  return { remapped: e2.map((e3) => {
    let i2 = Re[e3.name];
    return i2 ? (t2 = true, { ...e3, name: i2 }) : e3;
  }), didRemap: t2 };
}
function be(e2) {
  return ve[e2] ?? e2;
}
i(Se, "remapToolNames"), i(be, "unremapToolName");
var $e = j(W(), ".claude", ".token-refresh-lock");
async function Oe() {
  for (let e2 = 0;e2 < 5; e2++)
    try {
      return K($e), F(j($e, "pid"), `${process.pid}
${Date.now()}`), () => {
        try {
          J(j($e, "pid")), P($e);
        } catch {}
      };
    } catch (e3) {
      if (e3.code === "EEXIST") {
        try {
          let e4 = L(j($e, "pid"), "utf8"), t2 = parseInt(e4.split(`
`)[1] ?? "0");
          if (Date.now() - t2 > 30000) {
            try {
              J(j($e, "pid"));
            } catch {}
            try {
              P($e);
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
i(Oe, "acquireTokenRefreshLock");
var Ae = class {
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
  k = null;
  constructor(e2 = {}) {
    this.sessionId = M(), this.deviceId = e2.deviceId ?? I(32).toString("hex"), this.accountUuid = e2.accountUuid ?? this.readAccountUuid(), this.timeout = e2.timeout ?? 600000, this.maxRetries = e2.maxRetries ?? 10, this.onTokenStatus = e2.onTokenStatus, this.keepalive = new me({ config: e2.keepalive, getToken: i(async () => (await this.ensureAuth(), this.accessToken ?? ""), "getToken"), doFetch: i((e3, t2, i2) => this.doStreamRequest(e3, t2, i2), "doFetch"), getRateLimitInfo: i(() => this.lastRateLimitInfo, "getRateLimitInfo") }), e2.credentialStore ? this.credentialStore = e2.credentialStore : e2.accessToken ? (this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken ?? null, this.expiresAt = e2.expiresAt ?? null, this.credentialStore = new Ce({ accessToken: e2.accessToken, refreshToken: e2.refreshToken ?? "", expiresAt: e2.expiresAt ?? 0 }), this.expiresAt && this.refreshToken && this.scheduleProactiveRotation()) : (this.credentialStore = new De(e2.credentialsPath ?? j(W(), ".claude", ".credentials.json")), this.initialLoad = this.loadFromStore().catch(() => {}));
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
    this.keepalive.notifyRealRequestStart(e2.model, i2, s2), this.k = null;
    for (let r2 = 1;r2 <= this.maxRetries + 1; r2++) {
      if (e2.signal?.aborted)
        throw new q("Aborted");
      try {
        return yield* this.doStreamRequest(i2, s2, e2.signal), void (this.k && (this.keepalive.notifyRealRequestComplete(this.k), this.k = null));
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
      i3(j(W(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_START pid=${process.pid} model=${e2.model} msgs=${e2.messages?.length ?? 0}
`);
      let r3 = e2.tools?.map((e3) => e3.name).join(",") ?? "none", n3 = typeof e2.system == "string" ? e2.system.substring(0, 200) : JSON.stringify(e2.system)?.substring(0, 200);
      if (i3(j(W(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_REQ pid=${process.pid} headers=${JSON.stringify(t2).substring(0, 300)} tools=[${r3.substring(0, 500)}] sys=${n3} bodyLen=${l2.length}
`), process.env.CLAUDE_MAX_DUMP_REQUESTS === "1") {
        let s2 = { ...e2, messages: `[${e2.messages?.length ?? 0} messages]`, system: `[${typeof e2.system == "string" ? e2.system.length : "array"}]` };
        i3(j(W(), ".claude", "claude-max-request-dump.jsonl"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, headers: t2, body: s2 }) + `
`);
      }
    } catch {}
    try {
      a2 = await fetch("https://api.anthropic.com/v1/messages?beta=true", { method: "POST", headers: t2, body: l2, signal: r2.signal });
    } catch (e3) {
      clearTimeout(n2);
      try {
        let { appendFileSync: t3 } = s("fs");
        t3(j(W(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_ERROR pid=${process.pid} ttfb=${Date.now() - o2}ms err=${e3.message}
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
      e3(j(W(), ".claude", "claude-max-api-responses.log"), JSON.stringify(i3) + `
`), e3(j(W(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] API_RESPONSE pid=${process.pid} status=${a2.status} ttfb=${Date.now() - o2}ms
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
        }), i3(j(W(), ".claude", "claude-max-api-responses.log"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, type: "ERROR", status: a2.status, requestId: t3, headers: r3, body: e3.slice(0, 5000), rateLimitInfo: this.lastRateLimitInfo }) + `
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
                H(j(W(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] RAW_USAGE: ${JSON.stringify(e5)}
`);
              } catch {}
            }
            continue;
          }
          if (r3 === "content_block_start") {
            let { index: e5, content_block: i4 } = t3;
            if (i4.type === "tool_use") {
              let t4 = be(i4.name);
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
          r3 === "message_stop" && (this.k = o2, yield { type: "message_stop", usage: o2, stopReason: l2 });
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
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}`, "anthropic-version": "2023-06-01", "anthropic-beta": t2.join(","), "anthropic-dangerous-direct-browser-access": "true", "x-app": "cli", "User-Agent": `claude-cli/${Te}`, "X-Claude-Code-Session-Id": this.sessionId };
  }
  buildRequestBody(e2) {
    let t2, i2 = this.computeFingerprint(e2.messages), s2 = `x-anthropic-billing-header: cc_version=${Te}.${i2}; cc_entrypoint=cli; cch=00000;`;
    t2 = (typeof e2.system == "string" ? e2.system : Array.isArray(e2.system) ? JSON.stringify(e2.system) : "").includes("x-anthropic-billing-header") ? e2.system : typeof e2.system == "string" ? s2 + `
` + e2.system : Array.isArray(e2.system) ? [{ type: "text", text: s2 }, ...e2.system] : s2;
    let r2 = { model: e2.model, messages: e2.messages, max_tokens: Z(e2.model, e2.maxTokens), stream: true, system: t2, metadata: { user_id: JSON.stringify({ device_id: this.deviceId, account_uuid: this.accountUuid, session_id: this.sessionId }) } };
    if (e2.tools && e2.tools.length > 0) {
      let { remapped: t3 } = Se(e2.tools);
      if (r2.tools = t3, e2.toolChoice) {
        let t4 = typeof e2.toolChoice == "string" ? { type: e2.toolChoice } : { ...e2.toolChoice };
        t4.type === "tool" && t4.name && Re[t4.name] && (t4.name = Re[t4.name]), r2.tool_choice = t4;
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
      return this.pendingAuth || (this.pendingAuth = this.T().finally(() => {
        this.pendingAuth = null;
      })), this.pendingAuth;
  }
  async T() {
    this.accessToken && !this.isTokenExpired() || this.credentialStore.hasChanged && await this.credentialStore.hasChanged() && (await this.loadFromStore(), this.accessToken && !this.isTokenExpired()) || !this.accessToken && (await this.loadFromStore(), this.accessToken && !this.isTokenExpired()) || this.accessToken && this.isTokenExpired() && await this.refreshTokenWithTripleCheck();
  }
  async loadFromStore() {
    let e2 = await this.credentialStore.read();
    if (!e2?.accessToken)
      throw new z('No OAuth tokens found. Run "claude login" first or provide credentials.');
    this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken, this.expiresAt = e2.expiresAt, !this.tokenIssuedAt && this.expiresAt && (this.tokenIssuedAt = Date.now()), this.scheduleProactiveRotation();
  }
  isTokenExpired() {
    return !!this.expiresAt && Date.now() + ye >= this.expiresAt;
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
      let { oauthLogin: e2 } = await Promise.resolve().then(() => (N(), r)), t2 = this.credentialStore instanceof De ? this.credentialStore.path : j(W(), ".claude", ".credentials.json"), i2 = await e2({ credentialsPath: t2 });
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
    return e2 = i2 <= 0 ? "expired" : r2 < 0.1 ? "critical" : r2 < ge ? "warning" : "healthy", { expiresAt: this.expiresAt, expiresInMs: i2, lifetimePct: r2, failedRefreshes: this.proactiveRefreshFailures, status: e2 };
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
    let i2 = Math.max(0.5 * t2, we), s2 = Math.floor(60000 * Math.random()), r2 = Math.min(i2 + s2, t2 - ye);
    if (r2 <= 0)
      return this.dbg(`proactive rotation: delay=${r2}ms <= 0, scheduling emergency refresh in 30s`), void (this.tokenRotationTimer || (this.tokenRotationTimer = setTimeout(() => {
        this.tokenRotationTimer = null, this.proactiveRefresh();
      }, 30000), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && ("unref" in this.tokenRotationTimer) && this.tokenRotationTimer.unref()));
    let n2 = this.tokenIssuedAt > 0 ? this.expiresAt - this.tokenIssuedAt : 2 * t2, a2 = n2 > 0 ? t2 / n2 : 1;
    a2 < 0.1 && this.proactiveRefreshFailures > 0 ? (this.dbg(`\u26A0\uFE0F CRITICAL: token ${Math.round(100 * a2)}% life left, ${this.proactiveRefreshFailures} failed refreshes`), this.emitTokenStatus("critical", `Token ${Math.round(100 * a2)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)) : a2 < ge && this.proactiveRefreshFailures > 0 && (this.dbg(`\u26A0 WARNING: token ${Math.round(100 * a2)}% life left, ${this.proactiveRefreshFailures} failed refreshes`), this.emitTokenStatus("warning", `Token ${Math.round(100 * a2)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)), this.dbg(`proactive rotation scheduled in ${Math.round(r2 / 1000)}s (expires in ${Math.round(t2 / 1000)}s, ${Math.round(100 * a2)}% life, failures=${this.proactiveRefreshFailures})`), this.tokenRotationTimer = setTimeout(() => {
      this.tokenRotationTimer = null, this.proactiveRefresh();
    }, r2), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && "unref" in this.tokenRotationTimer && this.tokenRotationTimer.unref();
  }
  async proactiveRefresh() {
    if (this.isRefreshOnCooldown()) {
      try {
        let e3 = await this.credentialStore.read();
        if (e3 && !(Date.now() + ye >= e3.expiresAt)) {
          let t3 = e3.expiresAt - Date.now();
          if (t3 >= _e)
            return this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.dbg(`proactive refresh: picked up fresh token during cooldown (${Math.round(t3 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(t3 / 60000)}min remaining)`), void this.scheduleProactiveRotation();
          this.dbg(`proactive refresh: disk token has only ${Math.round(t3 / 60000)}min left (need ${Math.round(20)}min) \u2014 waiting for cooldown`);
        }
      } catch {}
      if (this.dbg("proactive refresh skipped: global cooldown active, no fresh token found"), !this.tokenRotationTimer) {
        let e3 = Math.max(we, 60000);
        this.tokenRotationTimer = setTimeout(() => {
          this.tokenRotationTimer = null, this.proactiveRefresh();
        }, e3), this.tokenRotationTimer && typeof this.tokenRotationTimer == "object" && "unref" in this.tokenRotationTimer && this.tokenRotationTimer.unref();
      }
      return;
    }
    let e2 = Date.now();
    if (e2 - this.lastRefreshAttemptAt < we)
      return void this.dbg("proactive refresh skipped: too recent");
    this.lastRefreshAttemptAt = e2, this.dbg("proactive rotation: refreshing token silently...");
    let t2 = await Oe();
    try {
      if (t2) {
        let e4 = await this.credentialStore.read();
        if (e4 && !(Date.now() + ye >= e4.expiresAt)) {
          let t3 = e4.expiresAt - Date.now();
          if (t3 >= _e)
            return this.accessToken = e4.accessToken, this.refreshToken = e4.refreshToken, this.expiresAt = e4.expiresAt, this.tokenIssuedAt = Date.now(), this.proactiveRefreshFailures = 0, this.dbg(`proactive rotation: picked up fresh token from lock winner (${Math.round(t3 / 60000)}min remaining)`), this.emitTokenStatus("rotated", `Token refreshed by another process (${Math.round(t3 / 60000)}min remaining)`), void this.scheduleProactiveRotation();
        }
      }
      let e3 = this.expiresAt ?? 0;
      await this.doTokenRefresh(true), this.proactiveRefreshFailures = 0, this.refreshConsecutive429s = 0, this.clearRefreshCooldown(), this.tokenIssuedAt = Date.now();
      let i2 = (this.expiresAt ?? 0) - Date.now(), s2 = e3 > 0 ? e3 - (this.tokenIssuedAt - 1000) : 2 * i2;
      i2 > 0 && i2 < 0.5 * s2 && this.dbg(`\u26A0\uFE0F SHRINKING TOKEN: new ${Math.round(i2 / 60000)}min vs prev ${Math.round(s2 / 60000)}min \u2014 backing off rotation`), this.dbg(`proactive rotation SUCCESS \u2014 new token expires at ${new Date(this.expiresAt).toISOString()} (${Math.round(i2 / 60000)}min lifetime)`), this.emitTokenStatus("rotated", `Token rotated silently \u2014 expires ${new Date(this.expiresAt).toISOString()}`), this.scheduleProactiveRotation();
    } catch (e3) {
      this.proactiveRefreshFailures++;
      let t3 = e3?.message ?? String(e3);
      if (this.dbg(`proactive rotation FAILED (#${this.proactiveRefreshFailures}): ${t3}`), t3.includes("429") || t3.includes("rate limit")) {
        this.refreshConsecutive429s++;
        let e4 = Math.min(we * Math.pow(2, this.refreshConsecutive429s), Ee);
        this.setRefreshCooldown(e4), this.dbg(`proactive rotation: 429 cooldown ${Math.round(e4 / 1000)}s (attempt #${this.refreshConsecutive429s})`);
      }
      let i2 = this.expiresAt ? this.expiresAt - Date.now() : 0, s2 = this.tokenIssuedAt > 0 && this.expiresAt ? this.expiresAt - this.tokenIssuedAt : 2 * i2, r2 = s2 > 0 ? i2 / s2 : 0;
      i2 <= ye ? this.emitTokenStatus("expired", `Token expired after ${this.proactiveRefreshFailures} failed refresh attempts: ${t3}`) : r2 < 0.1 ? this.emitTokenStatus("critical", `CRITICAL: ${Math.round(i2 / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${t3}. Consider forceReLogin()`) : r2 < ge && this.emitTokenStatus("warning", `WARNING: ${Math.round(i2 / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${t3}`), this.expiresAt && this.expiresAt > Date.now() + ye ? this.scheduleProactiveRotation() : (this.dbg("proactive rotation: token nearly expired \u2014 emitting expired status"), this.emitTokenStatus("expired", `Token expired \u2014 refresh failed ${this.proactiveRefreshFailures} times. Call forceReLogin() to recover.`));
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
      let e2 = L(ke, "utf8"), t2 = parseInt(e2.trim());
      if (Date.now() < t2)
        return true;
      try {
        J(ke);
      } catch {}
    } catch {}
    return false;
  }
  setRefreshCooldown(e2) {
    try {
      let t2 = j(W(), ".claude");
      try {
        K(t2, { recursive: true });
      } catch {}
      F(ke, `${Date.now() + e2}
`);
    } catch {}
  }
  clearRefreshCooldown() {
    try {
      J(ke);
    } catch {}
    this.refreshConsecutive429s = 0;
  }
  dbg(e2) {
    try {
      H(j(W(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_ROTATION pid=${process.pid} ${e2}
`);
    } catch {}
  }
  async refreshTokenWithTripleCheck() {
    let e2 = await this.credentialStore.read();
    if (e2 && !(Date.now() + ye >= e2.expiresAt))
      return this.accessToken = e2.accessToken, this.refreshToken = e2.refreshToken, void (this.expiresAt = e2.expiresAt);
    let t2 = await Oe();
    try {
      if (t2) {
        let e3 = await this.credentialStore.read();
        if (e3 && !(Date.now() + ye >= e3.expiresAt))
          return this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, void (this.expiresAt = e3.expiresAt);
      }
      await this.doTokenRefresh();
    } finally {
      t2 && t2();
    }
  }
  async handleAuth401() {
    let e2 = this.accessToken;
    this.pending401 && this.lastFailedToken === e2 || (this.lastFailedToken = e2, this.pending401 = (async () => {
      let t2 = await this.credentialStore.read();
      return t2 && t2.accessToken !== e2 ? (this.accessToken = t2.accessToken, this.refreshToken = t2.refreshToken, this.expiresAt = t2.expiresAt, true) : (await this.doTokenRefresh(), true);
    })().finally(() => {
      this.pending401 = null, this.lastFailedToken = null;
    })), await this.pending401;
  }
  async doTokenRefresh(e2 = false) {
    if (!this.refreshToken)
      throw new z("Token expired and no refresh token available.");
    if (this.isRefreshOnCooldown() && !e2) {
      let e3 = await this.credentialStore.read();
      if (e3 && !(Date.now() + ye >= e3.expiresAt))
        return this.accessToken = e3.accessToken, this.refreshToken = e3.refreshToken, this.expiresAt = e3.expiresAt, void this.dbg("refresh skipped (cooldown) \u2014 another process already refreshed");
      if (this.expiresAt && this.expiresAt > Date.now() + 600000)
        throw new z("Token refresh on cooldown due to rate limiting. Will retry later.");
      this.dbg("refresh: ignoring cooldown \u2014 token critically close to expiry");
    }
    let t2 = [500, 1500, 3000, 5000, 8000];
    for (let i3 = 0;i3 < 5; i3++) {
      let s2 = await this.credentialStore.read();
      if (s2 && !(Date.now() + ye >= s2.expiresAt)) {
        if (!e2)
          return this.accessToken = s2.accessToken, this.refreshToken = s2.refreshToken, this.expiresAt = s2.expiresAt, void this.dbg(`refresh: another process already refreshed (attempt ${i3})`);
        let t3 = s2.expiresAt - Date.now();
        if (s2.accessToken !== this.accessToken && t3 >= _e)
          return this.accessToken = s2.accessToken, this.refreshToken = s2.refreshToken, this.expiresAt = s2.expiresAt, void this.dbg(`refresh: another process got fresh token (${Math.round(t3 / 60000)}min remaining) (attempt ${i3})`);
        s2.accessToken !== this.accessToken ? (this.accessToken = s2.accessToken, this.refreshToken = s2.refreshToken, this.expiresAt = s2.expiresAt, this.dbg(`refresh: force=true, disk token different but only ${Math.round(t3 / 60000)}min left \u2014 proceeding to actual refresh (attempt ${i3})`)) : this.dbg(`refresh: force=true, token still same, proceeding to actual refresh (attempt ${i3})`);
      }
      let r2 = await fetch("https://platform.claude.com/v1/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: this.refreshToken, client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e" }), signal: AbortSignal.timeout(15000) });
      if (r2.ok) {
        let e3 = await r2.json();
        this.accessToken = e3.access_token, this.refreshToken = e3.refresh_token ?? this.refreshToken, this.expiresAt = Date.now() + 1000 * e3.expires_in, this.tokenIssuedAt = Date.now();
        let t3 = await this.credentialStore.read(), i4 = t3?.scopes?.length ? t3.scopes : ["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"];
        return await this.credentialStore.write({ accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.expiresAt, scopes: i4 }), this.dbg(`token refreshed OK \u2014 expires in ${Math.round(e3.expires_in / 60)}min at ${new Date(this.expiresAt).toISOString()}`), void this.scheduleProactiveRotation();
      }
      if ((r2.status === 429 || r2.status >= 500) && i3 < 4) {
        let e3 = t2[i3] ?? 8000, s3 = Math.random() * e3 * 0.5;
        if (this.dbg(`TOKEN_REFRESH_RETRY status=${r2.status} attempt=${i3 + 1}/5 delay=${Math.round(e3 + s3)}ms`), r2.status === 429) {
          let t3 = Math.min(3 * (e3 + s3), Ee);
          this.setRefreshCooldown(t3);
        }
        await new Promise((t3) => setTimeout(t3, e3 + s3));
        continue;
      }
      throw new z(`Token refresh failed: ${r2.status} ${r2.statusText}`);
    }
    let i2 = await this.credentialStore.read();
    if (!i2 || Date.now() + ye >= i2.expiresAt)
      throw new z("Token refresh failed after all retries and race recovery");
    this.accessToken = i2.accessToken, this.refreshToken = i2.refreshToken, this.expiresAt = i2.expiresAt;
    try {
      H(j(W(), ".claude", "claude-max-debug.log"), `[${new Date().toISOString()}] TOKEN_REFRESH_RACE_RECOVERY pid=${process.pid}
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
    let i2 = `59cf53e54c78${[4, 7, 20].map((e3) => t2[e3] || "0").join("")}${Te}`;
    return x("sha256").update(i2).digest("hex").slice(0, 3);
  }
  readAccountUuid() {
    try {
      let e2 = j(W(), ".claude", "claude_code_config.json");
      return JSON.parse(L(e2, "utf8")).oauthAccount?.accountUuid ?? "";
    } catch {
      return "";
    }
  }
};
var De = class {
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
      K(i2, { recursive: true });
    } catch {}
    F(this.path, JSON.stringify(t2, null, 2), "utf8"), U(this.path, 384), this.lastMtimeMs = this.getMtime();
  }
  async hasChanged() {
    let e2 = this.getMtime();
    return e2 !== this.lastMtimeMs && (this.lastMtimeMs = e2, true);
  }
  getMtime() {
    try {
      return B(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }
};
var Ce = class {
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
var Ne = class _Conversation {
  static {
    i(this, "Conversation");
  }
  sdk;
  options;
  R = [];
  v = { inputTokens: 0, outputTokens: 0 };
  constructor(e2, t2) {
    this.sdk = e2, this.options = t2;
  }
  get messages() {
    return this.R;
  }
  get totalUsage() {
    return { ...this.v };
  }
  get length() {
    return this.R.length;
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
    o2.length > 0 && this.R.push({ role: "assistant", content: o2 }), this.accumulateUsage(a2);
  }
  addToolResult(e2, t2, i2) {
    let s2 = { type: "tool_result", tool_use_id: e2, content: t2, ...i2 && { is_error: true } };
    this.R.push({ role: "user", content: [s2] });
  }
  addToolResults(e2) {
    let t2 = e2.map((e3) => ({ type: "tool_result", tool_use_id: e3.toolUseId, content: e3.content, ...e3.isError && { is_error: true } }));
    this.R.push({ role: "user", content: t2 });
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
    n2.length > 0 && this.R.push({ role: "assistant", content: n2 }), this.accumulateUsage(r2);
  }
  rewind(e2) {
    if (e2 < 0 || e2 >= this.R.length)
      throw new Error(`Invalid rewind index: ${e2}`);
    return this.R.splice(e2);
  }
  undoLastTurn() {
    for (let e2 = this.R.length - 1;e2 >= 0; e2--) {
      let t2 = this.R[e2];
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
    return e2.R = [...this.R], e2.v = { ...this.v }, e2;
  }
  getHistory() {
    return this.R.map((e2, t2) => {
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
    this.R.push({ role: "user", content: e2 });
  }
  appendAssistantFromResponse(e2) {
    let t2 = [];
    for (let i2 of e2.content)
      i2.type === "text" ? t2.push({ type: "text", text: i2.text }) : i2.type === "tool_use" && t2.push({ type: "tool_use", id: i2.id, name: i2.name, input: i2.input });
    t2.length > 0 && this.R.push({ role: "assistant", content: t2 });
  }
  buildGenerateOptions(e2) {
    return { model: this.options.model, messages: [...this.R], system: this.options.system, tools: e2?.tools ?? this.options.tools, toolChoice: e2?.toolChoice ?? this.options.toolChoice, maxTokens: this.options.maxTokens, thinking: this.options.thinking, effort: this.options.effort, fast: this.options.fast, signal: e2?.signal ?? this.options.signal, extraBetas: this.options.extraBetas, caching: this.options.caching };
  }
  accumulateUsage(e2) {
    this.v.inputTokens += e2.inputTokens, this.v.outputTokens += e2.outputTokens, this.v.cacheCreationInputTokens = (this.v.cacheCreationInputTokens ?? 0) + (e2.cacheCreationInputTokens ?? 0), this.v.cacheReadInputTokens = (this.v.cacheReadInputTokens ?? 0) + (e2.cacheReadInputTokens ?? 0);
  }
};
function Ue(e2, t2) {
  Me(Le(e2), { recursive: true });
  let i2 = null, s2 = [];
  for (let e3 of t2) {
    let t3 = Fe(), r2 = { type: e3.role === "user" ? "user" : "assistant", uuid: t3, parentUuid: i2, timestamp: Date.now(), content: e3.content };
    s2.push(JSON.stringify(r2)), i2 = t3;
  }
  Ie(e2, s2.join(`
`) + `
`, "utf8");
}
function Ke(e2) {
  let t2 = xe(e2, "utf8"), i2 = [];
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
i(Ue, "saveSession"), i(Ke, "loadSession");
var Je = class {
  static {
    i(this, "FileCredentialsProvider");
  }
  path;
  expiryBufferMs;
  cached = null;
  lastMtimeMs = 0;
  constructor(e2 = {}) {
    this.path = e2.path ?? He(), this.expiryBufferMs = e2.expiryBufferMs ?? 300000;
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
      let e2 = Pe(this.path, "utf8");
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
      return Be(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }
  isExpired(e2) {
    return !!e2.expiresAt && Date.now() + this.expiryBufferMs >= e2.expiresAt;
  }
};
function He() {
  let e2 = process.env.HOME || process.env.USERPROFILE || "";
  return `${process.env.CLAUDE_CONFIG_DIR || `${e2}/.claude`}/.credentials.json`;
}
i(He, "defaultCredentialsPath");
var je = { error: 0, info: 1, debug: 2 };
var We = class {
  static {
    i(this, "ConsoleEventEmitter");
  }
  minRank;
  format;
  write;
  constructor(e2 = {}) {
    this.minRank = je[e2.minLevel ?? "info"] ?? 1, this.format = e2.format ?? "human", this.write = e2.writeTarget ?? ((e3) => process.stderr.write(e3 + `
`));
  }
  emit(e2) {
    try {
      if ((je[e2.level] ?? 1) > this.minRank)
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
var qe = class {
  static {
    i(this, "NullEventEmitter");
  }
  emit(e2) {}
};
var ze = class {
  static {
    i(this, "InMemorySessionStore");
  }
  sessions = new Map;
  liveness;
  constructor(e2 = new Ge) {
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
var Ge = class {
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
var Qe = class {
  static {
    i(this, "NativeFetchUpstream");
  }
  async fetch(e2, t2) {
    return fetch(e2, t2);
  }
};
var Ye = { anthropicBaseUrl: "https://api.anthropic.com", kaIntervalSec: 120, kaIdleTimeoutSec: 0, kaMinTokens: 2000, kaRewriteWarnIdleSec: 300, kaRewriteWarnTokens: 50000, kaRewriteBlockIdleSec: 0, kaRewriteBlockEnabled: false };
var Ve = class {
  static {
    i(this, "ProxyClient");
  }
  config;
  credentials;
  events;
  store;
  upstream;
  liveness;
  reaperTimer;
  lastRateLimit = { status: null, resetAt: null, claim: null, retryAfter: null, utilization5h: null, utilization7d: null };
  constructor(e2) {
    this.config = { ...Ye, ...e2.config }, this.credentials = e2.credentialsProvider, this.events = e2.eventEmitter ?? new We, this.liveness = e2.livenessChecker ?? new Ge, this.store = e2.sessionStore ?? new ze(this.liveness), this.upstream = e2.upstreamFetcher ?? new Qe, this.reaperTimer = setInterval(() => {
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
  stop() {
    clearInterval(this.reaperTimer), this.store.stopAll();
  }
  async handleRequest(e2, t2, i2) {
    let s2 = i2.sessionId, r2 = i2.sourcePid ?? null, n2 = this.store.getOrCreate(s2, r2, () => this.createEngine(s2));
    n2.lastRequestAt = Date.now();
    let a2, o2 = typeof e2 == "string" ? e2 : new TextDecoder().decode(e2), l2 = typeof e2 == "string" ? new TextEncoder().encode(e2).byteLength : e2.byteLength;
    try {
      a2 = JSON.parse(o2);
    } catch {
      return this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: s2, msg: "Invalid JSON body" }), tt(400, { error: "Invalid JSON" });
    }
    let h2 = a2.model ?? "unknown";
    n2.model = h2;
    let c2 = {};
    for (let [e3, i3] of Object.entries(t2)) {
      let t3 = e3.toLowerCase();
      Xe.includes(t3) || (c2[e3] = i3);
    }
    c2["accept-encoding"] = "identity";
    try {
      let e3 = await this.credentials.getAccessToken();
      c2.Authorization = `Bearer ${e3}`;
    } catch (e3) {
      return this.events.emit({ level: "error", kind: "TOKEN_NEEDS_RELOGIN", sessionId: s2, msg: e3?.message ?? "No OAuth credentials" }), tt(401, { error: { type: "authentication_error", message: e3?.message ?? "No OAuth credentials" } });
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
        return tt(429, { error: { type: "cache_rewrite_blocked", message: e3.message } });
      throw e3;
    }
    let d2, f2, p2, m2 = Date.now();
    try {
      d2 = await this.upstream.fetch(`${this.config.anthropicBaseUrl}/v1/messages?beta=true`, { method: "POST", headers: c2, body: o2, signal: i2.signal });
    } catch (e3) {
      return this.handleNetworkError(s2, e3);
    }
    if (this.lastRateLimit = et(d2.headers), !d2.ok) {
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
    return new me({ config: { intervalMs: 1000 * t2.kaIntervalSec, idleTimeoutMs: t2.kaIdleTimeoutSec > 0 ? 1000 * t2.kaIdleTimeoutSec : 1 / 0, minTokens: t2.kaMinTokens, rewriteWarnIdleMs: 1000 * t2.kaRewriteWarnIdleSec, rewriteWarnTokens: t2.kaRewriteWarnTokens, rewriteBlockIdleMs: t2.kaRewriteBlockIdleSec > 0 ? 1000 * t2.kaRewriteBlockIdleSec : 1 / 0, rewriteBlockEnabled: t2.kaRewriteBlockEnabled, onHeartbeat: i((t3) => this.events.emit({ level: "info", kind: "KA_FIRE_COMPLETE", sessionId: e2, model: t3.model, durationMs: t3.durationMs, idleMs: t3.idleMs, usage: { inputTokens: t3.usage.inputTokens, outputTokens: t3.usage.outputTokens, cacheReadInputTokens: t3.usage.cacheReadInputTokens ?? 0, cacheCreationInputTokens: t3.usage.cacheCreationInputTokens ?? 0 }, rateLimit: t3.rateLimit }), "onHeartbeat"), onTick: i((i2) => {
      i2.idleMs > 900 * t2.kaIntervalSec && this.events.emit({ level: "debug", kind: "KA_TICK_IDLE", sessionId: e2, idleMs: i2.idleMs, nextFireMs: i2.nextFireMs, model: i2.model, tokens: i2.tokens });
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
    yield* it(r2.body, i2);
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
      t2.lastUsage = n2;
      try {
        t2.engine.notifyRealRequestComplete(n2);
      } catch (e3) {
        this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: i2, msg: `engine.notifyRealRequestComplete: ${e3?.message}` });
      }
      this.events.emit({ level: "info", kind: "REAL_REQUEST_COMPLETE", sessionId: i2, model: s2, durationMs: Date.now() - r2, usage: n2, rateLimit: { util5h: this.lastRateLimit.utilization5h, util7d: this.lastRateLimit.utilization7d, status: this.lastRateLimit.status } });
    } catch (e3) {
      this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: i2, msg: `SSE parse error: ${e3?.message ?? e3}` });
    }
  }
  handleNetworkError(e2, t2) {
    let i2 = t2?.code ?? t2?.cause?.code ?? "", s2 = String(t2?.message ?? "").toLowerCase(), r2 = Ze.has(i2) || s2.includes("unable to connect") || s2.includes("failed to open socket") || s2.includes("connection refused") || s2.includes("network");
    return this.events.emit({ level: "error", kind: "REAL_REQUEST_ERROR", sessionId: e2, status: r2 ? 503 : 502, msg: `upstream fetch threw: ${i2 || ""} ${s2}`.trim().slice(0, 200) }), r2 ? new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Upstream network error \u2014 proxy cannot reach Anthropic. Retrying will help once network is restored." } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "2" } }) : new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: `Upstream request failed: ${s2 || i2 || "unknown"}` } }), { status: 502, headers: { "content-type": "application/json" } });
  }
};
var Xe = ["host", "content-length", "connection", "authorization", "accept-encoding"];
var Ze = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
function et(e2) {
  return { status: e2.get("anthropic-ratelimit-unified-status"), resetAt: e2.get("anthropic-ratelimit-unified-reset") ? Number(e2.get("anthropic-ratelimit-unified-reset")) : null, claim: e2.get("anthropic-ratelimit-unified-representative-claim"), retryAfter: e2.get("retry-after") ? parseFloat(e2.get("retry-after")) : null, utilization5h: e2.get("anthropic-ratelimit-unified-5h-utilization") ? parseFloat(e2.get("anthropic-ratelimit-unified-5h-utilization")) : null, utilization7d: e2.get("anthropic-ratelimit-unified-7d-utilization") ? parseFloat(e2.get("anthropic-ratelimit-unified-7d-utilization")) : null };
}
function tt(e2, t2) {
  return new Response(JSON.stringify(t2), { status: e2, headers: { "content-type": "application/json" } });
}
async function* it(e2, t2) {
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
i(et, "parseRateLimitHeaders"), i(tt, "jsonResponse"), i(it, "parseSSEToEvents"), N(), N();
var lt = '{"type":"KeepAlive"}';
var ht = 16000;
var ct = Math.floor(3200);
async function ut(e2, t2, s2) {
  let r2 = s2?.baseUrl ?? "https://api.anthropic.com", n2 = new URLSearchParams({ encoding: "linear16", sample_rate: String(ht), channels: String(1), endpointing_ms: "300", utterance_end_ms: "1000", language: s2?.language ?? "en" });
  if (s2?.keyterms?.length)
    for (let e3 of s2.keyterms)
      n2.append("keyterms", e3);
  let a2 = `/api/ws/speech_to_text/voice_stream?${n2.toString()}`, o2 = at(16).toString("base64"), l2 = null, h2 = false, c2 = false, u2 = false, d2 = null, f2 = null, p2 = "", m2 = await new Promise((t3, i2) => {
    let s3 = setTimeout(() => {
      i2(new Error("voice_stream WebSocket connection timeout (10s)"));
    }, 1e4), n3 = new URL(r2), l3 = nt({ hostname: n3.hostname, port: n3.port || 443, path: a2, method: "GET", headers: { Authorization: `Bearer ${e2}`, "User-Agent": "claude-cli/1.0.0 (subscriber, cli)", "x-app": "cli", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": o2 } });
    l3.on("upgrade", (e3, r3, n4) => {
      clearTimeout(s3);
      let a3 = ot("sha1").update(o2 + "258EAFA5-E914-47DA-95CA-5AB5DC11E5B3").digest("base64");
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
    _2(Buffer.from(e3, "utf8"), 1);
  }
  function g2(e3) {
    _2(e3, 2);
  }
  function w2() {
    _2(Buffer.alloc(0), 8);
  }
  function _2(e3, t3) {
    if (m2.destroyed)
      return;
    let i2, s3 = at(4), r3 = Buffer.alloc(e3.length);
    for (let t4 = 0;t4 < e3.length; t4++)
      r3[t4] = e3[t4] ^ s3[t4 % 4];
    e3.length < 126 ? (i2 = Buffer.alloc(6), i2[0] = 128 | t3, i2[1] = 128 | e3.length, s3.copy(i2, 2)) : e3.length < 65536 ? (i2 = Buffer.alloc(8), i2[0] = 128 | t3, i2[1] = 254, i2.writeUInt16BE(e3.length, 2), s3.copy(i2, 4)) : (i2 = Buffer.alloc(14), i2[0] = 128 | t3, i2[1] = 255, i2.writeBigUInt64BE(BigInt(e3.length), 2), s3.copy(i2, 10)), m2.write(Buffer.concat([i2, r3]));
  }
  h2 = true, i(y2, "wsSendText"), i(g2, "wsSendBinary"), i(w2, "wsSendClose"), i(_2, "wsSendFrame");
  let k2 = Buffer.alloc(0);
  function E2() {
    for (;k2.length >= 2; ) {
      let e3 = k2[0], t3 = k2[1], i2 = 15 & e3, s3 = !!(128 & t3), r3 = 127 & t3, n3 = 2;
      if (r3 === 126) {
        if (k2.length < 4)
          return;
        r3 = k2.readUInt16BE(2), n3 = 4;
      } else if (r3 === 127) {
        if (k2.length < 10)
          return;
        r3 = Number(k2.readBigUInt64BE(2)), n3 = 10;
      }
      s3 && (n3 += 4);
      let a3 = n3 + r3;
      if (k2.length < a3)
        return;
      let o3 = k2.subarray(n3, a3);
      if (s3) {
        let e4 = k2.subarray(n3 - 4, n3);
        o3 = Buffer.from(o3);
        for (let t4 = 0;t4 < o3.length; t4++)
          o3[t4] = o3[t4] ^ e4[t4 % 4];
      }
      if (k2 = k2.subarray(a3), i2 === 1)
        T2(o3.toString("utf8"));
      else {
        if (i2 === 8)
          return void R2(o3.length >= 2 ? o3.readUInt16BE(0) : 1005, o3.length > 2 ? o3.subarray(2).toString("utf8") : "");
        i2 === 9 && _2(o3, 10);
      }
    }
  }
  function T2(e3) {
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
  function R2(e3, i2) {
    if (h2 = false, l2 && (clearInterval(l2), l2 = null), p2) {
      let e4 = p2;
      p2 = "", t2.onTranscript(e4, true);
    }
    d2?.("ws_close"), !u2 && e3 !== 1000 && e3 !== 1005 && t2.onError(`Connection closed: code ${e3}${i2 ? ` \u2014 ${i2}` : ""}`), t2.onClose(), m2.destroy();
  }
  return i(E2, "processFrames"), i(T2, "handleMessage"), i(R2, "handleClose"), m2.on("data", (e3) => {
    k2 = Buffer.concat([k2, e3]), E2();
  }), m2.on("close", () => {
    h2 && R2(1006, "connection lost");
  }), m2.on("error", (e3) => {
    u2 || t2.onError(`Socket error: ${e3.message}`);
  }), y2(lt), l2 = setInterval(() => {
    h2 && y2(lt);
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
async function dt(e2, t2, s2) {
  let r2 = [], n2 = null, a2 = await ut(e2, { onTranscript: i((e3, t3) => {
    t3 ? r2.push(e3.trim()) : s2?.onInterim?.(e3);
  }, "onTranscript"), onError: i((e3) => {
    n2 = e3;
  }, "onError"), onClose: i(() => {}, "onClose") }, s2);
  try {
    let e3 = await wt(t2), i2 = e3;
    e3.length > 44 && e3[0] === 82 && e3[1] === 73 && e3[2] === 70 && e3[3] === 70 && (i2 = e3.subarray(44));
    let r3 = s2?.realtime !== false;
    for (let e4 = 0;e4 < i2.length && a2.isConnected(); e4 += ct) {
      let t3 = i2.subarray(e4, Math.min(e4 + ct, i2.length));
      a2.send(t3), r3 && e4 + ct < i2.length && await gt(80);
    }
    await a2.finalize();
  } finally {
    a2.close();
  }
  if (n2)
    throw new Error(`Transcription error: ${n2}`);
  return r2.join(" ");
}
async function ft(e2, t2, s2) {
  let r2 = [], n2 = null, a2 = await ut(e2, { onTranscript: i((e3, t3) => {
    t3 ? r2.push(e3.trim()) : s2?.onInterim?.(e3);
  }, "onTranscript"), onError: i((e3) => {
    n2 = e3;
  }, "onError"), onClose: i(() => {}, "onClose") }, s2);
  try {
    let e3 = _t();
    if (!e3)
      throw new Error("No audio converter found. Install ffmpeg or sox.");
    await kt(a2, t2, e3, s2?.realtime !== false), await a2.finalize();
  } finally {
    a2.close();
  }
  if (n2)
    throw new Error(`Transcription error: ${n2}`);
  return r2.join(" ");
}
function pt(e2, t2) {
  if (yt("rec")) {
    let i2 = st("rec", ["-q", "--buffer", "1024", "-t", "raw", "-r", String(ht), "-e", "signed", "-b", String(16), "-c", String(1), "-", "silence", "1", "0.1", "3%", "1", "2.0", "3%"], { stdio: ["pipe", "pipe", "pipe"] });
    return i2.stdout?.on("data", e2), i2.stderr?.on("data", () => {}), i2.on("close", t2), i2.on("error", t2), { stop() {
      i2.kill("SIGTERM");
    } };
  }
  if (yt("arecord")) {
    let i2 = st("arecord", ["-f", "S16_LE", "-r", String(ht), "-c", String(1), "-t", "raw", "-q", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    return i2.stdout?.on("data", e2), i2.stderr?.on("data", () => {}), i2.on("close", t2), i2.on("error", t2), { stop() {
      i2.kill("SIGTERM");
    } };
  }
  return null;
}
function mt() {
  return yt("rec") ? { available: true, tool: "sox", installHint: null } : yt("arecord") ? { available: true, tool: "arecord", installHint: null } : { available: false, tool: null, installHint: { darwin: "brew install sox", linux: "sudo apt-get install sox  # or: sudo apt-get install alsa-utils" }[process.platform] ?? "Install SoX (sox) or ALSA utils (arecord)" };
}
function yt(e2) {
  return rt(e2, ["--version"], { stdio: "ignore", timeout: 3000 }).error === undefined;
}
function gt(e2) {
  return new Promise((t2) => setTimeout(t2, e2));
}
async function wt(e2) {
  let { readFile: t2 } = await import("fs/promises");
  return t2(e2);
}
function _t() {
  return yt("ffmpeg") ? "ffmpeg" : yt("sox") ? "sox" : null;
}
async function kt(e2, t2, i2, s2) {
  let r2 = i2 === "ffmpeg" ? ["-i", t2, "-f", "s16le", "-ar", String(ht), "-ac", String(1), "pipe:1"] : [t2, "-t", "raw", "-r", String(ht), "-e", "signed", "-b", String(16), "-c", String(1), "-"], n2 = st(i2, r2, { stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((t3, r3) => {
    let a2 = Date.now();
    n2.stdout?.on("data", async (t4) => {
      if (e2.isConnected()) {
        if (e2.send(t4), s2) {
          let e3 = t4.length / 32000 * 1000, i3 = Date.now() - a2, s3 = Math.max(0, 0.8 * e3 - i3);
          s3 > 10 && (n2.stdout?.pause(), await gt(s3), n2.stdout?.resume()), a2 = Date.now();
        }
      } else
        n2.kill("SIGTERM");
    }), n2.stderr?.on("data", () => {}), n2.on("close", (e3) => {
      e3 !== 0 && e3 !== null ? r3(new Error(`${i2} exited with code ${e3}`)) : t3();
    }), n2.on("error", r3);
  });
}
i(ut, "connectVoiceStream"), i(dt, "transcribeFile"), i(ft, "transcribeAudioFile"), i(pt, "startMicRecording"), i(mt, "checkVoiceDeps"), i(yt, "hasCommand"), i(gt, "sleep"), i(wt, "readFileAsBuffer"), i(_t, "findConverter"), i(kt, "streamConvertedAudio");

// provider.ts
import { appendFileSync as appendFileSync5 } from "fs";
import { join as join8 } from "path";
import { homedir as homedir8 } from "os";

// node_modules/@life-ai-tools/opencode-signal-wire/signal-wire.ts
import { appendFileSync as appendFileSync3, existsSync, readFileSync, statSync, writeFileSync, renameSync } from "fs";
import { homedir as homedir4 } from "os";
import { join as join4 } from "path";

// ../../../../../packages/signal-wire-core/dist/domain/action.js
var ACTION_ORDER = [
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
    const re2 = new RegExp(source, flags);
    regexCache.set(pattern, re2);
    return re2;
  } catch {
    return null;
  }
}
function matchCondition(match, event) {
  const payload = event.payload ?? {};
  const p2 = payload;
  const groups = [];
  if (match.tool !== undefined) {
    const re2 = compileRegex(match.tool);
    if (!re2)
      return { matched: false, groups };
    const tool = stringifyForMatch(p2.tool);
    if (!re2.test(tool))
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
    const re2 = compileRegex(match.input_regex);
    if (!re2)
      return { matched: false, groups };
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      serialized = "";
    }
    const m2 = serialized.match(re2);
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
    const re2 = compileRegex(`\\b(${alt})\\b`);
    if (!re2)
      return { matched: false, groups };
    if (!re2.test(serialized))
      return { matched: false, groups };
  }
  if (match.response_regex !== undefined) {
    const re2 = compileRegex(match.response_regex);
    if (!re2)
      return { matched: false, groups };
    const response = stringifyForMatch(p2.response);
    if (!re2.test(response))
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
      const re2 = compileRegex(match.prompt_regex);
      if (!re2)
        return { matched: false, groups };
      if (!re2.test(promptText))
        return { matched: false, groups };
    }
    if (match.prompt_keywords && match.prompt_keywords.length > 0) {
      const alt = match.prompt_keywords.map((k2) => k2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const re2 = compileRegex(`\\b(${alt})\\b`);
      if (!re2)
        return { matched: false, groups };
      if (!re2.test(promptText))
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
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
var DEFAULT_AUDIT_PATH = join(homedir(), ".context", "hooks", "audit", "signal-wire-audit.jsonl");

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
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(record) + `
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
      const url2 = new URL("/wake", ctx.serverUrl).toString();
      const res = await fetch(url2, {
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
import { appendFileSync as appendFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";

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
var LOG_FILE = process.env.SIGNAL_WIRE_CORE_LOG_FILE ?? process.env.SIGNAL_WIRE_LOG_FILE ?? join2(homedir2(), ".claude", "signal-wire-debug.log");
var VERBOSE = process.env.SIGNAL_WIRE_CORE_VERBOSE === "1";
var bannerEmitted = false;
function writeLine(line) {
  const ts = new Date().toISOString();
  const full = `[${ts}] ${coreIdentityTag()} ${line}
`;
  try {
    appendFileSync2(LOG_FILE, full);
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
function info(message, extra) {
  if (!bannerEmitted)
    emitBanner();
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  writeLine(`INFO ${message}${suffix}`);
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
      info("EVENT_RECEIVED", {
        correlationId,
        eventId,
        source: event.source,
        type: event.type,
        sessionId: event.sessionId ?? null,
        rulesConsidered: trace.rulesEvaluated
      });
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
        const matchVarKeys = Object.keys(match.variables || {});
        info("RULE_FIRED", {
          correlationId,
          eventId,
          ruleId: rule.id,
          eventType: event.type,
          actions: rule.actions.map((a2) => a2.type),
          matchVars: matchVarKeys,
          cooldownScope: scope,
          sessionId: sessionIdForState
        });
        const sortedActions = [...rule.actions].sort((a2, b2) => {
          const idxA = ACTION_ORDER.indexOf(a2.type);
          const idxB = ACTION_ORDER.indexOf(b2.type);
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
      const resultsByType = {};
      for (const r2 of allResults) {
        const key = r2.success ? r2.type : `${r2.type}!fail`;
        resultsByType[key] = (resultsByType[key] ?? 0) + 1;
      }
      info("EVENT_COMPLETE", {
        correlationId,
        eventId,
        type: event.type,
        outcome: trace.outcome,
        rulesMatched: trace.rulesMatched,
        actionsEmitted: trace.actionsEmitted,
        durationMs: trace.endedAt - trace.startedAt,
        results: resultsByType
      });
      return allResults;
    } catch (e2) {
      trace.outcome = "error";
      trace.errors = [e2 instanceof Error ? e2.message : String(e2)];
      trace.endedAt = this.now();
      try {
        await this.traceSink.emit(trace);
      } catch {}
      info("EVENT_ERROR", {
        correlationId,
        eventId,
        type: event.type,
        error: e2 instanceof Error ? e2.message : String(e2),
        durationMs: trace.endedAt - trace.startedAt
      });
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
import { join as join3 } from "path";
import { homedir as homedir3 } from "os";
var DEFAULT_ROOT = join3(homedir3(), ".context", "hooks", "state");
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
  const envPath = typeof process !== "undefined" ? process.env?.SIGNAL_WIRE_RULES_PATH : undefined;
  if (envPath)
    return envPath;
  try {
    const req = __require_gv7hsff9;
    if (req) {
      const pkgJsonPath = req.resolve("@kiberos/signal-wire-core/package.json");
      const sep = pkgJsonPath.includes("\\") ? "\\" : "/";
      const pkgRoot = pkgJsonPath.slice(0, pkgJsonPath.lastIndexOf(sep));
      return `${pkgRoot}${sep}rules${sep}signal-wire-rules.json`;
    }
  } catch {}
  const url = new URL("../rules/signal-wire-rules.json", import.meta.url);
  return url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.pathname;
}

// node_modules/@life-ai-tools/opencode-signal-wire/signal-wire.ts
var ADAPTER_VERSION = "1.0.0";
var ADAPTER_MTIME = new Date().toISOString();
var ADAPTER_ID = `sw-adapter-opencode-claude v${ADAPTER_VERSION}@${ADAPTER_MTIME.slice(11, 19)}`;
var LOG_FILE2 = join4(homedir4(), ".claude", "signal-wire-debug.log");
function swLog(msg) {
  const line = `[${new Date().toISOString()}] ${coreIdentityTag()} [${ADAPTER_ID}] ${msg}
`;
  try {
    appendFileSync3(LOG_FILE2, line);
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
    if (!existsSync(this.path)) {
      return { rules: [], fingerprint: null };
    }
    let stat;
    try {
      stat = statSync(this.path);
    } catch {
      return { rules: [], fingerprint: null };
    }
    const fp = { mtimeMs: stat.mtimeMs, size: stat.size };
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
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
    if (!existsSync(this.path))
      return { reloaded: false, error: "rules file missing" };
    let stat;
    try {
      stat = statSync(this.path);
    } catch (e2) {
      return { reloaded: false, error: e2 instanceof Error ? e2.message : String(e2) };
    }
    const fp = { mtimeMs: stat.mtimeMs, size: stat.size };
    if (this.lastFingerprint && fp.mtimeMs === this.lastFingerprint.mtimeMs && fp.size === this.lastFingerprint.size) {
      return { reloaded: false };
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
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
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, this.path);
    swLog(`RULES_FILE_REWRITTEN rules=${updatedRawRules.length} path=${this.path}`);
  }
  getRawLegacyRules() {
    if (!existsSync(this.path))
      return [];
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      return raw.rules ?? [];
    } catch {
      return [];
    }
  }
}

class SignalWire {
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
  logInvoke(mode, event) {
    swLog(`CONSUMER_INVOKE consumer=opencode-plugin mode=${mode} type=${event.type} session=${this.sessionId || "?"}`);
  }
  evaluate(ctx) {
    this.rulesStore.maybeReload();
    const event = contextToEvent(ctx, this.sessionId);
    this.logInvoke("evaluate-sync", event);
    this.pipeline.process(event).then((rs) => {
      this.lastAsyncResult = this.toLegacy(rs);
    }).catch(() => {});
    return this.lastAsyncResult;
  }
  async evaluateAsync(ctx) {
    this.rulesStore.maybeReload();
    const event = contextToEvent(ctx, this.sessionId);
    this.logInvoke("evaluate-async", event);
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
    this.logInvoke("evaluate-external", event);
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
// node_modules/@life-ai-tools/opencode-signal-wire/wake-listener.ts
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, readFileSync as readFileSync2, unlinkSync, appendFileSync as appendFileSync4, renameSync as renameSync2 } from "fs";
import { join as join6 } from "path";
import { homedir as homedir6 } from "os";

// node_modules/@life-ai-tools/opencode-signal-wire/wake-types.ts
import { homedir as homedir5 } from "os";
import { join as join5 } from "path";
var DISCOVERY_DIR = join5(homedir5(), ".opencode", "wake");
var WARM_CHANNEL_TTL_MS = 5 * 60 * 1000;
var WAKE_EVENT_TYPES = {
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

// node_modules/@life-ai-tools/opencode-signal-wire/wake-listener.ts
var DEBUG = process.env.WAKE_LISTENER_DEBUG !== "0";
var LOG_FILE3 = join6(homedir6(), ".claude", "wake-listener-debug.log");
var MAX_QUEUE_DEFAULT = 50;
var BUSY_RETRY_INTERVAL_DEFAULT = 5;
var STARTUP_TS = Date.now();
function dbg2(...args) {
  if (!DEBUG)
    return;
  try {
    appendFileSync4(LOG_FILE3, `[${new Date().toISOString()}] [wake-listener] ${args.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ")}
`);
  } catch {}
}
var warmChannels = new Map;
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
var _agentIdentity = null;
var _sdkClient = null;
var _currentSubscribe = null;
var _currentSubscribePreset = null;
var _currentMemberType = "unknown";
var _spawnTotal = 0;
var _currentDepth = null;
var _inheritedDepth = parseInt(process.env.__SPAWN_DEPTH ?? "", 10);
if (!isNaN(_inheritedDepth) && _inheritedDepth >= 0) {
  _currentDepth = _inheritedDepth;
  dbg2(`spawn depth inherited from parent: ${_inheritedDepth}`);
}
var _parentMemberId = process.env.__PARENT_MEMBER_ID ?? null;
var _parentSessionId = process.env.__PARENT_SESSION_ID ?? null;
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
var HELPER_TIMEOUT_MS = 60000;
var _activeHelperTimestamps = [];
function helperStarted() {
  _spawnTotal++;
  _activeHelperTimestamps.push(Date.now());
}
function getAgentIdentity() {
  return _agentIdentity;
}
async function resolveCurrentDepth(sessionId) {
  if (_currentDepth !== null)
    return _currentDepth;
  let depth = 0;
  let currentId = sessionId;
  try {
    for (let i2 = 0;i2 < 10; i2++) {
      if (!_sdkClient) {
        dbg2("resolveCurrentDepth: no sdkClient");
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
    dbg2("resolveCurrentDepth: failed, assuming 0");
  }
  _currentDepth = depth;
  dbg2(`resolveCurrentDepth: depth=${depth}`);
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
  const url2 = synqtaskUrl ?? process.env.SYNQTASK_API_URL ?? "http://localhost:3747";
  let bearerToken = process.env.SYNQTASK_BEARER_TOKEN ?? "";
  if (!bearerToken) {
    try {
      const authPath = join6(homedir6(), ".local", "share", "opencode", "mcp-auth.json");
      const authData = JSON.parse(readFileSync2(authPath, "utf-8"));
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
    const res = await fetch(`${url2}/mcp`, {
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
      dbg2(`fetchIdentity: HTTP ${res.status}`);
      return parseAgentsMd();
    }
    const text = await res.text();
    const dataLine = text.split(`
`).find((l2) => l2.startsWith("data: "));
    if (!dataLine) {
      dbg2("fetchIdentity: no data line in response");
      return parseAgentsMd();
    }
    const rpcResult = JSON.parse(dataLine.substring(6));
    const content = rpcResult?.result?.content?.[0]?.text;
    if (!content) {
      dbg2("fetchIdentity: empty content");
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
        const teamRes = await fetch(`${url2}/mcp`, {
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
                  const mRes = await fetch(`${url2}/mcp`, {
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
        dbg2(`fetchIdentity: team fetch failed: ${e2?.message}`);
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
    dbg2(`fetchIdentity: OK name=${identity.name} role=${identity.roleName} team=${identity.teamName} teammates=${identity.teammates.length} budget=${identity.budget ? `depth=${identity.budget.maxSpawnDepth},subs=${identity.budget.maxSubagents}` : "none"} playbook=${identity.teamPlaybook ? "yes" : "no"}`);
    return identity;
  } catch (e2) {
    dbg2(`fetchIdentity: failed: ${e2?.message}`);
    return parseAgentsMd();
  }
}
function parseAgentsMd() {
  try {
    const agentsMdPath = join6(process.cwd(), "AGENTS.md");
    const content = readFileSync2(agentsMdPath, "utf-8");
    const nameMatch = content.match(/^#\s+(?:Agent\s+)?(.+)/im);
    const name = nameMatch?.[1]?.trim() ?? null;
    const roleMatch = content.match(/##\s+(?:\u0420\u043E\u043B\u044C|Role)[^\n]*\n([\s\S]*?)(?=\n##|\n$)/i);
    const rolePrompt = roleMatch?.[1]?.trim() ?? null;
    const idMatch = content.match(/Member ID.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    const memberId = idMatch?.[1] ?? null;
    if (!name) {
      dbg2("parseAgentsMd: no name found");
      return null;
    }
    dbg2(`parseAgentsMd: fallback OK name=${name}`);
    return {
      memberId: memberId ?? "unknown",
      name,
      roleName: null,
      rolePrompt,
      teamName: null,
      teammates: [],
      fetchedAt: Date.now()
    };
  } catch {
    dbg2("parseAgentsMd: file not found or parse error");
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
var _cachedSessionId = null;
var _discoveryPath = null;
var _agentDirectory = null;
async function resolveSessionId(sessionId) {
  if (_cachedSessionId && _cachedSessionId !== "unknown")
    return _cachedSessionId;
  if (sessionId && sessionId !== "unknown") {
    _cachedSessionId = sessionId;
    return sessionId;
  }
  if (_discoveryPath) {
    try {
      const disc = JSON.parse(readFileSync2(_discoveryPath, "utf-8"));
      if (disc.sessionId && disc.sessionId !== "unknown") {
        _cachedSessionId = disc.sessionId;
        dbg2(`resolveSessionId from discovery file: ${_cachedSessionId}`);
        return _cachedSessionId;
      }
    } catch {}
  }
  if (_agentDirectory) {
    try {
      if (!_sdkClient) {
        dbg2("resolveSessionId: no sdkClient");
        return null;
      }
      const { data: sessions } = await _sdkClient.session.list();
      if (!Array.isArray(sessions))
        return null;
      const match = sessions.find((s2) => s2.directory === _agentDirectory);
      if (match) {
        _cachedSessionId = match.id;
        dbg2(`resolveSessionId by directory ${_agentDirectory}: ${_cachedSessionId}`);
        if (_discoveryPath) {
          try {
            const disc = JSON.parse(readFileSync2(_discoveryPath, "utf-8"));
            disc.sessionId = _cachedSessionId;
            const tmpPath = _discoveryPath + ".tmp";
            writeFileSync2(tmpPath, JSON.stringify(disc));
            renameSync2(tmpPath, _discoveryPath);
          } catch {}
        }
        return _cachedSessionId;
      }
    } catch (e2) {
      dbg2(`resolveSessionId by directory failed: ${e2?.message}`);
    }
  }
  dbg2("resolveSessionId: no session ID yet, events will queue");
  return null;
}
async function injectWakeEvent(event, sessionId) {
  const resolvedSessionId = await resolveSessionId(sessionId);
  if (!resolvedSessionId) {
    dbg2("inject: no valid sessionId");
    return false;
  }
  if (!_sdkClient) {
    dbg2("inject: no sdkClient");
    return false;
  }
  const text = formatWakeMessage(event, _agentIdentity);
  try {
    const { error: error2 } = await _sdkClient.session.promptAsync({
      path: { id: resolvedSessionId },
      body: { noReply: false, parts: [{ type: "text", text }] }
    });
    if (!error2) {
      dbg2(`inject OK: session=${resolvedSessionId}`);
      return true;
    }
    dbg2(`inject failed: ${error2}`);
    return false;
  } catch (e2) {
    dbg2(`inject error: ${e2?.message}`);
    return false;
  }
}
async function startWakeListener(config) {
  _agentDirectory = process.cwd();
  _sdkClient = config.sdkClient ?? null;
  if (config.memberId) {
    try {
      _agentIdentity = await fetchIdentity(config.memberId, config.synqtaskUrl, config.identityFetchTimeoutMs);
      dbg2(`identity: ${_agentIdentity?.name ?? "null"} role=${_agentIdentity?.roleName ?? "none"} team=${_agentIdentity?.teamName ?? "none"} teammates=${_agentIdentity?.teammates?.length ?? 0}`);
    } catch (e2) {
      dbg2(`identity fetch failed (non-fatal): ${e2?.message}`);
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
          dbg2("playbook: no sdkClient");
        } else {
          await _sdkClient.session.prompt({
            path: { id: playbookSessionId },
            body: { noReply: true, parts: [{ type: "text", text: playbookText }] }
          });
          dbg2("playbook injected at session start");
        }
      }
    } catch (e2) {
      dbg2(`playbook injection failed (non-fatal): ${e2?.message}`);
    }
  }
  const token = crypto.randomUUID();
  const queue = [];
  const maxQueue = config.maxQueueSize ?? MAX_QUEUE_DEFAULT;
  const retryInterval = config.busyRetryInterval ?? BUSY_RETRY_INTERVAL_DEFAULT;
  async function handleRequest(req2) {
    try {
      const url2 = new URL(req2.url);
      if (req2.method === "GET" && url2.pathname === "/health") {
        return Response.json({
          alive: true,
          sessionId: config.sessionId,
          uptime: Math.floor((Date.now() - STARTUP_TS) / 1000),
          queueSize: queue.length
        });
      }
      if (req2.method === "POST" && url2.pathname === "/wake") {
        return await handleWake(req2);
      }
      return new Response("Not found", { status: 404 });
    } catch (e2) {
      dbg2("request handler error:", e2?.message);
      return Response.json({ accepted: false, error: "internal error" }, { status: 500 });
    }
  }
  async function handleWake(req2) {
    const reqToken = req2.headers.get("X-Wake-Token");
    if (reqToken !== token) {
      dbg2("wake: auth failed");
      return Response.json({ accepted: false, error: "unauthorized" }, { status: 401 });
    }
    let event;
    try {
      event = await req2.json();
    } catch {
      return Response.json({ accepted: false, error: "invalid JSON" }, { status: 400 });
    }
    if (!event.eventId || !event.type || !event.source) {
      return Response.json({ accepted: false, error: "missing required fields" }, { status: 400 });
    }
    dbg2(`wake: received ${event.type} from ${event.source} [${event.priority}]`);
    const signalWireInstance = config.signalWire ?? config.signalWireResolver?.() ?? null;
    if (signalWireInstance) {
      try {
        const result = await signalWireInstance.evaluateExternal(event);
        if (result.matched) {
          dbg2(`wake: engine handled event ${event.eventId} (wake=${result.wakeTriggered}, actions=${result.actionsExecuted.length})`);
          return Response.json({
            accepted: true,
            engineHandled: true,
            wakeTriggered: result.wakeTriggered,
            actionsExecuted: result.actionsExecuted.length
          });
        }
        dbg2("no matching rule for event, falling back to direct injection");
      } catch (e2) {
        dbg2("engine evaluateExternal error, falling back:", e2?.message);
      }
    }
    const busy = await isAgentBusy();
    if (busy) {
      if (queue.length >= maxQueue) {
        const dropped = queue.shift();
        dbg2(`wake: queue full, dropped oldest event ${dropped?.eventId}`);
      }
      queue.push(event);
      const pos = queue.length;
      dbg2(`wake: agent busy, queued at position ${pos}`);
      return Response.json({ accepted: true, queued: true, queuePosition: pos });
    }
    const injected = await injectWakeEvent(event, config.sessionId);
    if (injected) {
      dbg2(`wake: injected ${event.eventId}`);
      return Response.json({ accepted: true, queued: false });
    }
    if (queue.length >= maxQueue) {
      queue.shift();
    }
    queue.push(event);
    dbg2(`wake: inject failed, queued at position ${queue.length}`);
    return Response.json({ accepted: true, queued: true, queuePosition: queue.length });
  }
  const server = Bun.serve({
    port: config.port ?? 0,
    fetch: handleRequest
  });
  const actualPort = server.port;
  dbg2(`started on port ${actualPort} for session ${config.sessionId}`);
  if (config.memberId) {
    const discoveryPath = join6(DISCOVERY_DIR, `${process.pid}-${config.sessionId}.json`);
    try {
      mkdirSync2(DISCOVERY_DIR, { recursive: true });
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
      writeFileSync2(tmpPath, JSON.stringify(discoveryData));
      renameSync2(tmpPath, discoveryPath);
      _discoveryPath = discoveryPath;
      dbg2(`discovery file written: ${discoveryPath} depth=${discoveryData.spawnDepth} parent=${discoveryData.parentMemberId ?? "ROOT"}`);
    } catch (e2) {
      dbg2("discovery file write failed:", e2?.message);
    }
  } else {
    dbg2("skipping discovery file: no memberId configured (non-agent session)");
  }
  const drainInterval = setInterval(async () => {
    if (queue.length === 0)
      return;
    try {
      if (await isAgentBusy())
        return;
      const event = queue.shift();
      const ok = await injectWakeEvent(event, config.sessionId);
      dbg2(`drain: ${event.eventId} ${ok ? "injected" : "failed"}`);
    } catch (e2) {
      dbg2("drain error:", e2?.message);
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
    dbg2("cleanup complete");
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
// node_modules/@life-ai-tools/opencode-signal-wire/wake-preferences.ts
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3, mkdirSync as mkdirSync3, renameSync as renameSync3, existsSync as existsSync2 } from "fs";
import { join as join7, dirname as dirname3 } from "path";
import { homedir as homedir7 } from "os";
var WAKE_PRESETS = {
  human: ["task_assigned", "delegation_received", "mention"],
  agent: ["*"],
  pm: ["task_completed", "task_failed", "agent_stale", "delegation_received"],
  quiet: []
};
var PRESET_NAMES = Object.keys(WAKE_PRESETS);
var GLOBAL_PREFS_PATH = join7(homedir7(), ".opencode", "wake-preferences.json");
function projectPrefsPath(cwd) {
  return join7(cwd, ".opencode", "wake-preferences.json");
}
function loadPreferences(cwd) {
  let global = null;
  let project = null;
  try {
    if (existsSync2(GLOBAL_PREFS_PATH)) {
      global = JSON.parse(readFileSync3(GLOBAL_PREFS_PATH, "utf-8"));
    }
  } catch {}
  if (cwd) {
    try {
      const pp = projectPrefsPath(cwd);
      if (existsSync2(pp)) {
        project = JSON.parse(readFileSync3(pp, "utf-8"));
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

// node_modules/@life-ai-tools/opencode-signal-wire/index.ts
var _identityError2 = null;
function getIdentityError() {
  return _identityError2;
}
function setIdentityError(err) {
  _identityError2 = err;
}

// provider.ts
try {
  _traceWrite("/tmp/opencode-claude-trace.log", `PROVIDER.TS pid=${process.pid} cwd=${process.cwd()} ${new Date().toISOString()}
`);
} catch {}
(() => {
  try {
    const { appendFileSync: appendFileSync6 } = __require_gv7hsff9("fs");
    const { join: join9 } = __require_gv7hsff9("path");
    const { homedir: homedir9 } = __require_gv7hsff9("os");
    const logFile = join9(homedir9(), ".claude", "signal-wire-debug.log");
    appendFileSync6(logFile, `[${new Date().toISOString()}] [provider pid=${process.pid}] ENGINE_SELECT=CORE implementation=sw-adapter-opencode-claude v1.0.0 env=(ts-only)
`);
  } catch {}
})();
var DEBUG2 = process.env.CLAUDE_MAX_DEBUG !== "0";
var LOG_FILE4 = join8(homedir8(), ".claude", "claude-max-debug.log");
var STATS_FILE = join8(homedir8(), ".claude", "claude-max-stats.log");
var STATS_JSONL = join8(homedir8(), ".claude", "claude-max-stats.jsonl");
var PID = process.pid;
var SESSION = process.env.OPENCODE_SESSION_SLUG ?? process.env.OPENCODE_SESSION_ID?.slice(0, 12) ?? "?";
var _swServerUrl = "";
function setSignalWireServerUrl(url2) {
  _swServerUrl = url2;
}
function setSignalWireSdkClient(client) {
  _signalWire?.setSdkClient(client);
}
var _signalWire = null;
function getSignalWireInstance() {
  return _signalWire;
}
function dbg3(...args) {
  if (!DEBUG2)
    return;
  try {
    appendFileSync5(LOG_FILE4, `[${new Date().toISOString()}] ${args.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ")}
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
      dbg3(`helper spawn OK (depth=${depth}/${maxDepth} active=${getSpawnActive()} total=${getSpawnTotal()})`);
      return;
    }
    const check = checkSpawnAllowed(identity, depth, getSpawnActive());
    if (!check.allowed) {
      const roleName = identity.roleName ?? "unknown";
      const teammates = identity.teammates?.length > 0 ? identity.teammates.map((t2) => `${t2.name} (${t2.roleName ?? "?"})`).join(", ") : "\u043D\u0435\u0442";
      const reason = check.depth >= check.maxDepth ? `\u0413\u043B\u0443\u0431\u0438\u043D\u0430 ${check.depth}/${check.maxDepth} \u0434\u043B\u044F \u0440\u043E\u043B\u0438 '${roleName}'.` : `\u041F\u043E\u0440\u043E\u0436\u0434\u0435\u043D\u043E ${check.spawned}/${check.maxSpawns} \u0441\u0443\u0431\u0430\u0433\u0435\u043D\u0442\u043E\u0432 \u0434\u043B\u044F \u0440\u043E\u043B\u0438 '${roleName}'.`;
      dbg3(`spawn budget BLOCKED: ${reason}`);
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
    dbg3(`spawn budget OK: depth=${check.depth}/${check.maxDepth} spawned=${check.spawned + 1}/${check.maxSpawns} \u2192 child will be depth=${check.depth + 1}`);
    return;
  } catch (e2) {
    dbg3(`spawn budget check failed (allowing): ${e2?.message}`);
    return;
  }
}

// index.ts
import { appendFileSync as appendFileSync6 } from "fs";
try {
  __require_gv7hsff9("fs").appendFileSync("/tmp/opencode-claude-trace.log", `LOADED pid=${process.pid} cwd=${process.cwd()} time=${new Date().toISOString()}
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
      join9(cwd, ".claude", ".credentials.json"),
      join9(cwd, ".credentials.json"),
      join9(homedir9(), ".claude", ".credentials.json")
    ];
    this.credPath = candidates.find((p2) => existsSync4(p2)) ?? join9(homedir9(), ".claude", ".credentials.json");
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
      const raw = readFileSync4(this.credPath, "utf8");
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
      existing = JSON.parse(readFileSync4(this.credPath, "utf8"));
    } catch {}
    existing.claudeAiOauth = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt
    };
    const dir = dirname4(this.credPath);
    try {
      mkdirSync4(dir, { recursive: true });
    } catch {}
    writeFileSync4(this.credPath, JSON.stringify(existing, null, 2), "utf8");
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
var DEBUG3 = process.env.CLAUDE_MAX_DEBUG !== "0";
var LOG_FILE5 = join9(homedir9(), ".claude", "claude-max-debug.log");
function dbg4(...args) {
  if (!DEBUG3)
    return;
  try {
    appendFileSync6(LOG_FILE5, `[${new Date().toISOString()}] ${args.map((a2) => typeof a2 === "string" ? a2 : JSON.stringify(a2)).join(" ")}
`);
  } catch {}
}
var getIdentityError2 = getIdentityError;
async function resolveOAuthIdentity() {
  try {
    const authPath = join9(homedir9(), ".local", "share", "opencode", "mcp-auth.json");
    if (!existsSync4(authPath))
      return null;
    const authData = JSON.parse(readFileSync4(authPath, "utf-8"));
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
    dbg4(`OAuth whoami failed: ${e2?.message}`);
    return null;
  }
}
function _readPkgVersion(p2) {
  try {
    const j2 = JSON.parse(readFileSync4(p2, "utf8"));
    return `${j2.name ?? "?"}@${j2.version ?? "?"}`;
  } catch {
    return "unknown";
  }
}
var _PLUGIN_PKG = _readPkgVersion(join9(import.meta.dir, "..", "package.json"));
var _SDK_PKG = _readPkgVersion(join9(import.meta.dir, "..", "node_modules", "@life-ai-tools", "claude-code-sdk", "package.json"));
var _SIGNALWIRE_PKG = _readPkgVersion(join9(import.meta.dir, "..", "node_modules", "@life-ai-tools", "opencode-signal-wire", "package.json"));
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
      _providerMtime = statSync2(join9(import.meta.dir, "provider.js")).mtime.toISOString();
    } catch {}
    let _proxyPkg = "unknown";
    try {
      const proxyUrl = process.env.CLAUDE_MAX_PROXY_URL ?? "http://127.0.0.1:5050";
      const ctrl = new AbortController;
      const timer = setTimeout(() => ctrl.abort(), 500);
      const r2 = await fetch(`${proxyUrl}/version`, { signal: ctrl.signal }).catch(() => null);
      clearTimeout(timer);
      if (r2 && r2.ok) {
        const j2 = await r2.json().catch(() => null);
        if (j2?.version)
          _proxyPkg = `${j2.name ?? "@kiberos/claude-max-proxy"}@${j2.version}`;
      }
    } catch {}
    dbg4(`STARTUP plugin.server() pid=${process.pid} session=${sessionId} cwd=${cwd} cred=${creds.credPath} loggedIn=${creds.hasCredentials} plugin=${_PLUGIN_PKG} sdk=${_SDK_PKG} signalWire=${_SIGNALWIRE_PKG} proxy=${_proxyPkg} node=${process.version} providerPath=${providerPath} providerMtime=${_providerMtime} initTime=${Date.now() - t0}ms`);
    const _serverUrl = typeof input.serverUrl === "object" && input.serverUrl?.href ? input.serverUrl.href.replace(/\/$/, "") : typeof input.serverUrl === "string" ? input.serverUrl.replace(/\/$/, "") : "";
    const _sessionId = process.env.OPENCODE_SESSION_ID ?? sessionId;
    dbg4(`STARTUP signal-wire: serverUrl=${_serverUrl} sessionId=${_sessionId}`);
    setSignalWireServerUrl(_serverUrl);
    let wakeHandle = null;
    let _memberId = process.env.SYNQTASK_MEMBER_ID;
    let _memberType = "unknown";
    try {
      const configPath = __require_gv7hsff9("path").join(cwd, "opencode.json");
      if (__require_gv7hsff9("fs").existsSync(configPath)) {
        const projConfig = JSON.parse(__require_gv7hsff9("fs").readFileSync(configPath, "utf-8"));
        const synqHeaders = projConfig?.mcp?.synqtask?.headers;
        if (synqHeaders?.["X-Agent-Id"]) {
          _memberId = synqHeaders["X-Agent-Id"];
          _memberType = "agent";
          dbg4(`WAKE memberId from opencode.json (agent): ${_memberId}`);
        }
      }
    } catch (e2) {
      dbg4(`WAKE config read failed: ${e2?.message}`);
    }
    if (!_memberId || _memberType !== "agent") {
      try {
        const oauthResult = await resolveOAuthIdentity();
        if (oauthResult) {
          _memberId = oauthResult.memberId;
          _memberType = "human";
          dbg4(`WAKE memberId from OAuth whoami (human): ${_memberId} name=${oauthResult.memberName}`);
        } else if (!_memberId) {
          setIdentityError("OAuth whoami returned no member (token expired or SynqTask down?)");
          dbg4(`WAKE OAuth whoami failed: ${_identityError}`);
        }
      } catch (e2) {
        setIdentityError(e2?.message ?? "OAuth whoami exception");
        dbg4(`WAKE OAuth identity failed (non-fatal): ${_identityError}`);
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
        dbg4(`WAKE listener started on port ${wakeHandle.port} token=${wakeHandle.token.slice(0, 8)}...`);
      } catch (e2) {
        dbg4(`WAKE listener failed to start: ${e2?.message ?? e2}`);
      }
    } else {
      dbg4(`WAKE listener skipped: serverUrl=${_serverUrl} sessionId=${_sessionId}`);
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
      dbg4("Not logged in \u2014 run: opencode providers login -p claude-max");
    }
    return {
      config: async (config) => {
        const tc = Date.now();
        if (!config.provider)
          config.provider = {};
        dbg4("STARTUP config hook called");
        config.provider["claude-max"] = {
          id: "claude-max",
          name: "Claude Max/Pro",
          api: "https://api.anthropic.com",
          npm: providerPath,
          env: [],
          models: {}
        };
        for (const [id, info2] of Object.entries(V)) {
          const isAdaptive = te(id);
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
        dbg4(`STARTUP config hook done in ${Date.now() - tc}ms \u2014 ${Object.keys(config.provider["claude-max"].models).length} models registered`);
      },
      auth: {
        provider: "claude-max",
        loader: async (_getAuth, provider) => {
          const tl = Date.now();
          dbg4("STARTUP auth.loader called", { providerModels: Object.keys(provider.models ?? {}), providerOptions: provider.options });
          dbg4(`STARTUP auth.loader done in ${Date.now() - tl}ms credPath=${creds.credPath}`);
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
              const savePath = inputs?.credLocation === "local" ? join9(cwd, ".claude", ".credentials.json") : join9(homedir9(), ".claude", ".credentials.json");
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
                fetch(req2) {
                  const url2 = new URL(req2.url);
                  if (url2.pathname !== "/callback")
                    return new Response("Not found", { status: 404 });
                  const code = url2.searchParams.get("code");
                  const st2 = url2.searchParams.get("state");
                  const error2 = url2.searchParams.get("error");
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
                      dbg4(`Token exchange failed (${tokenRes.status}): ${body}`);
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
          dbg4(`MCP_EVENT: tools changed on server=${event.properties?.server}`);
        }
      },
      pre_tool_use: async ({ toolName, input: input2 }) => {
        try {
          const result = await handlePreToolUseSpawnCheck(toolName, _serverUrl, _sessionId, input2);
          if (result)
            return result;
        } catch (e2) {
          dbg4(`pre_tool_use hook error (allowing): ${e2?.message}`);
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
  getIdentityError2 as getIdentityError,
  opencode_claude_default as default
};
