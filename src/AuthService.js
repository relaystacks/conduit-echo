'use strict';

const http        = require('http');
const querystring = require('querystring');

class AuthService {
    constructor({ authEndpoint, maxSockets = 10, keepAliveMsecs = 5_000, timeoutMs = 5_000 }) {
        if (!authEndpoint) throw new Error('[AuthService] authEndpoint is required.');

        this._endpoint  = new URL(authEndpoint);
        this._timeoutMs = timeoutMs;

        this._agent = new http.Agent({ keepAlive: true, maxSockets, keepAliveMsecs });
    }

    authorize(socketId, channelName, cookies = '') {
        return new Promise((resolve, reject) => {
            const body = querystring.stringify({
                socket_id:    socketId,
                channel_name: channelName,
            });

            const options = {
                hostname: this._endpoint.hostname,
                port:     this._endpoint.port || 80,
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

            const req = http.request(options, (res) => {
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

    destroy() { this._agent.destroy(); }
}

module.exports = AuthService;
