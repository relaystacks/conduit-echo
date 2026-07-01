'use strict';

const crypto = require('crypto');

/** @const {RegExp} Allowed channel and event name pattern */
const SAFE_NAME_RE = /^[a-zA-Z0-9_\-\.]+$/;

/**
 * Validates raw JSON messages from IPC.
 *
 * Checks required fields, safe channel/event names, size limits, and
 * optionally verifies HMAC-SHA256 signatures using crypto.timingSafeEqual.
 */
class MessageValidator {
    /**
     * @param {Object}      [options={}]
     * @param {string|null} [options.secret=null]    Shared HMAC secret (null = skip verification)
     * @param {number}      [options.maxSize=65536]  Max raw message length in bytes
     */
    constructor({ secret = null, maxSize = 65_536 } = {}) {
        this._secret  = secret || null;
        this._maxSize = maxSize;
    }

    /**
     * Parse and validate a raw JSON message.
     * @param {string} raw  Raw JSON string from IPC
     * @returns {{channel: string, event: string, data: *}|null}  Validated message or null
     */
    validate(raw) {
        if (!raw || raw.length > this._maxSize) {
            this._warn('Message exceeds maxSize or is empty.');
            return null;
        }

        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { this._warn('Invalid JSON.'); return null; }

        if (!this._hasRequiredFields(parsed))  { this._warn('Missing required fields.'); return null; }
        if (!this._isSafeName(parsed.channel)) { this._warn('Unsafe channel name.', { channel: parsed.channel }); return null; }
        if (!this._isSafeName(parsed.event))   { this._warn('Unsafe event name.',   { event: parsed.event });   return null; }

        if (this._secret !== null && !this._verifyHmac(parsed)) {
            this._warn('HMAC verification failed — message rejected.');
            return null;
        }

        return { channel: parsed.channel, event: parsed.event, data: parsed.data };
    }

    /** @returns {boolean} True if obj has channel (string), event (string), and data. */
    _hasRequiredFields(obj) {
        return obj !== null && typeof obj === 'object'
            && typeof obj.channel === 'string'
            && typeof obj.event   === 'string'
            && 'data' in obj;
    }

    /** @returns {boolean} True if name matches SAFE_NAME_RE. */
    _isSafeName(name) {
        return typeof name === 'string' && name.length > 0 && SAFE_NAME_RE.test(name);
    }

    /**
     * Verify HMAC-SHA256 signature.
     *
     * Strips the hmac field, re-stringifies the body, and compares using
     * timingSafeEqual. The PHP side must produce byte-identical JSON key
     * ordering for verification to pass.
     *
     * @param {Object} parsed  Parsed JSON object including the hmac field
     * @returns {boolean}
     */
    _verifyHmac(parsed) {
        if (typeof parsed.hmac !== 'string') return false;
        const { hmac, ...body } = parsed;
        let bodyJson;
        try { bodyJson = JSON.stringify(body); } catch { return false; }

        const expected = crypto
            .createHmac('sha256', this._secret)
            .update(bodyJson)
            .digest('hex');

        try {
            return crypto.timingSafeEqual(
                Buffer.from(hmac,     'hex'),
                Buffer.from(expected, 'hex'),
            );
        } catch {
            return false;
        }
    }

    _warn(msg, ctx = {}) { console.warn(`[MessageValidator] ${msg}`, ctx); }
}

module.exports = MessageValidator;
