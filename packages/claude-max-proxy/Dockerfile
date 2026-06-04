# claude-max-proxy — containerized for sidecar deployment (e.g. tixi-cold).
#
# Runs the self-contained `bun build --compile` binary (no node_modules / no
# bun install at image-build time → sidesteps the workspace + npm.muid.io dep
# resolution entirely; the binary already embeds the resolved code + bun
# runtime). Build the binary first on a host that has the workspace deps:
#
#     bun run scripts/build-proxy.ts --target=bun-linux-x64
#
# then build this image from THIS directory as context:
#
#     docker build -t tixi-cold/claude-max-proxy:<tag> packages/claude-max-proxy
#
# The image carries NO credentials — the subscription OAuth session
# (~/.claude/.credentials.json) is mounted read-only at runtime via
# CLAUDE_CREDENTIALS_PATH (see docker-compose.prod.yml).
FROM debian:bookworm-slim

# ca-certificates: the proxy makes outbound TLS calls to api.anthropic.com.
# wget: used by the container HEALTHCHECK / compose healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*

# The pre-compiled linux-x64 standalone binary (built by scripts/build-proxy.ts).
COPY dist/claude-max-proxy-linux-x64 /usr/local/bin/claude-max-proxy
RUN chmod +x /usr/local/bin/claude-max-proxy

# Container-reachable bind + standard port. Credentials path points at the
# mounted secret (NOT baked into the image).
ENV PROXY_HOST=0.0.0.0 \
    PROXY_PORT=5050 \
    CLAUDE_CREDENTIALS_PATH=/creds/.credentials.json

EXPOSE 5050

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:5050/health || exit 1

CMD ["/usr/local/bin/claude-max-proxy"]
