'use strict';

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const {
    registerLifecycleHandlers,
    shutdownPool,
    waitForDrain,
} = require('../src/db/lifecycle');

function makeFakePrisma() {
    const calls = [];
    return {
        calls,
        $disconnect: async () => { calls.push('disconnect'); },
    };
}

function makeFakeProcess() {
    const ee = new EventEmitter();
    ee.exit = (code) => { ee.exitCode = code; ee.exited = true; };
    return ee;
}

function tick(ms = 0) {
    return new Promise((r) => setTimeout(r, ms));
}

describe('lifecycle.waitForDrain', () => {
    it('resolves true immediately when in-flight is 0', async () => {
        const ok = await waitForDrain({
            getInFlight: () => 0,
            gracePeriodMs: 1000,
            pollMs: 5,
        });
        assert.equal(ok, true);
    });

    it('returns false when grace expires with non-zero in-flight', async () => {
        const ok = await waitForDrain({
            getInFlight: () => 3,
            gracePeriodMs: 60,
            pollMs: 10,
        });
        assert.equal(ok, false);
    });

    it('drains when getInFlight ramps down', async () => {
        let n = 4;
        const id = setInterval(() => { n -= 1; }, 10);
        try {
            const ok = await waitForDrain({
                getInFlight: () => Math.max(0, n),
                gracePeriodMs: 500,
                pollMs: 5,
            });
            assert.equal(ok, true);
        } finally {
            clearInterval(id);
        }
    });

    it('tolerates a throwing getInFlight (treats as 0)', async () => {
        const ok = await waitForDrain({
            getInFlight: () => { throw new Error('bad'); },
            gracePeriodMs: 200,
            pollMs: 10,
        });
        assert.equal(ok, true);
    });
});

describe('lifecycle.shutdownPool', () => {
    it('disconnects when prisma is provided', async () => {
        const prisma = makeFakePrisma();
        const states = [];
        const result = await shutdownPool({
            prisma,
            getInFlight: () => 0,
            gracePeriodMs: 100,
            pollMs: 5,
            onState: (s) => states.push(s),
        });
        assert.equal(result.disconnected, true);
        assert.equal(result.drained, true);
        assert.equal(result.reason, 'clean');
        assert.deepEqual(prisma.calls, ['disconnect']);
        assert.ok(states.includes('draining'));
        assert.ok(states.includes('disconnecting'));
        assert.ok(states.includes('done'));
    });

    it('returns no_client when prisma missing', async () => {
        const result = await shutdownPool({});
        assert.equal(result.disconnected, false);
        assert.equal(result.reason, 'no_client');
    });

    it('forces disconnect when grace exceeded', async () => {
        const prisma = makeFakePrisma();
        const result = await shutdownPool({
            prisma,
            getInFlight: () => 5,
            gracePeriodMs: 30,
            pollMs: 5,
        });
        assert.equal(result.drained, false);
        assert.equal(result.disconnected, true);
        assert.equal(result.reason, 'forced');
    });

    it('captures disconnect_error', async () => {
        const prisma = {
            $disconnect: async () => { throw new Error('connreset'); },
        };
        const states = [];
        const result = await shutdownPool({
            prisma,
            getInFlight: () => 0,
            gracePeriodMs: 50,
            pollMs: 5,
            onState: (s) => states.push(s),
        });
        assert.equal(result.disconnected, false);
        assert.equal(result.reason, 'disconnect_error');
        assert.ok(states.includes('error'));
    });
});

describe('lifecycle.registerLifecycleHandlers', () => {
    it('registers handlers for default signals', () => {
        const proc = makeFakeProcess();
        const lc = registerLifecycleHandlers({
            prisma: makeFakePrisma(),
            process: proc,
            exitProcess: false,
        });
        assert.deepEqual(lc.signals, ['SIGTERM', 'SIGINT']);
        assert.equal(proc.listenerCount('SIGTERM'), 1);
        assert.equal(proc.listenerCount('SIGINT'), 1);
        lc.unregister();
        assert.equal(proc.listenerCount('SIGTERM'), 0);
    });

    it('triggers shutdown on signal and calls exit', async () => {
        const proc = makeFakeProcess();
        const prisma = makeFakePrisma();
        let exitCode = null;
        const lc = registerLifecycleHandlers({
            prisma,
            process: proc,
            getInFlight: () => 0,
            gracePeriodMs: 50,
            pollMs: 5,
            exit: (code) => { exitCode = code; },
        });

        await lc.triggerShutdown('SIGTERM');
        assert.equal(exitCode, 0);
        assert.deepEqual(prisma.calls, ['disconnect']);
        assert.equal(lc.isShuttingDown, true);
    });

    it('ignores duplicate signals', async () => {
        const proc = makeFakeProcess();
        const prisma = makeFakePrisma();
        const exits = [];
        const lc = registerLifecycleHandlers({
            prisma,
            process: proc,
            getInFlight: () => 0,
            gracePeriodMs: 50,
            pollMs: 5,
            exit: (code) => exits.push(code),
        });
        await lc.triggerShutdown('SIGTERM');
        await lc.triggerShutdown('SIGINT');
        assert.equal(exits.length, 1, 'only first signal causes exit');
        assert.deepEqual(prisma.calls, ['disconnect']);
    });

    it('exit code 1 when disconnect fails', async () => {
        const proc = makeFakeProcess();
        const prisma = { $disconnect: async () => { throw new Error('x'); } };
        let exitCode = null;
        const lc = registerLifecycleHandlers({
            prisma,
            process: proc,
            getInFlight: () => 0,
            gracePeriodMs: 30,
            pollMs: 5,
            exit: (code) => { exitCode = code; },
        });
        await lc.triggerShutdown('SIGTERM');
        assert.equal(exitCode, 1);
    });

    it('emits via process.on when SIGTERM fires', async () => {
        const proc = makeFakeProcess();
        const prisma = makeFakePrisma();
        let exited = false;
        const lc = registerLifecycleHandlers({
            prisma,
            process: proc,
            getInFlight: () => 0,
            gracePeriodMs: 30,
            pollMs: 5,
            exit: () => { exited = true; },
        });

        proc.emit('SIGTERM');
        // give the async handler time to complete
        await tick(60);
        assert.equal(exited, true);
        assert.deepEqual(prisma.calls, ['disconnect']);
        lc.unregister();
    });

    it('respects exitProcess=false', async () => {
        const proc = makeFakeProcess();
        const prisma = makeFakePrisma();
        let exited = false;
        const lc = registerLifecycleHandlers({
            prisma,
            process: proc,
            getInFlight: () => 0,
            gracePeriodMs: 30,
            pollMs: 5,
            exitProcess: false,
            exit: () => { exited = true; },
        });
        await lc.triggerShutdown('SIGTERM');
        assert.equal(exited, false);
        assert.deepEqual(prisma.calls, ['disconnect']);
    });

    it('honors custom signals list', () => {
        const proc = makeFakeProcess();
        const lc = registerLifecycleHandlers({
            prisma: makeFakePrisma(),
            process: proc,
            signals: ['SIGUSR2'],
            exitProcess: false,
        });
        assert.deepEqual(lc.signals, ['SIGUSR2']);
        assert.equal(proc.listenerCount('SIGUSR2'), 1);
        assert.equal(proc.listenerCount('SIGTERM'), 0);
        lc.unregister();
    });
});
