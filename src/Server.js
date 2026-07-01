'use strict';

const { Server: SocketIOServer } = require('socket.io');

const IpcReceiver      = require('./IpcReceiver');
const MessageValidator = require('./MessageValidator');
const SocketIoAdapter  = require('./SocketIoAdapter');
const BroadcastService = require('./BroadcastService');
const AuthService      = require('./AuthService');
const PresenceManager  = require('./PresenceManager');

/** @const {RegExp} Matches private channel names */
const PRIVATE_CHANNEL_RE  = /^private-/;
/** @const {RegExp} Matches presence channel names */
const PRESENCE_CHANNEL_RE = /^presence-/;

/**
 * Orchestrator for the conduit-echo relay server.
 *
 * Sets up Socket.IO, IPC receiver, broadcast pipeline, and auth service.
 * Handles subscribe/unsubscribe/disconnect lifecycle for public, private,
 * and presence channels.
 */
class Server {
    /**
     * @param {import('http').Server} httpServer         Node HTTP server (Passenger provides this)
     * @param {Object}                options
     * @param {string}                options.socketPath       Unix socket path for IPC with PHP
     * @param {string}                options.authEndpoint     Full URL to Laravel /broadcasting/auth
     * @param {string}               [options.ioPath='/socket.io']       Socket.IO path
     * @param {string}               [options.corsOrigin='*']           Allowed CORS origin(s)
     * @param {string|null}          [options.secret=null]              HMAC shared secret
     * @param {number}               [options.authMaxSockets=10]        Max concurrent auth connections
     * @param {number}               [options.authKeepAliveMsecs=5000]  Keep-alive interval
     * @param {number}               [options.authTimeoutMs=5000]       Auth request timeout
     * @param {number}               [options.maxFrameBytes=65536]      Max IPC frame size
     * @throws {Error} If httpServer, socketPath, or authEndpoint is missing
     */
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
        this._presenceManager  = new PresenceManager();
    }

    /**
     * Initialize all services and start listening for IPC messages and Socket.IO connections.
     * @returns {Promise<void>}
     */
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

    /** @returns {import('socket.io').Server|null} */
    getIo() { return this._io; }

    /**
     * Graceful shutdown — stop IPC, destroy auth agent, close Socket.IO.
     * @returns {Promise<void>}
     */
    async stop() {
        await this._ipcReceiver?.stop();
        this._authService?.destroy();
        await new Promise((resolve) => this._io?.close(resolve));
        console.log('[conduit-echo] Shutdown complete.');
    }

    /** Attach user token and allowedChannels set to each new socket. */
    _connectionMiddleware(socket, next) {
        socket.user            = socket.handshake.auth?.token ?? null;
        socket.allowedChannels = new Set();
        next();
    }

    /** Register subscribe, unsubscribe, disconnect, client event, and error handlers. */
    _onConnection(socket) {
        console.log(`[conduit-echo] Connected  : ${socket.id}`);
        socket.on('subscribe',    (payload) => this._onSubscribe(socket, payload));
        socket.on('unsubscribe',  (payload) => this._onUnsubscribe(socket, payload));
        socket.on('client event', (payload) => this._onClientEvent(socket, payload));
        socket.on('disconnect',   (reason)  => this._onDisconnect(socket, reason));
        socket.on('error',        (err)     => console.error(`[conduit-echo] Socket error (${socket.id}):`, err.message));
    }

    /** Route subscription to public, private, or presence handler by channel prefix. */
    async _onSubscribe(socket, payload) {
        const channel = payload?.channel;

        if (!channel || typeof channel !== 'string') {
            socket.emit('subscription_error', { channel, message: 'Invalid channel name.' });
            return;
        }

        if (PRESENCE_CHANNEL_RE.test(channel)) {
            await this._subscribePresence(socket, channel);
        } else if (PRIVATE_CHANNEL_RE.test(channel)) {
            await this._subscribePrivate(socket, channel);
        } else {
            this._subscribePublic(socket, channel);
        }
    }

    /** Leave the room; for presence channels, broadcast departure if last socket. */
    _onUnsubscribe(socket, payload) {
        const channel = payload?.channel;
        if (!channel || typeof channel !== 'string') return;

        socket.leave(channel);
        socket.allowedChannels.delete(channel);

        if (PRESENCE_CHANNEL_RE.test(channel)) {
            const { wasLast, member } = this._presenceManager.leave(channel, socket.id);
            if (wasLast && member) {
                this._io.to(channel).emit('presence:leaving', channel, member);
            }
        }

        console.log(`[conduit-echo] ${socket.id} ← unsubscribed "${channel}"`);
    }

    /** Clean up all presence memberships on disconnect. */
    _onDisconnect(socket, reason) {
        console.log(`[conduit-echo] Disconnected: ${socket.id} — ${reason}`);

        const departures = this._presenceManager.leaveAll(socket.id);
        for (const { channel, wasLast, member } of departures) {
            if (wasLast) {
                this._io.to(channel).emit('presence:leaving', channel, member);
            }
        }
    }

    /** Relay a client event (whisper) to other members of the channel. */
    _onClientEvent(socket, payload) {
        const { channel, event, data } = payload ?? {};
        if (!channel || !event || typeof channel !== 'string' || typeof event !== 'string') return;
        if (!socket.allowedChannels.has(channel)) return;
        if (!PRESENCE_CHANNEL_RE.test(channel) && !PRIVATE_CHANNEL_RE.test(channel)) return;

        let outData = data;
        if (PRESENCE_CHANNEL_RE.test(channel)) {
            const member = this._presenceManager.getMemberBySocket(channel, socket.id);
            if (member) {
                outData = { ...(data || {}), _sender: member };
            }
        }

        socket.to(channel).emit(event, channel, outData);
    }

    /** Join a public channel — no authorization required. */
    _subscribePublic(socket, channel) {
        socket.join(channel);
        socket.allowedChannels.add(channel);
        socket.emit('subscription_succeeded', { channel });
        console.log(`[conduit-echo] ${socket.id} → public "${channel}"`);
    }

    /** Authorize via Laravel and join a private channel. */
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

    /** Authorize via Laravel, register in PresenceManager, and join a presence channel. */
    async _subscribePresence(socket, channel) {
        const cookies = socket.handshake.headers?.cookie ?? '';
        try {
            const authResponse = await this._authService.authorize(socket.id, channel, cookies);

            const channelData = authResponse?.channel_data;
            if (!channelData || channelData.user_id === undefined) {
                console.warn(`[conduit-echo] Presence auth missing channel_data for "${channel}"`);
                socket.emit('subscription_error', { channel, message: 'Invalid presence auth response.' });
                return;
            }

            socket.join(channel);
            socket.allowedChannels.add(channel);

            const { isNew, members } = this._presenceManager.join(channel, socket.id, channelData);

            socket.emit('presence:subscribed', channel, members);

            if (isNew) {
                socket.to(channel).emit('presence:joining', channel, channelData);
            }

            console.log(`[conduit-echo] ${socket.id} → presence "${channel}" (user ${channelData.user_id})`);
        } catch (err) {
            const statusCode = err.statusCode ?? 500;
            console.warn(`[conduit-echo] Presence auth failed (${socket.id}, "${channel}"): HTTP ${statusCode}`);
            socket.emit('subscription_error', { channel, message: 'Unauthorised.', statusCode });
        }
    }
}

module.exports = Server;
