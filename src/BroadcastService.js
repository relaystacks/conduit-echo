'use strict';

/**
 * Glue layer wiring IpcReceiver messages through MessageValidator to SocketIoAdapter.
 *
 * This is the pipeline from IPC to browser: receive -> validate -> emit.
 */
class BroadcastService {
    /**
     * @param {import('./IpcReceiver')}      receiver
     * @param {import('./MessageValidator')} validator
     * @param {import('./SocketIoAdapter')}  adapter
     */
    constructor(receiver, validator, adapter) {
        if (!receiver)  throw new Error('[BroadcastService] receiver is required.');
        if (!validator) throw new Error('[BroadcastService] validator is required.');
        if (!adapter)   throw new Error('[BroadcastService] adapter is required.');

        this._receiver  = receiver;
        this._validator = validator;
        this._adapter   = adapter;
    }

    /** Subscribe to receiver events and begin processing messages. */
    start() {
        this._receiver.on('message', (raw) => this._handleRaw(raw));
        this._receiver.on('error',   (err) => console.error('[BroadcastService] IPC error:', err.message));
        console.log('[BroadcastService] Pipeline active.');
    }

    /** Validate a raw message and forward to Socket.IO if valid. */
    _handleRaw(raw) {
        const message = this._validator.validate(raw);
        if (!message) return;

        const { channel, event, data } = message;
        try {
            this._adapter.send(channel, event, data);
            console.log(`[BroadcastService] → channel="${channel}" event="${event}"`);
        } catch (err) {
            console.error('[BroadcastService] Forward failed:', err.message, { channel, event });
        }
    }
}

module.exports = BroadcastService;
