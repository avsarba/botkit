const assert = require('assert');
const { MemoryStorage } = require('botbuilder');
const { Botkit, BotkitConversation } = require('botkit');
const { BotkitScheduler } = require('../');
const { FakeClock, FakeAdapter, deferred, quietly } = require('./shared');

const t0 = Date.parse('2026-09-27T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const KEY = 'botkit-scheduler/jobs';

describe('BotkitScheduler persistence', function() {
    let controllers = [];

    /**
     * Create a controller with a scheduler. `botkit` options go to the Botkit constructor (for example a shared storage).
     */
    function make(options = {}, botkit = {}) {
        const adapter = new FakeAdapter();
        const scheduler = new BotkitScheduler({ clock: new FakeClock(t0), autoStart: false, ...options });
        const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true, ...botkit });
        controller.usePlugin(scheduler);
        controllers.push(controller);
        return { adapter, scheduler, controller };
    }

    afterEach(async function() {
        await Promise.all(controllers.map((controller) => controller.shutdown()));
        controllers = [];
    });

    describe('round trip', function() {
        it('should reload jobs saved by another controller, with the same next run times', async function() {
            const storage = new MemoryStorage();
            const a = make({}, { storage });
            await a.scheduler.every('hb', '1m', { event: 'hb' });
            await a.scheduler.at('once', t0 + 3600000, { event: 'once', payload: { x: 1 } });
            const saved = await a.scheduler.list();
            await a.controller.shutdown();

            const doc = (await storage.read([KEY]))[KEY];
            assert.strictEqual(doc.version, 1);
            assert.deepStrictEqual(Object.keys(doc.jobs).sort(), ['hb', 'once']);

            const b = make({ clock: new FakeClock(t0 + 10000) }, { storage });
            const loaded = await b.scheduler.list();
            assert.deepStrictEqual(loaded, saved);
            assert.strictEqual(loaded[0].nextRunAt, iso(t0 + 60000));
            assert.strictEqual(loaded[1].nextRunAt, iso(t0 + 3600000));
        });

        it('should not duplicate a job declared again at startup, and update its payload', async function() {
            const storage = new MemoryStorage();
            const a = make({}, { storage });
            await a.scheduler.every('hb', '1m', { event: 'hb', payload: { v: 1 } });
            await a.scheduler.at('once', t0 + 3600000, { event: 'once' });
            await a.controller.shutdown();

            const b = make({ clock: new FakeClock(t0 + 10000) }, { storage });
            const job = await b.scheduler.every('hb', '1m', { event: 'hb', payload: { v: 2 } });
            assert.deepStrictEqual(job.payload, { v: 2 });
            assert.strictEqual(job.nextRunAt, iso(t0 + 60000));
            assert.strictEqual(job.createdAt, iso(t0));
            const jobs = await b.scheduler.list();
            assert.deepStrictEqual(jobs.map((j) => j.id), ['hb', 'once']);
        });

        it('should save run counters and errors', async function() {
            const storage = new MemoryStorage();
            const a = make({}, { storage });
            a.controller.on('bad', async () => {
                throw new Error('boom');
            });
            await a.scheduler.every('b', '1m', { event: 'bad' });
            await quietly(async () => {
                await a.scheduler.tick(t0 + 60000);
            });
            await a.controller.shutdown();

            const b = make({ clock: new FakeClock(t0 + 70000) }, { storage });
            const job = await b.scheduler.get('b');
            assert.strictEqual(job.runs, 1);
            assert.strictEqual(job.errors, 1);
            assert.strictEqual(job.lastError, 'boom');
            assert.strictEqual(job.lastRunAt, iso(t0));
            assert.strictEqual(job.nextRunAt, iso(t0 + 120000));
        });

        it('should not keep a one-shot job whose run was cut short by a crash', async function() {
            for (const pruneCompleted of [true, false]) {
                const storage = new MemoryStorage();
                const a = make({}, { storage });
                let snapshot;
                a.controller.on('remind', async () => {
                    // the process dies here, after the advanced run time was saved and before the run was
                    snapshot = JSON.parse(JSON.stringify((await storage.read([KEY]))[KEY]));
                });
                await a.scheduler.at('r', t0 + 1000, { event: 'remind' });
                await a.scheduler.every('hb', '1h', { event: 'hb' });
                await a.scheduler.tick(t0 + 1000);
                assert.strictEqual(snapshot.jobs.r.nextRunAt, null);
                assert.strictEqual(snapshot.jobs.r.runs, 0);

                const restarted = new MemoryStorage();
                await restarted.write({ [KEY]: snapshot });
                const b = make({ pruneCompleted, clock: new FakeClock(t0 + 60000) }, { storage: restarted });
                const jobs = await b.scheduler.list();
                if (pruneCompleted) {
                    assert.deepStrictEqual(jobs.map((job) => job.id), ['hb']);
                    await b.scheduler.stop();
                    assert.deepStrictEqual(Object.keys((await restarted.read([KEY]))[KEY].jobs), ['hb']);
                } else {
                    assert.deepStrictEqual(jobs.map((job) => [job.id, job.nextRunAt]), [['hb', iso(t0 + 3600000)], ['r', null]]);
                }
            }
        });

        it('should use the storage and key given in the options', async function() {
            const storage = new MemoryStorage();
            const { scheduler } = make({ storage, storageKey: 'custom/jobs' });
            await scheduler.every('hb', '1m', { event: 'hb' });
            await scheduler.stop();
            const items = await storage.read(['custom/jobs', KEY]);
            assert.deepStrictEqual(Object.keys(items), ['custom/jobs']);
            assert.deepStrictEqual(Object.keys(items['custom/jobs'].jobs), ['hb']);
        });

        it('should route saved events past a pending dialog after a restart', async function() {
            const storage = new MemoryStorage();
            const addProfile = (controller) => {
                const profile = new BotkitConversation('profile', controller);
                profile.ask('Name?', [], 'name');
                controller.addDialog(profile);
                return profile;
            };
            const ann = { conversation: { id: 'c-ann' }, from: { id: 'ann' } };

            const a = make({}, { storage });
            addProfile(a.controller);
            a.controller.hears('start', 'message', async (bot) => {
                await bot.schedule({ id: 'water', in: '1m', event: 'reminder' });
                await bot.beginDialog('profile');
            });
            await a.adapter.turn({ text: 'start', ...ann });
            assert.deepStrictEqual(a.adapter.texts(), ['Name?']);
            await a.controller.shutdown();

            const b = make({ clock: new FakeClock(t0 + 60000) }, { storage });
            const profile = addProfile(b.controller);
            const finished = deferred();
            b.controller.afterDialog(profile, async (bot, results) => {
                finished.resolve(results);
            });
            b.controller.on('reminder', async (bot) => {
                await bot.say('Drink some water!');
            });
            assert.strictEqual(await b.scheduler.tick(), 1);
            assert.deepStrictEqual(b.adapter.texts(), ['Drink some water!']);
            assert.strictEqual(b.adapter.sent[0].conversation.id, 'c-ann');

            await b.adapter.turn({ text: 'Ann', ...ann });
            assert.strictEqual((await finished.promise).name, 'Ann');
        });
    });

    describe('catch-up', function() {
        /**
         * Save an every-minute job at t0, then load it in a new controller 5.5 minutes later.
         */
        async function restart(options, declare = (s) => s.every('hb', '1m', { event: 'hb' })) {
            const storage = new MemoryStorage();
            const a = make({ storage });
            await declare(a.scheduler);
            await a.controller.shutdown();

            const b = make({ storage, clock: new FakeClock(t0 + 330000), ...options });
            const fired = [];
            let running = 0;
            b.controller.on('hb', async (bot, message) => {
                running++;
                assert.strictEqual(running, 1, 'runs of one job do not overlap');
                await new Promise((resolve) => setImmediate(resolve));
                fired.push(message.job.scheduledAt);
                running--;
            });
            return { storage, scheduler: b.scheduler, fired };
        }

        it('should run a missed job once with catchUp "once"', async function() {
            const { scheduler, fired } = await restart({ catchUp: 'once' });
            assert.strictEqual((await scheduler.get('hb')).nextRunAt, iso(t0 + 60000));
            assert.strictEqual(await scheduler.tick(), 1);
            assert.deepStrictEqual(fired, [iso(t0 + 60000)]);
            const job = await scheduler.get('hb');
            assert.strictEqual(job.nextRunAt, iso(t0 + 360000));
            assert.strictEqual(job.runs, 1);
            assert.strictEqual(job.skipped, 4);
        });

        it('should use catchUp "once" by default', async function() {
            const { scheduler, fired } = await restart({});
            assert.strictEqual(await scheduler.tick(), 1);
            assert.deepStrictEqual(fired, [iso(t0 + 60000)]);
        });

        it('should skip missed runs with catchUp "skip"', async function() {
            const { storage, scheduler, fired } = await restart({ catchUp: 'skip' });
            const job = await scheduler.get('hb');
            assert.strictEqual(job.runs, 0);
            assert.strictEqual(job.skipped, 5);
            assert.strictEqual(job.nextRunAt, iso(t0 + 360000));
            assert.strictEqual(await scheduler.tick(), 0);
            assert.deepStrictEqual(fired, []);

            // the catch-up is saved
            await scheduler.stop();
            assert.strictEqual((await storage.read([KEY]))[KEY].jobs.hb.nextRunAt, iso(t0 + 360000));
        });

        it('should make up every missed run in order with catchUp "all"', async function() {
            const { scheduler, fired } = await restart({ catchUp: 'all' });
            assert.strictEqual(await scheduler.tick(), 5);
            assert.deepStrictEqual(fired, [1, 2, 3, 4, 5].map((m) => iso(t0 + m * 60000)));
            const job = await scheduler.get('hb');
            assert.strictEqual(job.runs, 5);
            assert.strictEqual(job.skipped, 0);
            assert.strictEqual(job.nextRunAt, iso(t0 + 360000));
            assert.strictEqual(await scheduler.tick(), 0);
        });

        it('should make up at most maxCatchUp runs with catchUp "all"', async function() {
            const { scheduler, fired } = await restart({ catchUp: 'all', maxCatchUp: 3 });
            assert.strictEqual(await scheduler.tick(), 3);
            assert.deepStrictEqual(fired, [1, 2, 3].map((m) => iso(t0 + m * 60000)));
            const job = await scheduler.get('hb');
            assert.strictEqual(job.runs, 3);
            assert.strictEqual(job.skipped, 2);
            assert.strictEqual(job.nextRunAt, iso(t0 + 360000));
        });

        it('should make up missed cron runs with catchUp "all"', async function() {
            const { scheduler, fired } = await restart({ catchUp: 'all' }, (s) => s.cron('hb', '*/2 * * * *', { event: 'hb' }));
            assert.strictEqual(await scheduler.tick(), 2);
            assert.deepStrictEqual(fired, [iso(t0 + 120000), iso(t0 + 240000)]);
            assert.strictEqual((await scheduler.get('hb')).nextRunAt, iso(t0 + 360000));
        });

        it('should count missed cron runs with catchUp "skip"', async function() {
            const { scheduler } = await restart({ catchUp: 'skip' }, (s) => s.cron('hb', '*/2 * * * *', { event: 'hb' }));
            const job = await scheduler.get('hb');
            assert.strictEqual(job.skipped, 2);
            assert.strictEqual(job.nextRunAt, iso(t0 + 360000));
        });

        it('should stop making up runs when maxRuns is reached', async function() {
            const { scheduler, fired } = await restart({ catchUp: 'all' }, (s) => s.every('hb', '1m', { event: 'hb', maxRuns: 2 }));
            assert.strictEqual(await scheduler.tick(), 2);
            assert.strictEqual(fired.length, 2);
            assert.strictEqual(await scheduler.get('hb'), undefined);
        });

        it('should delete an overdue one-shot job with catchUp "skip"', async function() {
            const { scheduler, fired } = await restart({ catchUp: 'skip' }, (s) => s.at('late', t0 + 1000, { event: 'hb' }));
            assert.deepStrictEqual(await scheduler.list(), []);
            assert.strictEqual(await scheduler.tick(), 0);
            assert.deepStrictEqual(fired, []);
        });

        it('should keep a skipped one-shot job when pruneCompleted is false', async function() {
            const { scheduler } = await restart({ catchUp: 'skip', pruneCompleted: false }, (s) => s.at('late', t0 + 1000, { event: 'hb' }));
            const job = await scheduler.get('late');
            assert.strictEqual(job.nextRunAt, null);
            assert.strictEqual(job.skipped, 1);
            assert.strictEqual(job.runs, 0);
        });

        it('should run an overdue one-shot job once with catchUp "once" and "all"', async function() {
            for (const catchUp of ['once', 'all']) {
                const { scheduler, fired } = await restart({ catchUp }, (s) => s.at('late', t0 + 1000, { event: 'hb' }));
                assert.strictEqual(await scheduler.tick(), 1, catchUp);
                assert.deepStrictEqual(fired, [iso(t0 + 1000)], catchUp);
                assert.deepStrictEqual(await scheduler.list(), [], catchUp);
            }
        });

        it('should leave paused jobs alone', async function() {
            const { scheduler } = await restart({ catchUp: 'skip' }, async (s) => {
                await s.every('hb', '1m', { event: 'hb' });
                await s.pause('hb');
            });
            const job = await scheduler.get('hb');
            assert.strictEqual(job.paused, true);
            assert.strictEqual(job.skipped, 0);
            assert.strictEqual(job.nextRunAt, iso(t0 + 60000));
            assert.strictEqual(await scheduler.tick(), 0);
        });
    });

    describe('loading', function() {
        it('should wait for a slow storage before answering', async function() {
            const memory = {};
            const seed = make({ storage: new MemoryStorage(memory) });
            await seed.scheduler.every('hb', '1m', { event: 'hb' });
            await seed.controller.shutdown();

            class SlowStorage extends MemoryStorage {
                constructor(mem) {
                    super(mem);
                    this.gate = deferred();
                }

                async read(keys) {
                    await this.gate.promise;
                    return super.read(keys);
                }
            }
            const storage = new SlowStorage(memory);
            const { scheduler } = make({ storage });
            const listed = scheduler.list();
            let settled = false;
            listed.then(() => { settled = true; });
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(settled, false);

            storage.gate.resolve();
            assert.deepStrictEqual((await listed).map((job) => job.id), ['hb']);
        });

        it('should fail every call, and never write, when storage cannot be read', async function() {
            class BrokenStorage extends MemoryStorage {
                constructor() {
                    super();
                    this.writes = 0;
                }

                async read() {
                    throw new Error('storage offline');
                }

                async write(changes) {
                    this.writes++;
                    return super.write(changes);
                }
            }
            const storage = new BrokenStorage();
            const clock = new FakeClock(t0);
            let scheduler;
            const logged = await quietly(async () => {
                ({ scheduler } = make({ storage, clock, autoStart: true }));
                await assert.rejects(scheduler.loaded, /storage offline/);
                await assert.rejects(scheduler.list(), /storage offline/);
                await assert.rejects(scheduler.every('x', '1m', { event: 'x' }), /storage offline/);
                await assert.rejects(scheduler.tick(), /storage offline/);
                await new Promise((resolve) => setImmediate(resolve));
            });
            assert.ok(logged.some((args) => /could not load scheduled jobs/.test(args[0])));
            assert.strictEqual(clock.timers.length, 0);
            assert.strictEqual(storage.writes, 0);
            await scheduler.stop();
        });

        it('should log a catch-up that cannot be saved, and keep it in memory', async function() {
            class FlakyStorage extends MemoryStorage {
                async write(changes) {
                    if (this.fail) {
                        throw new Error('disk full');
                    }
                    return super.write(changes);
                }
            }
            const storage = new FlakyStorage();
            const seed = make({ storage });
            await seed.scheduler.every('hb', '1m', { event: 'hb' });
            await seed.controller.shutdown();

            storage.fail = true;
            let job;
            const logged = await quietly(async () => {
                const { scheduler } = make({ storage, catchUp: 'skip', clock: new FakeClock(t0 + 330000) });
                job = await scheduler.get('hb');
                await scheduler.stop();
            });
            assert.strictEqual(job.nextRunAt, iso(t0 + 360000));
            assert.ok(logged.some((args) => /could not save scheduled jobs/.test(args[0])));
        });

        it('should refuse to overwrite a document it does not understand', async function() {
            const storage = new MemoryStorage();
            await storage.write({ [KEY]: { version: 2, jobs: {} } });
            const { scheduler, controller } = make({ storage });
            await quietly(async () => {
                await assert.rejects(scheduler.list(), /does not hold a version 1 scheduler document/);
            });
            await controller.shutdown();
            assert.strictEqual((await storage.read([KEY]))[KEY].version, 2);
        });

        it('should skip invalid saved jobs', async function() {
            const storage = new MemoryStorage();
            const seed = make({ storage });
            await seed.scheduler.every('good', '1m', { event: 'hb' });
            await seed.scheduler.cron('tz', '0 9 * * *', { event: 'hb', timezone: 'Europe/Paris' });
            await seed.controller.shutdown();

            const doc = (await storage.read([KEY]))[KEY];
            doc.jobs.reserved = { ...doc.jobs.good, id: 'reserved', event: 'message' };
            doc.jobs.renamed = { ...doc.jobs.good, id: 'something-else' };
            doc.jobs.empty = null;
            doc.jobs.kindless = { ...doc.jobs.good, id: 'kindless', kind: 'sometimes' };
            doc.jobs.badcron = { ...doc.jobs.tz, id: 'badcron', cron: '61 * * * *' };
            doc.jobs.badzone = { ...doc.jobs.tz, id: 'badzone', timezone: 'Mars/Olympus' };
            doc.jobs.baddate = { ...doc.jobs.good, id: 'baddate', nextRunAt: 'soon' };
            doc.jobs.badruns = { ...doc.jobs.good, id: 'badruns', runs: -1 };
            doc.jobs.badref = { ...doc.jobs.good, id: 'badref', reference: { channelId: 'x' } };
            await storage.write({ [KEY]: doc });

            let jobs;
            const logged = await quietly(async () => {
                jobs = await make({ storage }).scheduler.list();
            });
            assert.deepStrictEqual(jobs.map((job) => job.id).sort(), ['good', 'tz']);
            assert.strictEqual(jobs.find((job) => job.id === 'tz').timezone, 'Europe/Paris');
            assert.strictEqual(logged.length, 9);
            assert.ok(logged.every((args) => /skipping invalid job/.test(args[0])));
        });
    });

    describe('writes', function() {
        class SpyStorage extends MemoryStorage {
            constructor() {
                super();
                this.writes = 0;
                this.active = 0;
                this.maxActive = 0;
                this.hold = null;
                this.entered = deferred();
            }

            async write(changes) {
                this.writes++;
                this.active++;
                this.maxActive = Math.max(this.maxActive, this.active);
                this.entered.resolve();
                await (this.hold ? this.hold.promise : new Promise((resolve) => setImmediate(resolve)));
                await super.write(changes);
                this.active--;
            }
        }

        it('should never run two writes at once, and include every change', async function() {
            const storage = new SpyStorage();
            const { scheduler } = make({ storage });
            await Promise.all([1, 2, 3, 4, 5, 6].map((n) => scheduler.every(`job${ n }`, `${ n }m`, { event: 'e' })));
            assert.strictEqual(storage.maxActive, 1);
            assert.ok(storage.writes <= 6, `${ storage.writes } writes`);
            const doc = (await storage.read([KEY]))[KEY];
            assert.strictEqual(Object.keys(doc.jobs).length, 6);
        });

        it('should wait for pending writes on stop()', async function() {
            const storage = new SpyStorage();
            const { scheduler } = make({ storage });
            await scheduler.loaded;
            storage.hold = deferred();
            const pending = scheduler.every('late', '1m', { event: 'e' });
            await storage.entered.promise;

            let stopped = false;
            const stopping = scheduler.stop().then(() => { stopped = true; });
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(stopped, false);

            storage.hold.resolve();
            await stopping;
            assert.strictEqual(storage.active, 0);
            assert.ok((await storage.read([KEY]))[KEY].jobs.late);
            await pending;
        });

        it('should save the advanced run time before the job runs', async function() {
            const storage = new MemoryStorage();
            const { scheduler, controller } = make({ storage });
            let saved;
            controller.on('e', async () => {
                saved = (await storage.read([KEY]))[KEY].jobs.hb.nextRunAt;
            });
            await scheduler.every('hb', '1m', { event: 'e' });
            await scheduler.tick(t0 + 60000);
            assert.strictEqual(saved, iso(t0 + 120000));
        });
    });
});
