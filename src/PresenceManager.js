'use strict';

/**
 * In-memory tracker for presence channel membership.
 *
 * Deduplicates by user_id across multiple socket connections (tabs), so a user
 * joining from two tabs only triggers one presence:joining event. When the
 * user's last socket leaves, triggers presence:leaving.
 *
 * Internal data structures:
 *   _channels:       Map<channelName, Map<socketId, channelData>>
 *   _socketChannels: Map<socketId, Set<channelName>>  (reverse index)
 */
class PresenceManager {
    constructor() {
        this._channels = new Map();
        this._socketChannels = new Map();
    }

    /**
     * Register a socket's presence in a channel.
     * @param {string} channel
     * @param {string} socketId
     * @param {Object} channelData  Must contain user_id and user_info
     * @returns {{isNew: boolean, members: Object[]}}  isNew = first socket for this user_id
     */
    join(channel, socketId, channelData) {
        if (!this._channels.has(channel)) {
            this._channels.set(channel, new Map());
        }

        const channelMembers = this._channels.get(channel);
        const isNew = !this._userExists(channelMembers, channelData.user_id);

        channelMembers.set(socketId, channelData);

        if (!this._socketChannels.has(socketId)) {
            this._socketChannels.set(socketId, new Set());
        }
        this._socketChannels.get(socketId).add(channel);

        return { isNew, members: this.members(channel) };
    }

    /**
     * Remove a single socket from a channel.
     * @param {string} channel
     * @param {string} socketId
     * @returns {{wasLast: boolean, member: Object|null}}  wasLast = no more sockets for this user_id
     */
    leave(channel, socketId) {
        const channelMembers = this._channels.get(channel);
        if (!channelMembers || !channelMembers.has(socketId)) {
            return { wasLast: false, member: null };
        }

        const member = channelMembers.get(socketId);
        channelMembers.delete(socketId);

        const socketSet = this._socketChannels.get(socketId);
        if (socketSet) {
            socketSet.delete(channel);
            if (socketSet.size === 0) this._socketChannels.delete(socketId);
        }

        const wasLast = !this._userExists(channelMembers, member.user_id);

        if (channelMembers.size === 0) {
            this._channels.delete(channel);
        }

        return { wasLast, member };
    }

    /**
     * Remove a socket from all presence channels (used on disconnect).
     * @param {string} socketId
     * @returns {Array<{channel: string, wasLast: boolean, member: Object}>}
     */
    leaveAll(socketId) {
        const channels = this._socketChannels.get(socketId);
        if (!channels) return [];

        const departures = [];
        for (const channel of channels) {
            const channelMembers = this._channels.get(channel);
            if (!channelMembers || !channelMembers.has(socketId)) continue;

            const member = channelMembers.get(socketId);
            channelMembers.delete(socketId);

            const wasLast = !this._userExists(channelMembers, member.user_id);

            if (channelMembers.size === 0) {
                this._channels.delete(channel);
            }

            departures.push({ channel, wasLast, member });
        }

        this._socketChannels.delete(socketId);
        return departures;
    }

    /**
     * Get current members of a channel, deduplicated by user_id.
     * @param {string} channel
     * @returns {Object[]}
     */
    members(channel) {
        const channelMembers = this._channels.get(channel);
        if (!channelMembers) return [];

        const seen = new Set();
        const result = [];
        for (const data of channelMembers.values()) {
            if (!seen.has(data.user_id)) {
                seen.add(data.user_id);
                result.push(data);
            }
        }
        return result;
    }

    /** @returns {boolean} True if any socket in the channel has this userId */
    _userExists(channelMembers, userId) {
        for (const data of channelMembers.values()) {
            if (data.user_id === userId) return true;
        }
        return false;
    }
}

module.exports = PresenceManager;
