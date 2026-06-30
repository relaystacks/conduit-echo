'use strict';

class SocketIoAdapter {
    constructor(io) {
        if (!io) throw new Error('[SocketIoAdapter] io instance is required.');
        this._io = io;
    }

    send(channel, event, data) {
        this._io.to(channel).emit(event, data);
    }

    getIo() { return this._io; }
}

module.exports = SocketIoAdapter;
