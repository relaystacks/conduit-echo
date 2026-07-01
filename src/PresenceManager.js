'use strict';

class PresenceManager {
    constructor() {
        this._channels = new Map();
        this._socketChannels = new Map();
    }

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

    _userExists(channelMembers, userId) {
        for (const data of channelMembers.values()) {
            if (data.user_id === userId) return true;
        }
        return false;
    }
}

module.exports = PresenceManager;
