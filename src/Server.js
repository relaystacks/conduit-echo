'use strict';

const { Server: SocketIOServer } = require('socket.io');

const IpcReceiver      = require('./IpcReceiver');
const MessageValidator = require('./MessageValidator');
const SocketIoAdapter  = require('./SocketIoAdapter');
const BroadcastService = require('./BroadcastService');
const AuthService      = require('./AuthService');

const PRIVATE_CHANNEL_RE  = /^private-/;
const PRESENCE_CHANNEL_RE = /^presence-/;

class Server {
    constructor(httpServer, options = {}) {
        if (!httpServer)           throw new Error('[Server] httpServer is required.');
        if (!options.socketPath)   throw new Error('[Server] options.socketPath is required.');
        if (!options.authEndpoint) throw new Error('[Server] options.authEndpoint is required.');

        this._httpServer = httpServer;
        this._options    = {
            ioPath:             '/socket.io',
            corsOrigin:         '*',
            secret:             null,
            authMaxSockets:     10,
            authKeepAliveMsecs: 5_000,
            authTimeoutMs:      5_000,
            maxFrameBytes:      65_536,
            ...options,
        };

        this._io               = null;
        this._ipcReceiver      = null;
        this._broadcastService = null;
        this._authService      = null;
    }

    async start() {
        const o = this._options;

        this._io = new SocketIOServer(this._httpServer, {
            path:       o.ioPath,
            cors:       { origin: o.corsOrigin, methods: ['GET', 'POST'], credentials: true },
            transports: ['websocket', 'polling'],
        });

        this._authService = new AuthService({
            authEndpoint:   o.authEndpoint,
            maxSockets:     o.authMaxSockets,
            keepAliveMsecs: o.authKeepAliveMsecs,
            timeoutMs:      o.authTimeoutMs,
        });

        this._ipcReceiver = new IpcReceiver({
            socketPath:    o.socketPath,
            maxFrameBytes: o.maxFrameBytes,
        });

        const validator = new MessageValidator({ secret: o.secret, maxSize: o.maxFrameBytes });
        const adapter   = new SocketIoAdapter(this._io);

        this._broadcastService = new BroadcastService(this._ipcReceiver, validator, adapter);
        this._broadcastService.start();

        await this._ipcReceiver.start();

        this._io.use(this._connectionMiddleware.bind(this));
        this._io.on('connection', (socket) => this._onConnection(socket));

        console.log('[conduit-echo] Server started.');
        console.log(`[conduit-echo]   IPC socket  : ${o.socketPath}`);
        console.log(`[conduit-echo]   Auth URL    : ${o.authEndpoint}`);
        console.log(`[conduit-echo]   Socket.IO   : ${o.ioPath}`);
    }

    getIo() { return this._io; }

    async stop() {
        await this._ipcReceiver?.stop();
        this._authService?.destroy();
        await new Promise((resolve) => this._io?.close(resolve));
        console.log('[conduit-echo] Shutdown complete.');
    }

    _connectionMiddleware(socket, next) {
        socket.user            = socket.handshake.auth?.token ?? null;
        socket.allowedChannels = new Set();
        next();
    }

    _onConnection(socket) {
        console.log(`[conduit-echo] Connected  : ${socket.id}`);
        socket.on('subscribe',  (payload) => this._onSubscribe(socket, payload));
        socket.on('disconnect', (reason)  => console.log(`[conduit-echo] Disconnected: ${socket.id} — ${reason}`));
        socket.on('error',      (err)     => console.error(`[conduit-echo] Socket error (${socket.id}):`, err.message));
    }

    async _onSubscribe(socket, payload) {
        const channel = payload?.channel;

        if (!channel || typeof channel !== 'string') {
            socket.emit('subscription_error', { channel, message: 'Invalid channel name.' });
            return;
        }

        if (PRIVATE_CHANNEL_RE.test(channel) || PRESENCE_CHANNEL_RE.test(channel)) {
            await this._subscribePrivate(socket, channel);
        } else {
            this._subscribePublic(socket, channel);
        }
    }

    _subscribePublic(socket, channel) {
        socket.join(channel);
        socket.allowedChannels.add(channel);
        socket.emit('subscription_succeeded', { channel });
        console.log(`[conduit-echo] ${socket.id} → public "${channel}"`);
    }

    async _subscribePrivate(socket, channel) {
        const cookies = socket.handshake.headers?.cookie ?? '';
        try {
            const authResponse = await this._authService.authorize(socket.id, channel, cookies);
            socket.join(channel);
            socket.allowedChannels.add(channel);
            socket.emit('subscription_succeeded', { channel, auth: authResponse });
            console.log(`[conduit-echo] ${socket.id} → private "${channel}"`);
        } catch (err) {
            const statusCode = err.statusCode ?? 500;
            console.warn(`[conduit-echo] Auth failed (${socket.id}, "${channel}"): HTTP ${statusCode}`);
            socket.emit('subscription_error', { channel, message: 'Unauthorised.', statusCode });
        }
    }
}

module.exports = Server;
