'use strict';

const crypto = require('crypto');

const SAFE_NAME_RE = /^[a-zA-Z0-9_\-\.]+$/;

class MessageValidator {
    constructor({ secret = null, maxSize = 65_536 } = {}) {
        this._secret  = secret || null;
        this._maxSize = maxSize;
    }

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

    _hasRequiredFields(obj) {
        return obj !== null && typeof obj === 'object'
            && typeof obj.channel === 'string'
            && typeof obj.event   === 'string'
            && 'data' in obj;
    }

    _isSafeName(name) {
        return typeof name === 'string' && name.length > 0 && SAFE_NAME_RE.test(name);
    }

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
