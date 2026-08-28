# @kiberos/claude-max-proxy

`claude-max` runs the official Claude Code CLI through a local proxy that keeps your prompt
cache warm. The cache Anthropic builds for a conversation expires while you think; when it
does, the next turn re-buys it in full. This proxy re-touches the cache in the background so
the turn after your break is a cheap read instead of a full re-purchase.

It authenticates with **your own** Claude subscription (Max/Pro) over OAuth — the same login
the `claude` CLI uses. No API key, and no account of ours is involved.

## Requirements

| | |
|---|---|
| OS | macOS (Intel/ARM) or Linux (x86_64/aarch64). Windows: use WSL2 |
| Node.js + npm | auto-installed via nvm if missing |
| bun | auto-installed by the installer (the CLI itself runs on bun) |
| unzip | Linux only, needed by bun's installer — `apt-get install -y unzip` |
| account | a Claude Max or Pro subscription you log into yourself |

## Install

```bash
curl -fsSL https://get.muid.io/claude-max | bash
```

The installer is idempotent — re-running it upgrades in place. It ensures Node and bun,
points `@kiberos` / `@life-ai-tools` at `https://npm.muid.io`, installs this package
globally, then runs `claude-max doctor`, which installs the `claude` CLI, the proxy files,
the OS service (systemd/launchd) and starts the proxy.

**Open a new terminal afterwards** — the installer adds `~/.local/bin` to your shell rc, and
the current shell does not see it yet.

## First run

```bash
claude-max
```

First launch opens the normal Claude Code login flow in your browser. After that, `claude-max`
is a drop-in replacement for `claude`: same interface, same arguments, warm cache underneath.

## Verifying the install — for a human, and for an agent

A human reads the checklist:

```bash
claude-max doctor          # prints the checklist, and heals what is missing
```

A machine reads JSON and an exit code:

```bash
claude-max doctor --json   # read-only: installs nothing, starts nothing
```

```json
{
  "ok": true,
  "needsLogin": false,
  "version": "1.0.57",
  "endpoint": "http://127.0.0.1:5050",
  "checks": {
    "bun": "/home/you/.bun/bin/bun",
    "claudeCli": "/usr/local/bin/claude",
    "proxyFilesInstalled": true,
    "binLink": true,
    "binInPath": true,
    "service": "systemd",
    "serviceInstalled": true,
    "serviceActive": true,
    "proxyAlive": true,
    "oauthCredentials": true
  },
  "paths": { "installDir": "…", "logFile": "…", "jsonlFile": "…" }
}
```

`ok` covers everything the package controls — bun, the `claude` CLI, the installed files, the
symlink, a live proxy — and the process exits `0` when it is true, `1` otherwise. Logging in is
tracked separately as `needsLogin`: a fresh machine that nobody has logged in on yet is
correctly installed, just not started. The proxy also answers a plain health probe:

```bash
curl -s http://127.0.0.1:5050/health     # {"ok":true,"uptime":…,"sessions":…}
```

## Commands

| | |
|---|---|
| `claude-max` | start the proxy if needed, then exec `claude` |
| `claude-max doctor [--json]` | self-check (and auto-heal, unless `--json`) |
| `claude-max status` | proxy state + active sessions |
| `claude-max watch` | live dashboard in the terminal |
| `claude-max logs [-f]` | tail the proxy log |
| `claude-max config` | resolved configuration and file locations |
| `claude-max stop` / `restart` | stop / restart the service |
| `claude-max org list\|switch` | multi-org: per-org token vault, pin a session to an org |
| `claude-max update` | install the latest published version |
| `claude-max uninstall` | remove the service and binaries, keep logs and credentials |

## Where things live

| | |
|---|---|
| installed runtime | `~/.local/share/claude-max-proxy/` |
| launcher symlink | `~/.local/bin/claude-max` |
| log + event journal | `~/.claude/claude-max-proxy.log`, `…jsonl` |
| where the proxy is | `~/.claude/claude-max-proxy.json` (written by the proxy, read by the CLIs) |
| service unit | systemd user unit, or launchd agent on macOS |

## What talks to whom

Your requests go from `claude` to the local proxy on `127.0.0.1`, and from there to
`api.anthropic.com` under your own OAuth token. Conversation content is never sent anywhere
else; the logs stay on your machine. The only call that reaches us is a version check against
`https://npm.muid.io` on startup (skip it with `--no-update`), plus the install itself.

When a newer version is published, the launcher stops and tells you to run `claude-max update`
rather than silently running an old build.

## Source and license

The two halves are licensed differently, on purpose.

**This package — MIT, readable source.** What you install is what runs (on bun): the HTTP
server, the routes, the logging, the quota accounting, the dashboard. Read it, patch it, fork
it, ship it — MIT means MIT.

**The engine underneath — `@life-ai-tools/claude-code-sdk` — is a compiled bundle** with
complete type declarations, under the Kiberos Engine License. In plain terms: use it freely,
for anything, including paid work, on as many machines as you like, with no key and no fee;
but do not redistribute it on its own or inside a product you hand to third parties, and do
not take the bundle apart. The decisions inside it — how the prompt cache is kept warm, when
a spend is stopped — are the substance of the product. Source access for auditors,
contributors and compliance reviews is granted separately on request.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| `bun: No such file or directory` | bun did not install — on Linux install `unzip`, then re-run the installer |
| `claude-max: command not found` | open a new terminal, or `export PATH="$HOME/.local/bin:$PATH"` |
| npm `E401` while installing | the registry line is missing from `~/.npmrc`; re-run the installer |
| `doctor` says proxy not alive | `claude-max logs` for the reason, then `claude-max restart` |
| it stops and asks you to update | that is deliberate: `claude-max update`, or `claude-max --no-update …` |

More on how subscription quota and the cache actually behave: [docs/quota-mechanics.md](docs/quota-mechanics.md).
