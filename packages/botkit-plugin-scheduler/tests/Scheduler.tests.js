const assert = require('assert');
const { MemoryStorage, TurnContext } = require('botbuilder');
const { Botkit, BotkitConversation } = require('botkit');
const { BotkitScheduler, ClockAdapter } = require('../');
const { FakeClock, FakeAdapter, RejectingAdapter, deferred, quietly } = require('./shared');

const t0 = Date.parse('2026-09-27T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const reference = (conversation, user, channelId = 'fake') => ({ channelId, conversation: { id: conversation }, user: { id: user }, bot: { id: 'bot' } });

describe('BotkitScheduler', function() {
    let clock;
    let adapter;
    let controller;
    let scheduler;

    function setup(options = {}, primary = new FakeAdapter()) {
        clock = new FakeClock(t0);
        adapter = primary;
        scheduler = new BotkitScheduler({ clock, autoStart: false, ...options });
        controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
        controller.usePlugin(scheduler);
    }

    async function reset(options, primary) {
        await controller.shutdown();
        setup(options, primary);
    }

    beforeEach(function() {
        setup();
    });

    afterEach(async function() {
        await controller.shutdown();
    });

    describe('registration', function() {
        it('should register as controller.plugins.scheduler and load', async function() {
            assert.strictEqual(controller.plugins.scheduler, scheduler);
            await scheduler.loaded;
            assert.deepStrictEqual(await scheduler.list(), []);
            assert.ok(scheduler.clockAdapter instanceof ClockAdapter);
        });

        it('should reject calls made before usePlugin', async function() {
            const orphan = new BotkitScheduler({ clock });
            await assert.rejects(orphan.list(), /BotkitScheduler is not registered: call controller.usePlugin\(scheduler\) first/);
            await assert.rejects(orphan.every('x', '1m', { event: 'x' }), /not registered/);
            await assert.rejects(orphan.tick(), /not registered/);
            assert.throws(() => orphan.start(), /not registered/);
            await orphan.stop();
        });

        it('should reject invalid options', function() {
            assert.throws(() => new BotkitScheduler({ catchUp: 'sometimes' }), /catchUp/);
            assert.throws(() => new BotkitScheduler({ maxCatchUp: 0 }), /maxCatchUp/);
            assert.throws(() => new BotkitScheduler({ turnTimeout: -1 }), /turnTimeout/);
            assert.throws(() => new BotkitScheduler({ turnTimeout: 2147483648 }), /turnTimeout/);
            assert.throws(() => new BotkitScheduler({ timezone: 'Nope/Nope' }), /Invalid timezone/);
        });

        it('should refuse to join a second controller', async function() {
            const other = new Botkit({ adapter: new FakeAdapter(), disable_webserver: true, disable_console: true });
            const logged = await quietly(async () => {
                other.usePlugin(scheduler);
            });
            assert.ok(logged.some((args) => /already registered with another controller/.test(String(args[1]))));
            assert.strictEqual(other.plugins.scheduler, undefined);
            const bot = await other.spawn({});
            assert.strictEqual(bot.schedule, undefined);
            await other.shutdown();
        });

        it('should expose its resolved configuration', function() {
            assert.strictEqual(scheduler.getConfig('timezone'), 'UTC');
            assert.strictEqual(scheduler.getConfig('catchUp'), 'once');
            assert.strictEqual(scheduler.getConfig('storageKey'), 'botkit-scheduler/jobs');
            assert.strictEqual(scheduler.getConfig().turnTimeout, 30000);
        });
    });

    describe('clock jobs', function() {
        it('should fire an interval job as a Botkit event on the clock channel', async function() {
            const seen = [];
            controller.on('heartbeat', async (bot, message) => {
                seen.push({
                    value: message.value,
                    job: message.job,
                    user: message.user,
                    channel: message.channel,
                    botkitScheduler: message.botkitScheduler,
                    type: message.type,
                    turnJob: message.context.turnState.get('botkit-scheduler.job')
                });
            });

            const job = await scheduler.every('hb', '1m', { event: 'heartbeat', payload: { a: 1 } });
            assert.strictEqual(job.nextRunAt, '2026-09-27T12:01:00.000Z');
            assert.strictEqual(job.kind, 'every');
            assert.strictEqual(job.every, 60000);
            assert.strictEqual(job.reference, null);

            assert.strictEqual(await scheduler.tick(t0 + 59999), 0);
            assert.strictEqual(seen.length, 0);

            assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            assert.strictEqual(seen.length, 1);
            assert.deepStrictEqual(seen[0].value, { a: 1 });
            assert.strictEqual(seen[0].job.id, 'hb');
            assert.strictEqual(seen[0].job.runs, 1);
            assert.strictEqual(seen[0].job.kind, 'every');
            assert.strictEqual(seen[0].job.event, 'heartbeat');
            assert.strictEqual(seen[0].job.scheduledAt, '2026-09-27T12:01:00.000Z');
            assert.strictEqual(seen[0].job.firedAt, iso(t0));
            assert.strictEqual(seen[0].user, 'scheduler');
            assert.strictEqual(seen[0].channel, 'scheduler:hb');
            assert.strictEqual(seen[0].botkitScheduler, true);
            assert.strictEqual(seen[0].type, 'heartbeat');
            assert.strictEqual(seen[0].turnJob.id, 'hb');
            assert.strictEqual(seen[0].turnJob.runs, 1);

            const after = await scheduler.get('hb');
            assert.strictEqual(after.nextRunAt, '2026-09-27T12:02:00.000Z');
            assert.strictEqual(after.runs, 1);
            assert.strictEqual(after.lastRunAt, iso(t0));
            assert.strictEqual(after.errors, 0);
        });

        it('should send clock-channel messages to the output option', async function() {
            const out = [];
            await reset({ output: (activity, job) => { out.push([activity.text, job.id]); } });
            controller.on('heartbeat', async (bot) => {
                await bot.say('beat');
            });
            await scheduler.every('hb', '1m', { event: 'heartbeat' });
            await scheduler.tick(t0 + 60000);
            assert.deepStrictEqual(out, [['beat', 'hb']]);
            assert.strictEqual(adapter.sent.length, 0);
        });

        it('should wait for an async output function and fail the run if it throws', async function() {
            const out = [];
            await reset({
                pruneCompleted: false,
                output: async (activity) => {
                    await new Promise((resolve) => setImmediate(resolve));
                    if (activity.text === 'bad') {
                        throw new Error('printer on fire');
                    }
                    out.push(activity.text);
                }
            });
            controller.on('print', async (bot, message) => {
                await bot.say(message.value);
            });
            await scheduler.at('good', t0, { event: 'print', payload: 'good' });
            await scheduler.at('bad', t0, { event: 'print', payload: 'bad' });
            await quietly(async () => {
                assert.strictEqual(await scheduler.tick(t0), 2);
            });
            assert.deepStrictEqual(out, ['good']);
            assert.strictEqual((await scheduler.get('bad')).lastError, 'printer on fire');
            assert.strictEqual((await scheduler.get('good')).errors, 0);
        });

        it('should run clock-channel turns through the clock adapter middleware', async function() {
            const seen = [];
            scheduler.clockAdapter.use(async (context, next) => {
                seen.push(`${ context.activity.channelId }/${ context.activity.name }/${ context.activity.id }`);
                await next();
            });
            await scheduler.every('hb', '1m', { event: 'heartbeat' });
            await scheduler.tick(t0 + 60000);
            assert.deepStrictEqual(seen, ['scheduler/heartbeat/hb#1']);
        });

        it('should hand messages sent on a scheduler conversation from outside a run to the output option', async function() {
            const out = [];
            await reset({ output: (activity, job) => { out.push([activity.text, job ? job.id : null]); } });
            await scheduler.every('hb', '1m', { event: 'heartbeat' });

            const bot = await controller.spawn({}, scheduler.clockAdapter);
            await bot.changeContext({ channelId: 'scheduler', conversation: { id: 'scheduler:hb' }, user: { id: 'scheduler' }, bot: { id: 'bot' } });
            await bot.say('manual');
            await bot.changeContext({ channelId: 'scheduler', conversation: { id: 'scheduler:gone' }, user: { id: 'scheduler' }, bot: { id: 'bot' } });
            await bot.say('orphan');
            assert.deepStrictEqual(out, [['manual', 'hb'], ['orphan', null]]);
        });

        it('should fire a one-shot job exactly once and then prune it', async function() {
            let count = 0;
            controller.on('once', async () => { count++; });
            const job = await scheduler.at('one', t0 + 5000, { event: 'once' });
            assert.strictEqual(job.kind, 'at');
            assert.strictEqual(job.at, iso(t0 + 5000));

            assert.strictEqual(await scheduler.tick(t0 + 5000), 1);
            assert.strictEqual(await scheduler.tick(t0 + 10000), 0);
            assert.strictEqual(count, 1);
            assert.deepStrictEqual(await scheduler.list(), []);
        });

        it('should keep a finished one-shot job when pruneCompleted is false', async function() {
            await reset({ pruneCompleted: false });
            controller.on('once', async () => {});
            await scheduler.at('one', t0 + 5000, { event: 'once' });
            await scheduler.tick(t0 + 5000);
            const job = await scheduler.get('one');
            assert.strictEqual(job.nextRunAt, null);
            assert.strictEqual(job.runs, 1);
            assert.strictEqual(await scheduler.tick(t0 + 50000), 0);
        });

        it('should create an "in" job with a generated id', async function() {
            const job = await scheduler.schedule({ in: '5m', event: 'x' });
            assert.ok(/^job-[0-9a-f]{8}$/.test(job.id), job.id);
            assert.strictEqual(job.kind, 'at');
            assert.strictEqual(job.nextRunAt, iso(t0 + 300000));
            assert.strictEqual(job.createdAt, iso(t0));
            assert.strictEqual(job.payload, null);
            assert.strictEqual(job.overlap, 'skip');
            assert.strictEqual(job.maxRuns, null);
        });

        it('should make bot.schedule() inside a clock job create another clock job', async function() {
            controller.on('parent', async (bot) => {
                await bot.schedule({ id: 'child', in: '1m', event: 'child' });
            });
            await scheduler.at('parent', t0, { event: 'parent' });
            await scheduler.tick(t0);
            const child = await scheduler.get('child');
            assert.strictEqual(child.reference, null);
            assert.strictEqual(child.nextRunAt, iso(t0 + 60000));
        });

        it('should make a clock job from a reference on the scheduler channel', async function() {
            const out = [];
            await reset({ output: (activity, job) => { out.push([activity.text, job.id]); } });
            controller.on('parent', async (bot, message) => {
                await controller.plugins.scheduler.schedule({ id: 'child', in: '1m', event: 'child', reference: message.reference });
            });
            controller.on('child', async (bot) => {
                await bot.say('child ran');
            });
            await scheduler.at('parent', t0, { event: 'parent' });
            await scheduler.tick(t0);
            assert.strictEqual((await scheduler.get('child')).reference, null);
            await scheduler.tick(t0 + 60000);
            assert.deepStrictEqual(out, [['child ran', 'child']]);
        });

        it('should keep a job that cancels itself during its run cancelled', async function() {
            controller.on('self', async (bot) => {
                await bot.cancelSchedule('me');
            });
            await scheduler.every('me', '1m', { event: 'self' });
            assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            assert.strictEqual(await scheduler.get('me'), undefined);
            await scheduler.stop();
            const doc = (await controller.storage.read(['botkit-scheduler/jobs']))['botkit-scheduler/jobs'];
            assert.deepStrictEqual(doc.jobs, {});
        });

        it('should give each run its own copy of the payload', async function() {
            const values = [];
            controller.on('count', async (bot, message) => {
                message.value.n++;
                values.push(message.value.n);
            });
            await scheduler.every('c', '1m', { event: 'count', payload: { n: 0 } });
            await scheduler.tick(t0 + 60000);
            await scheduler.tick(t0 + 120000);
            assert.deepStrictEqual(values, [1, 1]);
            assert.deepStrictEqual((await scheduler.get('c')).payload, { n: 0 });
        });
    });

    describe('conversation jobs', function() {
        it('should run a job scheduled with bot.schedule() in the conversation that scheduled it', async function() {
            controller.hears('remind', 'message', async (bot) => {
                await bot.schedule({ in: 1000, event: 'reminder', payload: { what: 'stretch' } });
            });
            controller.on('reminder', async (bot, message) => {
                await bot.say(`Reminder: ${ message.value.what }`);
            });

            await adapter.turn({ text: 'remind', conversation: { id: 'c7' }, from: { id: 'ann' } });
            const jobs = await scheduler.list({ conversation: 'c7' });
            assert.strictEqual(jobs.length, 1);
            assert.deepStrictEqual(jobs[0].reference, reference('c7', 'ann'));

            assert.strictEqual(await scheduler.tick(t0 + 1000), 1);
            const sent = adapter.sent.find((activity) => activity.text === 'Reminder: stretch');
            assert.ok(sent, 'the reminder was sent');
            assert.strictEqual(sent.conversation.id, 'c7');
            assert.strictEqual(sent.recipient.id, 'ann');
            assert.strictEqual(adapter.continued, 1);
            assert.strictEqual((await scheduler.list({ conversation: 'c7' })).length, 0);
        });

        it('should fire while a dialog question is pending, and leave the question to the user', async function() {
            const profile = new BotkitConversation('profile', controller);
            profile.ask('Name?', [], 'name');
            controller.addDialog(profile);
            const finished = deferred();
            controller.afterDialog(profile, async (bot, results) => {
                finished.resolve(results);
            });
            controller.hears('start', 'message', async (bot) => {
                await bot.schedule({ id: 'water', in: 1000, event: 'reminder', payload: { what: 'drink water' } });
                await bot.beginDialog('profile');
            });
            controller.on('reminder', async (bot, message) => {
                await bot.say(`Reminder: ${ message.value.what }`);
            });
            const ann = { conversation: { id: 'c-ann' }, from: { id: 'ann' } };

            await adapter.turn({ text: 'start', ...ann });
            assert.deepStrictEqual(adapter.texts(), ['Name?']);

            assert.strictEqual(await scheduler.tick(t0 + 1000), 1);
            assert.deepStrictEqual(adapter.texts(), ['Name?', 'Reminder: drink water']);
            assert.strictEqual(adapter.sent[1].conversation.id, 'c-ann');

            if (typeof controller.getPendingQuestion === 'function') {
                const context = new TurnContext(adapter, { type: 'message', channelId: 'fake', recipient: { id: 'bot' }, ...ann });
                const pending = await controller.getPendingQuestion(context);
                assert.strictEqual(pending.dialog, 'profile');
                assert.strictEqual(pending.key, 'name');
            }

            await adapter.turn({ text: 'Ann', ...ann });
            const results = await finished.promise;
            assert.strictEqual(results.name, 'Ann');
        });

        it('should fall back to a direct context when continueConversation fails', async function() {
            await reset({}, new RejectingAdapter());
            const heard = [];
            controller.on('reminder', async (bot, message) => {
                heard.push(`${ message.user }@${ message.channel }`);
                await bot.say('Reminder!');
            });
            await scheduler.schedule({ in: 1000, event: 'reminder', reference: reference('c9', 'bo') });
            assert.strictEqual(await scheduler.tick(t0 + 1000), 1);
            assert.strictEqual(adapter.continued, 1);
            assert.deepStrictEqual(heard, ['bo@c9']);
            assert.strictEqual(adapter.sent.length, 1);
            assert.strictEqual(adapter.sent[0].text, 'Reminder!');
            assert.strictEqual(adapter.sent[0].conversation.id, 'c9');
            assert.strictEqual(adapter.sent[0].recipient.id, 'bo');
        });

        it('should use the adapter given for a channel in options.adapters', async function() {
            const other = new FakeAdapter('other');
            await reset({ adapters: { other } });
            controller.on('reminder', async (bot) => {
                await bot.say('ping');
            });
            await scheduler.schedule({ in: 1000, event: 'reminder', reference: reference('o1', 'u', 'other') });
            await scheduler.tick(t0 + 1000);
            assert.strictEqual(other.continued, 1);
            assert.deepStrictEqual(other.texts(), ['ping']);
            assert.strictEqual(adapter.sent.length, 0);
        });

        it('should use an adapter registered with useAdapter()', async function() {
            const third = new FakeAdapter('third');
            scheduler.useAdapter('third', third);
            controller.on('reminder', async (bot) => {
                await bot.say('ping');
            });
            await scheduler.schedule({ in: 1000, event: 'reminder', reference: reference('t1', 'u', 'third') });
            await scheduler.tick(t0 + 1000);
            assert.deepStrictEqual(third.texts(), ['ping']);
            assert.strictEqual(adapter.sent.length, 0);
        });

        it('should learn which adapter serves a channel from the bots it spawns', async function() {
            const second = new FakeAdapter('second');
            second.controller = controller;
            controller.hears('remind', 'message', async (bot) => {
                await bot.schedule({ in: 1000, event: 'reminder' });
            });
            controller.on('reminder', async (bot) => {
                await bot.say('from the second adapter');
            });
            await second.turn({ text: 'remind', conversation: { id: 's1' }, from: { id: 'sam' } });
            await scheduler.tick(t0 + 1000);
            assert.deepStrictEqual(second.texts(), ['from the second adapter']);
            assert.strictEqual(adapter.sent.length, 0);
        });

        it('should run the adapter middleware for conversation jobs', async function() {
            const seen = [];
            adapter.use(async (context, next) => {
                seen.push(context.activity.conversation.id);
                await next();
            });
            controller.on('reminder', async () => {});
            await scheduler.schedule({ in: 1000, event: 'reminder', reference: reference('m1', 'u') });
            await scheduler.tick(t0 + 1000);
            assert.deepStrictEqual(seen, ['m1']);
        });

        it('should let a handler cancel a job with bot.cancelSchedule()', async function() {
            const results = [];
            controller.hears('stop', 'message', async (bot) => {
                results.push(await bot.cancelSchedule('water'));
                results.push(await bot.cancelSchedule('water'));
            });
            await scheduler.every('water', '1h', { event: 'reminder' });
            await adapter.turn({ text: 'stop' });
            assert.deepStrictEqual(results, [true, false]);
            assert.strictEqual(await scheduler.get('water'), undefined);
        });

        it('should create a clock job when bot.schedule() is given reference: null', async function() {
            controller.hears('later', 'message', async (bot) => {
                await bot.schedule({ id: 'unbound', in: '1h', event: 'cleanup', reference: null });
            });
            await adapter.turn({ text: 'later' });
            assert.strictEqual((await scheduler.get('unbound')).reference, null);
        });

        it('should not fall back when the adapter ran the turn and it failed', async function() {
            let runs = 0;
            controller.middleware.receive.use((bot, message, next) => {
                next(message.botkitScheduler ? new Error('middleware failed') : undefined);
            });
            controller.on('reminder', async () => { runs++; });
            await scheduler.schedule({ id: 'r', in: 1000, event: 'reminder', reference: reference('c1', 'u1') });
            assert.strictEqual(await scheduler.tick(t0 + 1000), 1);
            assert.strictEqual(adapter.continued, 1);
            assert.strictEqual(runs, 0);
        });

        it('should not treat a botkitScheduler flag sent by a user as a scheduled run', async function() {
            const errors = [];
            controller.on('reminder', async () => {
                throw new Error('boom');
            });
            controller.on('scheduler_error', async (bot, message) => {
                errors.push(message);
            });
            await scheduler.every('r', '1m', { event: 'reminder' });
            await quietly(async () => {
                await assert.rejects(adapter.turn({ type: 'event', channelData: { botkitEventType: 'reminder', botkitScheduler: true, job: { id: 'r' } } }), /boom/);
            });
            assert.strictEqual(errors.length, 0);
            assert.strictEqual((await scheduler.get('r')).errors, 0);
        });
    });

    describe('errors', function() {
        it('should record a throwing handler, emit scheduler_error and keep the job running', async function() {
            const errors = [];
            controller.on('bad', async () => {
                throw new Error('boom');
            });
            controller.on('scheduler_error', async (bot, message) => {
                errors.push({ type: message.type, error: message.error, job: message.job });
            });
            await scheduler.every('b', '1m', { event: 'bad' });

            await quietly(async () => {
                assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            });
            let job = await scheduler.get('b');
            assert.strictEqual(job.errors, 1);
            assert.strictEqual(job.lastError, 'boom');
            assert.strictEqual(errors.length, 1);
            assert.strictEqual(errors[0].type, 'scheduler_error');
            assert.strictEqual(errors[0].error.message, 'boom');
            assert.strictEqual(errors[0].job.id, 'b');

            await quietly(async () => {
                assert.strictEqual(await scheduler.tick(t0 + 120000), 1);
            });
            job = await scheduler.get('b');
            assert.strictEqual(job.runs, 2);
            assert.strictEqual(job.errors, 2);
            assert.strictEqual(errors.length, 2);
        });

        it('should survive a scheduler_error handler that throws', async function() {
            controller.on('bad', async () => {
                throw new Error('boom');
            });
            controller.on('scheduler_error', async () => {
                throw new Error('worse');
            });
            await scheduler.every('b', '1m', { event: 'bad' });
            const logged = await quietly(async () => {
                assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            });
            assert.strictEqual((await scheduler.get('b')).lastError, 'boom');
            assert.ok(logged.some((args) => /scheduler_error handler/.test(args[0])));
        });

        it('should time out a turn that never ends', async function() {
            await reset({ turnTimeout: 30 });
            controller.on('hang', () => new Promise(() => {}));
            await scheduler.every('h', '1m', { event: 'hang' });
            const started = Date.now();
            assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            assert.ok(Date.now() - started < 500);
            const job = await scheduler.get('h');
            assert.ok(/Timed out after 30ms/.test(job.lastError), job.lastError);
            assert.strictEqual(job.errors, 1);
        });

        it('should count a run that times out and then throws once', async function() {
            await reset({ turnTimeout: 30 });
            const late = deferred();
            const reported = deferred();
            controller.on('slow', async () => {
                await late.promise;
                throw new Error('late failure');
            });
            controller.on('scheduler_error', async (bot, message) => {
                reported.resolve(message.error.message);
            });
            await scheduler.every('s', '1m', { event: 'slow' });
            await scheduler.tick(t0 + 60000);
            await quietly(async () => {
                late.resolve();
                assert.strictEqual(await reported.promise, 'late failure');
            });
            const job = await scheduler.get('s');
            assert.strictEqual(job.errors, 1);
            assert.ok(/Timed out after 30ms/.test(job.lastError));
        });

        it('should not time out turns when turnTimeout is 0', async function() {
            await reset({ turnTimeout: 0 });
            let done = false;
            controller.on('e', async () => {
                await new Promise((resolve) => setImmediate(resolve));
                done = true;
            });
            await scheduler.every('z', '1m', { event: 'e' });
            assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            assert.strictEqual(done, true);
            assert.strictEqual((await scheduler.get('z')).errors, 0);
        });

        it('should record a turn that fails in middleware', async function() {
            controller.middleware.receive.use((bot, message, next) => {
                next(message.botkitScheduler ? new Error('middleware failed') : undefined);
            });
            await scheduler.every('m', '1m', { event: 'e' });
            assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            const job = await scheduler.get('m');
            assert.strictEqual(job.errors, 1);
            assert.strictEqual(job.lastError, 'middleware failed');
        });

        it('should keep running when storage writes fail', async function() {
            class FlakyStorage extends MemoryStorage {
                async write(changes) {
                    if (this.fail) {
                        throw new Error('disk full');
                    }
                    return super.write(changes);
                }
            }
            const storage = new FlakyStorage();
            await reset({ storage });
            let runs = 0;
            controller.on('e', async () => { runs++; });
            await scheduler.every('w', '1m', { event: 'e' });

            storage.fail = true;
            await assert.rejects(scheduler.every('w2', '1m', { event: 'e' }), /disk full/);
            const logged = await quietly(async () => {
                assert.strictEqual(await scheduler.tick(t0 + 60000), 2);
            });
            assert.strictEqual(runs, 2);
            assert.ok(logged.length > 0);

            // the change is kept in memory and saved by the next write that succeeds
            storage.fail = false;
            await scheduler.pause('w');
            const saved = await storage.read(['botkit-scheduler/jobs']);
            assert.deepStrictEqual(Object.keys(saved['botkit-scheduler/jobs'].jobs).sort(), ['w', 'w2']);
        });
    });

    describe('overlap and limits', function() {
        async function overlapRuns(overlap) {
            const gate = deferred();
            const started = deferred();
            let calls = 0;
            controller.on('slow', async () => {
                calls++;
                if (calls === 1) {
                    started.resolve();
                    await gate.promise;
                }
            });
            await scheduler.every('s', '1m', { event: 'slow', overlap });
            const p1 = scheduler.tick(t0 + 60000);
            await started.promise;
            await scheduler.tick(t0 + 120000);
            const during = await scheduler.get('s');
            gate.resolve();
            assert.strictEqual(await p1, 1);
            return during;
        }

        it('should skip a run while the previous run is going with overlap "skip"', async function() {
            const job = await overlapRuns('skip');
            assert.strictEqual(job.runs, 1);
            assert.strictEqual(job.skipped, 1);
            assert.strictEqual(job.nextRunAt, iso(t0 + 180000));
        });

        it('should run both with overlap "allow"', async function() {
            const job = await overlapRuns('allow');
            assert.strictEqual(job.runs, 2);
            assert.strictEqual(job.skipped, 0);
        });

        it('should stop after maxRuns', async function() {
            let count = 0;
            controller.on('e', async () => { count++; });
            await scheduler.every('m', '1m', { event: 'e', maxRuns: 2 });
            assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            assert.strictEqual(await scheduler.tick(t0 + 120000), 1);
            assert.strictEqual(await scheduler.get('m'), undefined);
            assert.strictEqual(await scheduler.tick(t0 + 180000), 0);
            assert.strictEqual(count, 2);
        });

        it('should keep a job that reached maxRuns when pruneCompleted is false', async function() {
            await reset({ pruneCompleted: false });
            controller.on('e', async () => {});
            await scheduler.every('m', '1m', { event: 'e', maxRuns: 1 });
            await scheduler.tick(t0 + 60000);
            const job = await scheduler.get('m');
            assert.strictEqual(job.runs, 1);
            assert.strictEqual(job.nextRunAt, null);
            assert.strictEqual((await scheduler.resume('m')).nextRunAt, null);
            assert.strictEqual(await scheduler.tick(t0 + 600000), 0);
        });

        it('should run a job that fell behind once and count the missed slots', async function() {
            let count = 0;
            controller.on('e', async () => { count++; });
            await scheduler.every('f', '1m', { event: 'e' });
            assert.strictEqual(await scheduler.tick(t0 + 4 * 60000 + 1000), 1);
            const job = await scheduler.get('f');
            assert.strictEqual(count, 1);
            assert.strictEqual(job.skipped, 3);
            assert.strictEqual(job.nextRunAt, iso(t0 + 5 * 60000));
        });
    });

    describe('job API', function() {
        it('should pause, resume, run now and cancel', async function() {
            let count = 0;
            controller.on('tick', async () => { count++; });
            await scheduler.every('p', '1m', { event: 'tick' });

            const paused = await scheduler.pause('p');
            assert.strictEqual(paused.paused, true);
            assert.strictEqual(paused.nextRunAt, iso(t0 + 60000));
            assert.strictEqual(await scheduler.tick(t0 + 60000), 0);
            assert.strictEqual(count, 0);

            clock.advance(150000);
            const resumed = await scheduler.resume('p');
            assert.strictEqual(resumed.paused, false);
            assert.strictEqual(resumed.nextRunAt, iso(t0 + 180000));

            await scheduler.runNow('p');
            assert.strictEqual(count, 1);
            const job = await scheduler.get('p');
            assert.strictEqual(job.nextRunAt, iso(t0 + 180000));
            assert.strictEqual(job.runs, 1);

            await assert.rejects(scheduler.runNow('nope'), /Unknown job "nope"/);
            assert.strictEqual(await scheduler.cancel('p'), true);
            assert.strictEqual(await scheduler.cancel('p'), false);
            assert.strictEqual(await scheduler.get('p'), undefined);
            assert.strictEqual(await scheduler.pause('p'), undefined);
            assert.strictEqual(await scheduler.resume('p'), undefined);
        });

        it('should keep the time of a resumed one-shot job', async function() {
            let count = 0;
            controller.on('once', async () => { count++; });
            await scheduler.at('a', t0 + 5000, { event: 'once' });
            await scheduler.pause('a');
            assert.strictEqual(await scheduler.tick(t0 + 10000), 0);
            clock.advance(10000);
            assert.strictEqual((await scheduler.resume('a')).nextRunAt, iso(t0 + 5000));
            assert.strictEqual(await scheduler.tick(), 1);
            assert.strictEqual(count, 1);
        });

        it('should resume a cron job at its next matching time', async function() {
            await scheduler.cron('c', '0 * * * *', { event: 'hourly' });
            await scheduler.pause('c');
            clock.advance(3 * 3600000 + 60000);
            assert.strictEqual((await scheduler.resume('c')).nextRunAt, '2026-09-27T16:00:00.000Z');
        });

        it('should finish a one-shot job run with runNow()', async function() {
            let count = 0;
            controller.on('once', async () => { count++; });
            await scheduler.at('a', t0 + 3600000, { event: 'once' });
            await scheduler.runNow('a');
            assert.strictEqual(count, 1);
            assert.strictEqual(await scheduler.get('a'), undefined);
        });

        it('should list jobs soonest first, filtered by event, conversation or user', async function() {
            await reset({ pruneCompleted: false });
            controller.on('a', async () => {});
            await scheduler.at('done', t0, { event: 'a' });
            await scheduler.tick(t0);
            await scheduler.at('z', t0 + 1000, { event: 'a' });
            await scheduler.at('y', t0 + 1000, { event: 'b', reference: reference('c1', 'u1') });
            await scheduler.at('x', t0 + 500, { event: 'a', reference: reference('c2', 'u2') });

            const ids = async (filter) => (await scheduler.list(filter)).map((job) => job.id);
            assert.deepStrictEqual(await ids(), ['x', 'y', 'z', 'done']);
            assert.deepStrictEqual(await ids({ event: 'a' }), ['x', 'z', 'done']);
            assert.deepStrictEqual(await ids({ conversation: 'c1' }), ['y']);
            assert.deepStrictEqual(await ids({ user: 'u2' }), ['x']);
            assert.deepStrictEqual(await ids({ event: 'b', user: 'u2' }), []);
        });

        it('should accept job ids that are Object.prototype names', async function() {
            const seen = [];
            controller.on('e', async (bot, message) => { seen.push(message.job.id); });
            assert.strictEqual(await scheduler.get('toString'), undefined);
            assert.strictEqual(await scheduler.cancel('constructor'), false);
            await scheduler.at('constructor', t0, { event: 'e' });
            await scheduler.at('__proto__', t0, { event: 'e' });
            assert.deepStrictEqual((await scheduler.list()).map((job) => job.id), ['__proto__', 'constructor']);
            assert.strictEqual(await scheduler.tick(t0), 2);
            assert.deepStrictEqual(seen.sort(), ['__proto__', 'constructor']);
            assert.deepStrictEqual(await scheduler.list(), []);
        });

        it('should return copies of jobs', async function() {
            await scheduler.at('x', t0 + 500, { event: 'a', payload: { n: 1 }, reference: reference('c2', 'u2') });
            const job = await scheduler.get('x');
            job.payload.n = 2;
            job.reference.user.id = 'mallory';
            job.nextRunAt = null;
            const again = (await scheduler.list())[0];
            assert.strictEqual(again.payload.n, 1);
            assert.strictEqual(again.reference.user.id, 'u2');
            assert.strictEqual(again.nextRunAt, iso(t0 + 500));
        });

        it('should keep the schedule of a re-declared job and update its options', async function() {
            await scheduler.every('u', '1m', { event: 'e', payload: 1 });
            clock.advance(30000);
            const job = await scheduler.every('u', '1m', { event: 'e', payload: 2, maxRuns: 5, overlap: 'allow' });
            assert.strictEqual(job.nextRunAt, iso(t0 + 60000));
            assert.strictEqual(job.createdAt, iso(t0));
            assert.strictEqual(job.payload, 2);
            assert.strictEqual(job.maxRuns, 5);
            assert.strictEqual(job.overlap, 'allow');
            assert.strictEqual((await scheduler.list()).length, 1);
        });

        it('should reschedule a re-declared job whose timing changed, keeping its counters', async function() {
            controller.on('e', async () => {});
            await scheduler.every('u', '1m', { event: 'e' });
            await scheduler.tick(t0 + 60000);
            clock.advance(90000);

            let job = await scheduler.every('u', '5m', { event: 'e' });
            assert.strictEqual(job.nextRunAt, iso(t0 + 90000 + 300000));
            assert.strictEqual(job.every, 300000);
            assert.strictEqual(job.runs, 1);
            assert.strictEqual(job.createdAt, iso(t0));

            job = await scheduler.every('u', '5m', { event: 'e', reference: reference('c1', 'u1') });
            assert.deepStrictEqual(job.reference, reference('c1', 'u1'));
            assert.strictEqual(job.runs, 1);

            job = await scheduler.cron('u', '0 0 * * *', { event: 'e' });
            assert.strictEqual(job.kind, 'cron');
            assert.strictEqual(job.every, null);
            assert.strictEqual(job.nextRunAt, '2026-09-28T00:00:00.000Z');
        });

        it('should move an "in" job that is scheduled again with the same id', async function() {
            await scheduler.schedule({ id: 'snooze', in: '5m', event: 'e' });
            clock.advance(60000);
            const job = await scheduler.schedule({ id: 'snooze', in: '5m', event: 'e' });
            assert.strictEqual(job.nextRunAt, iso(t0 + 360000));
            assert.strictEqual(job.createdAt, iso(t0));
            assert.strictEqual((await scheduler.list()).length, 1);
        });

        it('should finish a re-declared job whose new maxRuns is already reached', async function() {
            controller.on('e', async () => {});
            await scheduler.every('u', '1m', { event: 'e' });
            await scheduler.tick(t0 + 60000);
            await scheduler.tick(t0 + 120000);
            const job = await scheduler.every('u', '1m', { event: 'e', maxRuns: 2 });
            assert.strictEqual(job.nextRunAt, null);
            assert.strictEqual(await scheduler.get('u'), undefined);
        });

        it('should anchor an interval job to startAt', async function() {
            let job = await scheduler.every('future', '1h', { event: 'e', startAt: t0 + 600000 });
            assert.strictEqual(job.nextRunAt, iso(t0 + 600000));
            assert.strictEqual(job.startAt, iso(t0 + 600000));
            job = await scheduler.every('past', '1h', { event: 'e', startAt: new Date(t0 - 90 * 60000) });
            assert.strictEqual(job.nextRunAt, iso(t0 + 30 * 60000));
            job = await scheduler.every('now', '1h', { event: 'e', startAt: iso(t0) });
            assert.strictEqual(job.nextRunAt, iso(t0));
        });

        it('should read cron jobs in their time zone', async function() {
            let job = await scheduler.cron('nine', '0 9 * * *', { event: 'e', timezone: 'America/New_York' });
            assert.strictEqual(job.timezone, 'America/New_York');
            assert.strictEqual(job.nextRunAt, '2026-09-27T13:00:00.000Z');

            controller.on('e', async () => {});
            await scheduler.tick(Date.parse('2026-09-27T13:00:00Z'));
            job = await scheduler.get('nine');
            assert.strictEqual(job.nextRunAt, '2026-09-28T13:00:00.000Z');

            await reset({ timezone: 'Asia/Kolkata' });
            job = await scheduler.cron('midnight', '0 0 * * *', { event: 'e' });
            assert.strictEqual(job.timezone, 'Asia/Kolkata');
            assert.strictEqual(job.nextRunAt, '2026-09-27T18:30:00.000Z');
        });

        it('should reject invalid jobs', async function() {
            const circular = {};
            circular.self = circular;
            const cases = [
                [{}, /event is required/],
                [undefined, /event is required/],
                [{ event: '', in: 5 }, /event is required/],
                [{ event: 'message', in: 5 }, /reserved/],
                [{ event: 'shutdown', in: 5 }, /reserved/],
                [{ event: 'a,b', in: 5 }, /comma/],
                [{ event: 'e', in: 5, every: 5 }, /exactly one of in, at, every or cron/],
                [{ event: 'e' }, /exactly one of/],
                [{ event: 'e', cron: 'bad' }, /Invalid cron expression/],
                [{ event: 'e', cron: '0 0 30 2 *' }, /does not match any time/],
                [{ event: 'e', cron: '* * * * *', timezone: 'Nope/Nope' }, /Invalid timezone/],
                [{ event: 'e', in: 5, maxRuns: 0 }, /maxRuns/],
                [{ event: 'e', in: 5, maxRuns: 1.5 }, /maxRuns/],
                [{ event: 'e', in: 5, reference: { channelId: 'x' } }, /reference must include channelId, conversation.id and user.id/],
                [{ event: 'e', in: 5, reference: { channelId: 'x', conversation: { id: 'c' }, user: {} } }, /reference must include/],
                [{ event: 'e', at: 'not a date' }, /Invalid date/],
                [{ event: 'e', at: {} }, /Invalid date/],
                [{ event: 'e', in: 'soon' }, /Invalid duration/],
                [{ event: 'e', in: '100000000000w' }, /Invalid date/],
                [{ event: 'e', every: 0 }, /Invalid duration/],
                [{ event: 'e', every: '1m', startAt: 'never' }, /Invalid date/],
                [{ event: 'e', in: 5, overlap: 'queue' }, /overlap/],
                [{ event: 'e', in: 5, id: '' }, /id must be a non-empty string/],
                [{ event: 'e', in: 5, payload: () => 1 }, /payload must be JSON-serializable/],
                [{ event: 'e', in: 5, payload: circular }, /payload must be JSON-serializable/]
            ];
            for (let c = 0; c < cases.length; c++) {
                await assert.rejects(scheduler.schedule(cases[c][0]), cases[c][1], `case ${ c }`);
            }
            await assert.rejects(scheduler.at('x', 'tomorrow-ish', { event: 'e' }), /Invalid date/);
            await assert.rejects(scheduler.every('x', 'often', { event: 'e' }), /Invalid duration/);
            await assert.rejects(scheduler.cron('x', '* * *', { event: 'e' }), /Invalid cron expression/);
            assert.deepStrictEqual(await scheduler.list(), []);
        });
    });

    describe('ClockAdapter', function() {
        const ref = (id) => ({ channelId: 'scheduler', conversation: { id: `scheduler:${ id }` }, user: { id: 'scheduler' }, bot: { id: 'bot' } });

        it('should continue a clock-channel conversation and pass errors on', async function() {
            const out = [];
            await reset({ output: (activity, job) => { out.push([activity.text, job ? job.id : null]); } });
            await scheduler.every('hb', '1m', { event: 'hb' });
            const names = [];
            await scheduler.clockAdapter.continueConversation(ref('hb'), async (context) => {
                names.push(context.activity.name);
                await context.sendActivity('continued');
            });
            assert.deepStrictEqual(names, ['continueConversation']);
            assert.deepStrictEqual(out, [['continued', 'hb']]);
            await assert.rejects(scheduler.clockAdapter.continueConversation(ref('hb'), async () => {
                throw new Error('logic failed');
            }), /logic failed/);
            await scheduler.clockAdapter.updateActivity();
            await scheduler.clockAdapter.deleteActivity();
        });

        it('should pass a null job when the scheduler cannot look one up', async function() {
            const out = [];
            const lone = new BotkitScheduler({ output: (activity, job) => { out.push([activity.text, job]); } });
            const context = new TurnContext(lone.clockAdapter, { type: 'event', channelId: 'scheduler', conversation: { id: 'scheduler:x' }, from: { id: 'scheduler' }, recipient: { id: 'bot' } });
            const response = await context.sendActivity('hello');
            assert.deepStrictEqual(out, [['hello', null]]);
            assert.ok(/^clock-\d+$/.test(response.id));
        });
    });

    describe('timer', function() {
        it('should arm the fake clock for the next job and re-arm after firing', async function() {
            await reset({ autoStart: true });
            await new Promise(setImmediate);
            assert.strictEqual(clock.timers.length, 0);

            let pings = 0;
            controller.on('ping', async () => { pings++; });
            await scheduler.at('a', t0 + 5000, { event: 'ping' });
            assert.strictEqual(clock.timers.length, 1);
            assert.strictEqual(clock.timers[0].ms, 5000);

            await scheduler.every('b', '1m', { event: 'ping' });
            assert.strictEqual(clock.timers.length, 1);
            assert.strictEqual(clock.timers[0].ms, 5000);

            assert.strictEqual(await clock.fire(), 1);
            assert.strictEqual(pings, 1);
            assert.strictEqual(clock.timers.length, 1);
            assert.strictEqual(clock.timers[0].ms, 55000);

            assert.strictEqual(await clock.fire(), 1);
            assert.strictEqual(pings, 2);
            assert.strictEqual(clock.timers[0].at, t0 + 120000);
        });

        it('should cap the delay for a job far in the future', async function() {
            await reset({ autoStart: true });
            await new Promise(setImmediate);
            await scheduler.at('far', t0 + 40 * 24 * 3600000, { event: 'far' });
            assert.strictEqual(clock.timers.length, 1);
            assert.strictEqual(clock.timers[0].ms, 2147483647);

            // waking up early re-arms for the rest of the wait
            assert.strictEqual(await clock.fire(), 0);
            assert.strictEqual(clock.timers.length, 1);
            assert.strictEqual(clock.timers[0].at, t0 + 40 * 24 * 3600000);
        });

        it('should not arm for paused jobs, and disarm when nothing is left', async function() {
            await reset({ autoStart: true });
            await new Promise(setImmediate);
            await scheduler.every('p', '1m', { event: 'e' });
            assert.strictEqual(clock.timers.length, 1);
            await scheduler.pause('p');
            assert.strictEqual(clock.timers.length, 0);
            await scheduler.resume('p');
            assert.strictEqual(clock.timers.length, 1);
            await scheduler.cancel('p');
            assert.strictEqual(clock.timers.length, 0);
        });

        it('should unref the timer when asked', async function() {
            const unrefs = [];
            const unrefClock = new FakeClock(t0);
            const setTimeout = unrefClock.setTimeout.bind(unrefClock);
            unrefClock.setTimeout = (fn, ms) => {
                const timer = setTimeout(fn, ms);
                timer.unref = () => unrefs.push(ms);
                return timer;
            };
            await reset({ autoStart: true, unref: true, clock: unrefClock });
            await new Promise(setImmediate);
            await scheduler.every('u', '1m', { event: 'e' });
            assert.deepStrictEqual(unrefs, [60000]);
        });

        it('should stop the timer on stop() while tick() keeps working', async function() {
            await reset({ autoStart: true });
            await new Promise(setImmediate);
            let count = 0;
            controller.on('e', async () => { count++; });
            await scheduler.every('s', '1m', { event: 'e' });
            await scheduler.stop();
            assert.strictEqual(clock.timers.length, 0);
            assert.strictEqual(await scheduler.tick(t0 + 60000), 1);
            assert.strictEqual(count, 1);
            assert.strictEqual(clock.timers.length, 0);

            scheduler.start();
            await new Promise(setImmediate);
            assert.strictEqual(clock.timers.length, 1);
        });

        it('should leave no timer behind after shutdown with the real clock', async function() {
            await controller.shutdown();
            adapter = new FakeAdapter();
            scheduler = new BotkitScheduler();
            controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
            controller.usePlugin(scheduler);
            await new Promise(setImmediate);

            await scheduler.every('x', '1h', { event: 'x' });
            assert.notStrictEqual(scheduler.timer, null);
            await controller.shutdown();
            assert.strictEqual(scheduler.timer, null);
        });

        it('should not start the timer when shut down before Botkit is ready', async function() {
            await controller.shutdown();
            adapter = new FakeAdapter();
            scheduler = new BotkitScheduler();
            controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
            controller.usePlugin(scheduler);

            await scheduler.every('x', '1h', { event: 'x' });
            await controller.shutdown();
            await new Promise(setImmediate);
            assert.strictEqual(scheduler.timer, null);
        });
    });
});
