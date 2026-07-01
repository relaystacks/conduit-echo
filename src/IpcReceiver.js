'use strict';

const net = require('net');
const fs  = require('fs');
const { EventEmitter } = require('events');

/**
 * Listens on a Unix domain socket for newline-delimited JSON messages from PHP.
 *
 * Buffers incoming data per connection, enforces maxFrameBytes, and emits
 * complete messages as 'message' events.
 *
 * @fires IpcReceiver#message
 * @fires IpcReceiver#error
 */
class IpcReceiver extends EventEmitter {
    /**
     * @param {Object} options
     * @param {string} options.socketPath       Unix socket path to listen on
     * @param {number} [options.maxFrameBytes=65536]  Max frame size before dropping the connection
     * @throws {Error} If socketPath is missing
     */
    constructor({ socketPath, maxFrameBytes = 65_536 }) {
        super();
        if (!socketPath) throw new Error('[IpcReceiver] socketPath is required.');
        this._socketPath    = socketPath;
        this._maxFrameBytes = maxFrameBytes;
        this._server        = null;
    }

    /**
     * Remove any stale socket file, create the server, and start listening.
     * Sets chmod 0o600 (owner-only) on the socket file for security.
     * @returns {Promise<void>}
     */
    start() {
        return new Promise((resolve, reject) => {
            this._removeStale();

            this._server = net.createServer((conn) => this._handleConnection(conn));

            this._server.on('error', (err) => {
                console.error('[IpcReceiver] Server error:', err.message);
                this.emit('error', err);
            });

            this._server.listen(this._socketPath, () => {
                try {
                    fs.chmodSync(this._socketPath, 0o600);
                    console.log(`[IpcReceiver] Listening on ${this._socketPath}`);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    /**
     * Close the server and remove the socket file.
     * @returns {Promise<void>}
     */
    stop() {
        return new Promise((resolve) => {
            if (!this._server) { resolve(); return; }
            this._server.close(() => { this._removeStale(); resolve(); });
        });
    }

    /** Buffer data chunks; on connection end, emit as a 'message' event. */
    _handleConnection(conn) {
        const chunks = [];
        let totalBytes = 0;

        conn.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > this._maxFrameBytes) {
                console.warn('[IpcReceiver] Oversized frame — dropping connection.');
                conn.destroy();
                return;
            }
            chunks.push(chunk);
        });

        conn.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (raw.length > 0) this.emit('message', raw);
        });

        conn.on('error', (err) => {
            console.warn('[IpcReceiver] Connection error:', err.message);
        });
    }

    /** Delete the socket file if it exists (handles unclean shutdown). */
    _removeStale() {
        try {
            if (fs.existsSync(this._socketPath)) fs.unlinkSync(this._socketPath);
        } catch (err) {
            console.warn('[IpcReceiver] Could not remove stale socket:', err.message);
        }
    }
}

module.exports = IpcReceiver;
