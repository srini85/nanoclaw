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
 *      → accessToken if not expired; auto-refreshed via refresh_token if expired
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

const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

type OAuthCreds = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
};

type CredentialsFile = { claudeAiOauth?: OAuthCreds };

function readCredentialsFile(credentialsPath: string): CredentialsFile | null {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as CredentialsFile;
  } catch {
    return null;
  }
}

/** In-flight refresh promise to prevent concurrent refresh attempts. */
let refreshInFlight: Promise<string | undefined> | null = null;

/**
 * Use the refresh_token in credentialsPath to obtain a new access token.
 * Updates the file on success. Returns the new access token, or undefined on failure.
 */
async function refreshToken(
  credentialsPath: string,
  refreshToken: string,
  scopes: string[],
): Promise<string | undefined> {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_CLIENT_ID,
    scope: scopes.join(' '),
  });

  return new Promise((resolve) => {
    const url = new URL(CLAUDE_TOKEN_URL);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString()) as {
              access_token?: string;
              refresh_token?: string;
              expires_in?: number;
            };
            if (!data.access_token) {
              logger.warn({ status: res.statusCode }, 'OAuth token refresh failed');
              resolve(undefined);
              return;
            }
            const expiresAt = Date.now() + (data.expires_in ?? 28800) * 1000;
            const existing = readCredentialsFile(credentialsPath) ?? {};
            existing.claudeAiOauth = {
              ...existing.claudeAiOauth,
              accessToken: data.access_token,
              refreshToken: data.refresh_token ?? refreshToken,
              expiresAt,
            };
            fs.writeFileSync(credentialsPath, JSON.stringify(existing, null, 2), {
              mode: 0o600,
            });
            logger.info(
              { expiresAt: new Date(expiresAt).toISOString() },
              'OAuth token refreshed and saved',
            );
            resolve(data.access_token);
          } catch (err) {
            logger.warn({ err }, 'OAuth refresh response parse error');
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', (err) => {
      logger.warn({ err }, 'OAuth refresh request error');
      resolve(undefined);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Get a valid access token from a credentials file.
 * If expired and a refresh token is available, refreshes automatically.
 */
async function getTokenFromDir(configDir: string): Promise<string | undefined> {
  const credentialsPath = path.join(configDir, '.credentials.json');
  const creds = readCredentialsFile(credentialsPath);
  const oauth = creds?.claudeAiOauth;
  if (!oauth) return undefined;

  if (oauth.accessToken && oauth.expiresAt && oauth.expiresAt > Date.now()) {
    return oauth.accessToken;
  }

  // Expired — try refresh if we have a refresh token
  if (oauth.refreshToken) {
    if (!refreshInFlight) {
      refreshInFlight = refreshToken(
        credentialsPath,
        oauth.refreshToken,
        oauth.scopes ?? [],
      ).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  return undefined;
}

/**
 * Get the current OAuth access token.
 * Tries CLAUDE_CONFIG_DIR first (with auto-refresh), then ~/.claude as fallback.
 */
async function getClaudeCredentialsToken(): Promise<string | undefined> {
  const envSecrets = readEnvFile(['CLAUDE_CONFIG_DIR']);
  const configuredDir = (
    envSecrets.CLAUDE_CONFIG_DIR ||
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(os.homedir(), '.claude')
  ).replace(/^~/, os.homedir());

  const token = await getTokenFromDir(configuredDir);
  if (token) return token;

  // Fall back to ~/.claude if configuredDir was a different directory
  const defaultDir = path.join(os.homedir(), '.claude');
  if (configuredDir !== defaultDir) {
    return getTokenFromDir(defaultDir);
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
        void (async () => {
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
            // Token is refreshed automatically if expired.
            if (headers['authorization']) {
              delete headers['authorization'];
              const envSecrets = readEnvFile([
                'CLAUDE_CODE_OAUTH_TOKEN',
                'ANTHROPIC_AUTH_TOKEN',
              ]);
              const freshToken =
                (await getClaudeCredentialsToken()) ||
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
        })();
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
