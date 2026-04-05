#!/bin/bash
set -e

# Compile TypeScript agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# If the DeepSeek router is enabled, start the translation proxy and
# repoint ANTHROPIC_BASE_URL at the local proxy instead of the host credential proxy.
if [ "$CLAUDE_CODE_ROUTER_ENABLED" = "true" ]; then
  PROXY_PORT=3456

  echo "[entrypoint] Starting DeepSeek translation proxy on port ${PROXY_PORT}..." >&2
  PROXY_PORT=$PROXY_PORT node /app/deepseek-proxy.mjs &
  PROXY_PID=$!

  # Wait for the proxy to become ready (up to 10 seconds)
  for i in $(seq 1 20); do
    if curl -sf "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
      echo "[entrypoint] Proxy ready after ~$((i/2))s" >&2
      break
    fi
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then
      echo "[entrypoint] Proxy process died, falling back to direct Anthropic API" >&2
      break
    fi
    sleep 0.5
  done

  if kill -0 "$PROXY_PID" 2>/dev/null && curl -sf "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
    # Override the base URL so the SDK talks to the local proxy
    export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
    # The proxy handles auth directly — give the SDK a dummy key
    export ANTHROPIC_API_KEY="proxy-managed"
    unset CLAUDE_CODE_OAUTH_TOKEN
    echo "[entrypoint] Routing: Claude Agent SDK -> DeepSeek proxy -> api.deepseek.com (model: ${ROUTER_MODEL:-deepseek-chat})" >&2
  else
    echo "[entrypoint] Proxy not available, using default Anthropic path" >&2
  fi
fi

# Read container input from stdin, then run the agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
