/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI attempts to exchange its placeholder token for a
 *             temp API key via /api/oauth/claude_cli/create_api_key.
 *             The proxy intercepts this exchange and returns the current
 *             OAuth access token as the "API key" (the Anthropic API accepts
 *             claude.ai OAuth access tokens as x-api-key values).
 *             Subsequent requests carry this token as x-api-key and pass
 *             through the proxy without modification.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

function readCreds(): { accessToken?: string; expiresAt?: number } {
  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
    return creds?.claudeAiOauth ?? {};
  } catch {
    return {};
  }
}

/** Read the current OAuth access token from ~/.claude/.credentials.json. */
function readCredentialsToken(): string | undefined {
  return readCreds().accessToken;
}

/**
 * Start a background loop that refreshes the OAuth access token before it
 * expires. The host `claude` CLI manages the token lifecycle — running it
 * with a cheap API call forces a refresh through the normal OAuth flow.
 * Checks every hour; refreshes when fewer than 90 minutes remain.
 */
export function startTokenRefreshLoop(): void {
  const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const REFRESH_THRESHOLD_MS = 90 * 60 * 1000; // refresh when < 90 min left

  const check = (): void => {
    const { expiresAt } = readCreds();
    if (!expiresAt) return;
    const remaining = expiresAt - Date.now();
    if (remaining < REFRESH_THRESHOLD_MS) {
      logger.info(
        { remainingMin: Math.round(remaining / 60000) },
        'OAuth token expiring soon, refreshing via claude CLI',
      );
      // Spawn claude with a minimal prompt; the CLI refreshes the token as
      // part of its normal auth flow before making any API call.
      const child = spawn('claude', ['-p', 'ok', '--output-format', 'text'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ANTHROPIC_BASE_URL: undefined },
      });
      child.unref();
    }
  };

  // Check immediately on startup, then on interval
  setTimeout(check, 5000);
  setInterval(check, CHECK_INTERVAL_MS);
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
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

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
          // OAuth mode: intercept the key-exchange endpoint.
          // Personal claude.ai tokens lack org:create_api_key scope so the
          // real endpoint returns 403. Return a mock success with the current
          // access token instead; the Anthropic API accepts it as x-api-key.
          if (
            req.method === 'POST' &&
            req.url?.includes('/api/oauth/claude_cli/create_api_key')
          ) {
            const token = readCredentialsToken() || oauthToken;
            if (token) {
              const mockBody = JSON.stringify({ raw_key: token });
              res.writeHead(200, {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(mockBody),
              });
              res.end(mockBody);
              logger.debug(
                'Intercepted create_api_key exchange, returning access token',
              );
              return;
            }
          }

          // For all other OAuth requests: replace placeholder Bearer with
          // real token when present (auth probes etc.)
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = readCredentialsToken() || oauthToken;
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
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
