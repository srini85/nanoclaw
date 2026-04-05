/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * OAuth token resolution order (checked fresh on each auth exchange):
 *   1. CLAUDE_CONFIG_DIR/.credentials.json (e.g. ~/.claude-sriom)
 *      → claudeAiOauth.accessToken if not expired
 *   2. ~/.claude/.credentials.json (fallback — kept fresh by regular claude CLI use)
 *   3. CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN from .env
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Read the current OAuth access token from a credentials file.
 * Returns undefined if not available or expired.
 */
function readTokenFromDir(configDir: string): string | undefined {
  const credentialsPath = path.join(configDir, '.credentials.json');
  try {
    const content = fs.readFileSync(credentialsPath, 'utf-8');
    const creds = JSON.parse(content) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const oauth = creds?.claudeAiOauth;
    if (
      oauth?.accessToken &&
      oauth?.expiresAt &&
      oauth.expiresAt > Date.now()
    ) {
      return oauth.accessToken;
    }
  } catch {
    // Not available
  }
  return undefined;
}

/**
 * Read the current OAuth access token from Claude Code's credentials file.
 * Checks the configured CLAUDE_CONFIG_DIR first, then falls back to ~/.claude
 * (the default Claude Code directory, kept fresh by regular claude CLI usage).
 * Returns undefined if not available or expired in either location.
 */
function readClaudeCredentialsToken(): string | undefined {
  const envSecrets = readEnvFile(['CLAUDE_CONFIG_DIR']);
  const configuredDir = (
    envSecrets.CLAUDE_CONFIG_DIR ||
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(os.homedir(), '.claude')
  ).replace(/^~/, os.homedir());

  // Try the configured dir first
  const token = readTokenFromDir(configuredDir);
  if (token) return token;

  // Fall back to ~/.claude if configuredDir was a different directory
  const defaultDir = path.join(os.homedir(), '.claude');
  if (configuredDir !== defaultDir) {
    return readTokenFromDir(defaultDir);
  }

  return undefined;
}

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          //
          // Read fresh on each exchange so a rotated token in .credentials.json
          // is picked up automatically without restarting the service.
          if (headers['authorization']) {
            delete headers['authorization'];
            const envSecrets = readEnvFile([
              'CLAUDE_CODE_OAUTH_TOKEN',
              'ANTHROPIC_AUTH_TOKEN',
            ]);
            const freshToken =
              readClaudeCredentialsToken() ||
              envSecrets.CLAUDE_CODE_OAUTH_TOKEN ||
              envSecrets.ANTHROPIC_AUTH_TOKEN;
            if (freshToken) {
              headers['authorization'] = `Bearer ${freshToken}`;
            } else {
              logger.warn(
                'OAuth mode: no valid token found in credentials file or .env',
              );
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
