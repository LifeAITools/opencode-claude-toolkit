# Request Source Code Access

The `@life-ai-tools/claude-code-sdk` package is distributed as a compiled bundle on npm.

The **opencode-proxy** is fully open source in this repository.

## Who Can Request Source Access?

- **Security auditors** — need to verify the SDK doesn't exfiltrate credentials
- **Contributors** — want to fix bugs or add features
- **Enterprise users** — require source review for compliance

## How to Request

1. **Open an issue** in this repository with the title `[Source Access Request]`
2. Include:
   - Your name / organization
   - Reason for access (audit / contribute / compliance)
   - GitHub username(s) to grant access

We will grant access to a private repository containing the full SDK source.

## What's in the Compiled Bundle?

The SDK handles:
- OAuth credential reading from `~/.claude/.credentials.json`
- Automatic token refresh
- Streaming SSE requests to the Anthropic API
- Retry logic with exponential backoff
- Request building (headers, body, caching)

No telemetry, no data collection, no network calls other than to `api.anthropic.com` and `console.anthropic.com` (for auth refresh).

## Verification

You can verify the SDK only contacts Anthropic servers:

```bash
# Monitor network calls while using the SDK
strace -e trace=connect bun run your-script.ts 2>&1 | grep -i connect
```

The only outbound connections should be to:
- `api.anthropic.com` (API requests)
- `console.anthropic.com` (token refresh)
