'use strict';

/**
 * Passenger-compatible bootstrap for conduit-echo.
 *
 * Creates an Express + HTTP server and starts the Conduit relay. Never calls
 * listen() — Passenger manages the port. Exports httpServer as module.exports
 * per Passenger convention.
 *
 * Environment variables:
 *   CONDUIT_SOCKET_PATH   — Unix socket path shared with PHP (required in production)
 *   CONDUIT_AUTH_ENDPOINT  — Full URL to Laravel's /broadcasting/auth
 *   CONDUIT_IO_PATH        — Socket.IO path (must match cPanel subdirectory)
 *   CONDUIT_CORS_ORIGIN    — Allowed CORS origin(s)
 *   CONDUIT_SECRET         — Shared HMAC-SHA256 secret (null = no verification)
 *
 * @module @relaystacks/conduit-echo/app
 */

const http    = require('http');
const express = require('express');
const { Server } = require('./index');

const app        = express();
const httpServer = http.createServer(app);

app.get('/health', (_req, res) => res.json({
    status:  'ok',
    package: '@relaystacks/conduit-echo',
}));

const conduit = new Server(httpServer, {
    socketPath:   process.env.CONDUIT_SOCKET_PATH   || '/home/akvvvoci/laravel.sock',
    authEndpoint: process.env.CONDUIT_AUTH_ENDPOINT || 'http://127.0.0.1/broadcasting/auth',
    ioPath:       process.env.CONDUIT_IO_PATH       || '/testing/node-test/socket.io',
    corsOrigin:   process.env.CONDUIT_CORS_ORIGIN   || '*',
    secret:       process.env.CONDUIT_SECRET        || null,
});

conduit.start().catch((err) => {
    console.error('[app.js] Fatal startup error:', err);
    process.exit(1);
});

process.on('SIGTERM', async () => {
    console.log('[app.js] SIGTERM — shutting down gracefully.');
    await conduit.stop();
    httpServer.close(() => {
        console.log('[app.js] HTTP server closed.');
        process.exit(0);
    });
});

module.exports = httpServer;
