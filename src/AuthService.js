'use strict';

const http        = require('http');
const https       = require('https');
const querystring = require('querystring');

/**
 * HTTP/HTTPS client that authorizes channel subscriptions by POSTing to
 * Laravel's /broadcasting/auth endpoint.
 *
 * Uses a keep-alive Agent for connection pooling. Forwards the browser's
 * cookies so Laravel can identify the session. Automatically selects http
 * or https based on the endpoint URL protocol.
 */
class AuthService {
    /**
     * @param {Object} options
     * @param {string} options.authEndpoint      Full URL to Laravel /broadcasting/auth
     * @param {number} [options.maxSockets=10]   Max concurrent connections to Laravel
     * @param {number} [options.keepAliveMsecs=5000]
     * @param {number} [options.timeoutMs=5000]  Request timeout in milliseconds
     * @throws {Error} If authEndpoint is missing
     */
    constructor({ authEndpoint, maxSockets = 10, keepAliveMsecs = 5_000, timeoutMs = 5_000 }) {
        if (!authEndpoint) throw new Error('[AuthService] authEndpoint is required.');

        this._endpoint  = new URL(authEndpoint);
        this._timeoutMs = timeoutMs;
        this._isHttps   = this._endpoint.protocol === 'https:';

        const AgentClass = this._isHttps ? https.Agent : http.Agent;
        this._agent = new AgentClass({ keepAlive: true, maxSockets, keepAliveMsecs });
    }

    /**
     * POST socket_id and channel_name to the auth endpoint.
     *
     * @param {string} socketId     Socket.IO socket ID
     * @param {string} channelName  Channel being subscribed to
     * @param {string} [cookies=''] Raw Cookie header from the browser handshake
     * @returns {Promise<Object>}   Parsed JSON auth response from Laravel
     * @throws {Error} With .statusCode on non-200 responses or timeouts
     */
    authorize(socketId, channelName, cookies = '') {
        return new Promise((resolve, reject) => {
            const body = querystring.stringify({
                socket_id:    socketId,
                channel_name: channelName,
            });

            const options = {
                hostname: this._endpoint.hostname,
                port:     this._endpoint.port || (this._isHttps ? 443 : 80),
                path:     this._endpoint.pathname,
                method:   'POST',
                agent:    this._agent,
                headers: {
                    'Content-Type':     'application/x-www-form-urlencoded',
                    'Content-Length':   Buffer.byteLength(body),
                    'Accept':           'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    ...(cookies ? { Cookie: cookies } : {}),
                },
            };

            const lib = this._isHttps ? https : http;
            const req = lib.request(options, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode !== 200) {
                        const err = new Error(
                            `[AuthService] Laravel returned HTTP ${res.statusCode} for "${channelName}".`
                        );
                        err.statusCode = res.statusCode;
                        err.body       = raw;
                        return reject(err);
                    }
                    try { resolve(JSON.parse(raw)); }
                    catch { reject(new Error(`[AuthService] Non-JSON response: ${raw.slice(0, 200)}`)); }
                });
            });

            req.setTimeout(this._timeoutMs, () =>
                req.destroy(new Error(`[AuthService] Timed out after ${this._timeoutMs}ms.`))
            );

            req.on('error', (err) => {
                console.error('[AuthService] Request error:', err.message);
                reject(err);
            });

            req.write(body);
            req.end();
        });
    }

    /** Destroy the keep-alive agent, closing all pooled connections. */
    destroy() { this._agent.destroy(); }
}

module.exports = AuthService;
