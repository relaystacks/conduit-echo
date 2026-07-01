'use strict';

/**
 * Thin wrapper around a Socket.IO Server instance.
 *
 * Emits events to Socket.IO rooms using the Laravel Echo convention:
 * emit(event, channel, data) — the channel name is the first argument.
 */
class SocketIoAdapter {
    /**
     * @param {import('socket.io').Server} io  Socket.IO server instance
     * @throws {Error} If io is missing
     */
    constructor(io) {
        if (!io) throw new Error('[SocketIoAdapter] io instance is required.');
        this._io = io;
    }

    /**
     * Emit an event to all sockets in the given room.
     * @param {string} channel  Socket.IO room / channel name
     * @param {string} event    Event name
     * @param {*}      data     Event payload
     */
    send(channel, event, data) {
        this._io.to(channel).emit(event, channel, data);
    }

    /** @returns {import('socket.io').Server} */
    getIo() { return this._io; }
}

module.exports = SocketIoAdapter;
