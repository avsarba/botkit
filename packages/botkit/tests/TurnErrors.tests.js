const assert = require('assert');
const { BotAdapter, MemoryStorage, TurnContext } = require('botbuilder');
const { Botkit, BotkitConversation, TeamsBotWorker } = require('../');

/**
 * A minimal in-memory adapter that runs every turn through the full Botkit pipeline.
 */
class ProbeAdapter extends BotAdapter {
    constructor() {
        super();
        this.name = 'Probe';
        this.sent = [];
        this.sendError = null;
    }

    init(controller) {
        this.controller = controller;
    }

    async sendActivities(context, activities) {
        if (this.sendError) {
            throw this.sendError;
        }
        return activities.map((activity) => {
            this.sent.push(JSON.parse(JSON.stringify(activity)));
            return { id: String(this.sent.length) };
        });
    }

    async updateActivity() {
        // no-op
    }

    async deleteActivity() {
        // no-op
    }

    async continueConversation(reference, logic) {
        const request = TurnContext.applyConversationReference({ type: 'event', name: 'continueConversation' }, reference, true);
        await this.runMiddleware(new TurnContext(this, request), logic);
    }

    async processActivity(req, res, logic) {
        await this.runMiddleware(new TurnContext(this, req.body), logic);
    }

    activity(partial) {
        return { type: 'message', channelId: 'probe', conversation: { id: 'c1' }, from: { id: 'u1' }, recipient: { id: 'bot' }, ...partial };
    }

    async turn(partial) {
        const context = new TurnContext(this, this.activity(partial));
        await this.runMiddleware(context, this.controller.handleTurn.bind(this.controller));
        return context;
    }
}

/**
 * MemoryStorage that records writes and can be told to fail them.
 */
class SpyStorage extends MemoryStorage {
    constructor() {
        super();
        this.writes = [];
        this.writeError = null;
    }

    async write(changes) {
        if (this.writeError) {
            throw this.writeError;
        }
        this.writes.push(Object.keys(changes));
        return super.write(changes);
    }
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe('Botkit turn errors', function() {
    let adapter;
    let controller;
    let controllers;
    let unhandled;
    let logged;
    let consoleError;

    const onUnhandled = (reason) => unhandled.push(reason);

    const createController = (options) => {
        const instance = new Botkit({ disable_webserver: true, disable_console: true, ...options });
        controllers.push(instance);
        return instance;
    };

    const freshContext = () => new TurnContext(adapter, adapter.activity({ text: '' }));

    beforeEach(function() {
        unhandled = [];
        logged = [];
        controllers = [];
        process.on('unhandledRejection', onUnhandled);
        // capture the errors Botkit logs so they can be asserted on (and kept out of the test output)
        consoleError = console.error;
        console.error = (...args) => logged.push(args);

        adapter = new ProbeAdapter();
        controller = createController({ adapter });
    });

    afterEach(async function() {
        for (const instance of controllers) {
            await instance.shutdown();
        }
        // give any stray rejection a chance to be reported before checking
        await nextTick();
        process.removeListener('unhandledRejection', onUnhandled);
        console.error = consoleError;
        assert.deepStrictEqual(unhandled, [], 'no unhandled rejection should be raised');
    });

    describe('handler errors reject the turn', function() {
        it('should reject when a hears handler throws', async function() {
            controller.hears('boom', 'message', async () => {
                throw new Error('kaboom');
            });

            await assert.rejects(adapter.turn({ text: 'boom' }), (err) => err.message === 'kaboom');
        });

        it('should reject with the same Error instance thrown by an on() handler', async function() {
            const thrown = new Error('specific failure');
            controller.on('message', async () => {
                throw thrown;
            });

            await assert.rejects(adapter.turn({ text: 'anything' }), (err) => err === thrown);
            assert(logged.some((args) => args[0] === 'Error in trigger handler' && args[1] === thrown), 'trigger should still log the error');
        });

        it('should wrap a non-Error value thrown by an on() handler in an Error', async function() {
            controller.on('message', async () => {
                throw 'plain string'; // eslint-disable-line no-throw-literal
            });

            await assert.rejects(adapter.turn({ text: 'anything' }), (err) => err instanceof Error && err.message === 'plain string');
        });

        it('should reject when an interrupts handler throws', async function() {
            let heard = false;
            controller.interrupts('stop', 'message', async () => {
                throw new Error('interrupt failed');
            });
            controller.hears('stop', 'message', async () => {
                heard = true;
            });

            await assert.rejects(adapter.turn({ text: 'stop' }), /interrupt failed/);
            assert.strictEqual(heard, false, 'hears should not run after an interrupt fails');
        });

        it('should reject when a custom event handler throws', async function() {
            controller.on('custom_event', async () => {
                throw new Error('custom failed');
            });

            await assert.rejects(adapter.turn({ type: 'event', channelData: { botkitEventType: 'custom_event' } }), /custom failed/);
        });

        it('should reject when controller.trigger() is called directly and a handler throws', async function() {
            const thrown = new Error('direct');
            controller.on('direct_event', async () => {
                throw thrown;
            });

            await assert.rejects(controller.trigger('direct_event'), (err) => err === thrown);
        });

        it('should reject with an Error when a hears handler throws a value that is not an Error', async function() {
            controller.hears('string', 'message', async () => {
                throw 'plain string'; // eslint-disable-line no-throw-literal
            });
            controller.hears('nothing', 'message', async () => {
                throw undefined; // eslint-disable-line no-throw-literal
            });

            await assert.rejects(adapter.turn({ text: 'string' }), (err) => err instanceof Error && err.message === 'plain string');
            await assert.rejects(adapter.turn({ text: 'nothing' }), (err) => err instanceof Error);
        });

        it('should reject with an Error when an ask() handler throws null', async function() {
            const convo = new BotkitConversation('ask_throws_null', controller);
            convo.ask('Name?', async () => {
                throw null; // eslint-disable-line no-throw-literal
            }, 'name');
            controller.addDialog(convo);
            controller.hears('start', 'message', async (bot) => {
                await bot.beginDialog('ask_throws_null');
            });

            await adapter.turn({ text: 'start' });
            await assert.rejects(adapter.turn({ text: 'Ann' }), (err) => err instanceof Error && err.message === 'null');
        });
    });

    describe('middleware errors reject the turn', function() {
        for (const stage of ['ingest', 'receive', 'interpret']) {
            it(`should reject when an async ${ stage } middleware that takes next throws`, async function() {
                let heard = false;
                controller.hears('hello', 'message', async () => {
                    heard = true;
                });
                controller.middleware[stage].use(async (bot, message, next) => {
                    await Promise.resolve();
                    throw new Error(`${ stage } failed`);
                });

                await assert.rejects(adapter.turn({ text: 'hello' }), (err) => err.message === `${ stage } failed`);
                assert.strictEqual(heard, false, 'the turn should stop at the failed middleware');
            });
        }

        it('should reject when an async spawn middleware that takes next throws', async function() {
            controller.middleware.spawn.use(async (bot, next) => {
                await Promise.resolve();
                throw new Error('spawn failed');
            });

            await assert.rejects(adapter.turn({ text: 'hello' }), /spawn failed/);
            await assert.rejects(controller.spawn({}, adapter), /spawn failed/);
        });

        it('should reject with an Error when an async middleware that takes next rejects without a reason', async function() {
            let heard = false;
            controller.hears('hello', 'message', async () => {
                heard = true;
            });
            controller.middleware.receive.use(async (bot, message, next) => {
                throw undefined; // eslint-disable-line no-throw-literal
            });

            await assert.rejects(adapter.turn({ text: 'hello' }), (err) => err instanceof Error);
            assert.strictEqual(heard, false, 'a rejection without a reason must not continue the turn');
        });

        it('should keep running an async middleware that takes next and calls it', async function() {
            let tagged;
            controller.middleware.receive.use(async (bot, message, next) => {
                await Promise.resolve();
                message.tagged = 'yes';
                next();
            });
            controller.hears('hello', 'message', async (bot, message) => {
                tagged = message.tagged;
            });

            await adapter.turn({ text: 'hello' });
            assert.strictEqual(tagged, 'yes');
        });

        it('should log, not reject, an error an async middleware throws after calling next', async function() {
            const late = new Error('late failure');
            let heard = false;
            controller.middleware.receive.use(async (bot, message, next) => {
                next();
                await Promise.resolve();
                throw late;
            });
            controller.hears('hello', 'message', async () => {
                heard = true;
            });

            await adapter.turn({ text: 'hello' });
            await nextTick();
            assert.strictEqual(heard, true);
            assert(logged.some((args) => args.includes(late)), 'the late error should be logged');
        });
    });

    describe('dialog errors reject the turn', function() {
        it('should reject when an ask() handler throws, without saving the failed turn', async function() {
            const convo = new BotkitConversation('ask_throws', controller);
            convo.ask('Pick one', [
                {
                    pattern: '^bad$',
                    handler: async () => {
                        throw new Error('bad answer');
                    }
                },
                {
                    default: true,
                    handler: async () => {
                        // accept any other answer
                    }
                }
            ], 'pick');
            controller.addDialog(convo);

            let results;
            controller.afterDialog('ask_throws', async (bot, dialogResults) => {
                results = dialogResults;
            });
            controller.hears('start', 'message', async (bot) => {
                await bot.beginDialog('ask_throws');
            });

            await adapter.turn({ text: 'start' });
            await assert.rejects(adapter.turn({ text: 'bad' }), /bad answer/);

            // the failed turn was not saved, so the question is still waiting in storage
            const pending = await controller.getPendingQuestion(freshContext());
            assert.strictEqual(pending.key, 'pick');

            await adapter.turn({ text: 'good' });
            assert(results, 'the dialog should complete');
            assert.strictEqual(results.pick, 'good');
            assert.deepStrictEqual(adapter.sent.map((a) => a.text), ['Pick one'], 'the question should be asked once');
        });

        it('should reject when a convo.before() hook throws', async function() {
            const convo = new BotkitConversation('before_throws', controller);
            convo.before('default', async () => {
                throw new Error('before failed');
            });
            convo.say('Hello');
            controller.addDialog(convo);
            controller.hears('start', 'message', async (bot) => {
                await bot.beginDialog('before_throws');
            });

            await assert.rejects(adapter.turn({ text: 'start' }), /before failed/);
            assert.deepStrictEqual(adapter.sent, []);

            // the dialog never started, so nothing is waiting and the next turn is handled normally
            assert.strictEqual(await controller.getPendingQuestion(freshContext()), null);
            await assert.rejects(adapter.turn({ text: 'start' }), /before failed/);
        });

        it('should reject when a convo.onChange() hook throws', async function() {
            const convo = new BotkitConversation('change_throws', controller);
            convo.ask('Name?', [], 'name');
            convo.onChange('name', async () => {
                throw new Error('change failed');
            });
            controller.addDialog(convo);
            controller.hears('start', 'message', async (bot) => {
                await bot.beginDialog('change_throws');
            });

            await adapter.turn({ text: 'start' });
            await assert.rejects(adapter.turn({ text: 'Ann' }), /change failed/);
        });

        it('should reject when a convo.after() hook throws', async function() {
            const convo = new BotkitConversation('after_throws', controller);
            convo.ask('Name?', [], 'name');
            convo.after(async () => {
                throw new Error('after failed');
            });
            controller.addDialog(convo);
            controller.hears('start', 'message', async (bot) => {
                await bot.beginDialog('after_throws');
            });

            await adapter.turn({ text: 'start' });
            await assert.rejects(adapter.turn({ text: 'Ann' }), /after failed/);
        });

        it('should keep a dialog that bot.beginDialog() saved before the handler failed', async function() {
            // documented: beginDialog() and replaceDialog() save state immediately, so a later failure does not undo them
            const convo = new BotkitConversation('signup', controller);
            convo.ask('Email?', async () => {
                // any answer
            }, 'email');
            controller.addDialog(convo);
            controller.hears('go', 'message', async (bot) => {
                await bot.beginDialog('signup');
                throw new Error('analytics failed');
            });

            await assert.rejects(adapter.turn({ text: 'go' }), /analytics failed/);
            const pending = await controller.getPendingQuestion(freshContext());
            assert.strictEqual(pending.dialog, 'signup');
            assert.strictEqual(pending.key, 'email');
        });

        it('should reject instead of skipping a question whose template fails to render', async function() {
            const convo = new BotkitConversation('question_fails', controller);
            convo.ask({
                text: 'Pick one',
                quick_replies: async () => {
                    throw new Error('quick reply lookup failed');
                }
            }, async () => {
                // any answer
            }, 'choice');
            convo.say('Thanks, you picked {{vars.choice}}');
            controller.addDialog(convo);
            let results;
            controller.afterDialog('question_fails', async (bot, dialogResults) => {
                results = dialogResults;
            });
            controller.hears('start', 'message', async (bot) => {
                await bot.beginDialog('question_fails');
            });

            await assert.rejects(adapter.turn({ text: 'start' }), /quick reply lookup failed/);
            assert.deepStrictEqual(adapter.sent, [], 'the dialog should not move past the question');
            assert.strictEqual(results, undefined, 'the dialog should not complete');
            assert.strictEqual(await controller.getPendingQuestion(freshContext()), null, 'the failed turn should not be saved');
        });

        it('should reject when a send middleware fails for a question, as it does for a message', async function() {
            controller.middleware.send.use((bot, activity, next) => {
                next(activity.text === 'Email?' ? new Error('filter unavailable') : undefined);
            });
            for (const kind of ['question', 'message']) {
                const convo = new BotkitConversation(`send_fails_${ kind }`, controller);
                if (kind === 'question') {
                    convo.ask('Email?', async () => {
                        // any answer
                    }, 'email');
                } else {
                    convo.say('Email?');
                }
                convo.say('Done: {{vars.email}}');
                controller.addDialog(convo);
                controller.hears(kind, 'message', async (bot) => {
                    await bot.beginDialog(`send_fails_${ kind }`);
                });

                await assert.rejects(adapter.turn({ text: kind }), /filter unavailable/, kind);
            }
            assert.deepStrictEqual(adapter.sent, []);
        });

        it('should reject when a controller.afterDialog() handler throws', async function() {
            const convo = new BotkitConversation('afterdialog_throws', controller);
            convo.say('Hi');
            controller.addDialog(convo);
            controller.afterDialog('afterdialog_throws', async () => {
                throw new Error('afterDialog failed');
            });
            controller.hears('start', 'message', async (bot) => {
                await bot.beginDialog('afterdialog_throws');
            });

            await assert.rejects(adapter.turn({ text: 'start' }), /afterDialog failed/);
        });
    });

    describe('onTurnError', function() {
        it('should hand the error to adapter.onTurnError and resolve', async function() {
            let captured;
            adapter.onTurnError = async (context, err) => {
                captured = err;
            };
            controller.hears('boom', 'message', async () => {
                throw new Error('kaboom');
            });

            await adapter.turn({ text: 'boom' });
            assert(captured instanceof Error);
            assert.strictEqual(captured.message, 'kaboom');
        });

        it('should let getPendingQuestion() read the saved state after a turn that onTurnError handled', async function() {
            adapter.onTurnError = async (context) => {
                await context.sendActivity('Sorry, something went wrong.');
            };
            const convo = new BotkitConversation('pay', controller);
            convo.ask('Card number?', async (answer) => {
                if (answer === 'bad') {
                    throw new Error('card service down');
                }
            }, 'card');
            convo.ask('Amount?', async () => {
                // any answer
            }, 'amount');
            controller.addDialog(convo);
            controller.hears('pay', 'message', async (bot) => {
                await bot.beginDialog('pay');
            });

            await adapter.turn({ text: 'pay' });
            // runMiddleware resolves because onTurnError handled the error
            const context = await adapter.turn({ text: 'bad' });

            const pending = await controller.getPendingQuestion(context);
            assert(pending, 'the question should still be pending');
            assert.strictEqual(pending.key, 'card');
            assert.deepStrictEqual(pending, await controller.getPendingQuestion(freshContext()));
            assert.deepStrictEqual(adapter.sent.map((a) => a.text), ['Card number?', 'Sorry, something went wrong.']);
        });
    });

    describe('sending', function() {
        const reference = { channelId: 'probe', conversation: { id: 'c1' }, user: { id: 'u1' }, bot: { id: 'bot' } };

        it('should reject bot.say() when the adapter fails to send', async function() {
            adapter.sendError = new Error('send failed');
            const bot = await controller.spawn({}, adapter);
            await bot.changeContext(reference);

            await assert.rejects(bot.say('x'), /send failed/);
        });

        it('should resolve bot.say() with the adapter response when sending works', async function() {
            const bot = await controller.spawn({}, adapter);
            await bot.changeContext(reference);

            const response = await bot.say('x');
            assert.deepStrictEqual(response, { id: '1' });
            assert.strictEqual(adapter.sent[0].text, 'x');
        });

        it('should reject bot.say() when a send middleware fails', async function() {
            controller.middleware.send.use((bot, activity, next) => next(new Error('send middleware failed')));
            const bot = await controller.spawn({}, adapter);
            await bot.changeContext(reference);

            await assert.rejects(bot.say('x'), /send middleware failed/);
            assert.deepStrictEqual(adapter.sent, []);
        });

        it('should reject bot.say() when an async send middleware that takes next throws', async function() {
            controller.middleware.send.use(async (bot, activity, next) => {
                await Promise.resolve();
                throw new Error('async send middleware failed');
            });
            const bot = await controller.spawn({}, adapter);
            await bot.changeContext(reference);

            await assert.rejects(bot.say('x'), /async send middleware failed/);
            assert.deepStrictEqual(adapter.sent, []);
        });

        it('should reject bot.say() on a bot without a context', async function() {
            const bot = await controller.spawn({}, adapter);

            await assert.rejects(bot.say('x'), /changeContext/);
        });

        it('should reject TeamsBotWorker.replyWithTaskInfo() when sending fails', async function() {
            const context = {
                sendActivity: async () => {
                    throw new Error('invoke send failed');
                }
            };
            const bot = new TeamsBotWorker(controller, { context });

            await assert.rejects(bot.replyWithTaskInfo({}, { type: 'message', value: 'x' }), /invoke send failed/);
        });

        it('should reject the turn when a reply fails to send', async function() {
            adapter.sendError = new Error('send failed');
            controller.hears('hello', 'message', async (bot, message) => {
                await bot.reply(message, 'Hi!');
            });

            await assert.rejects(adapter.turn({ text: 'hello' }), /send failed/);
        });
    });

    describe('webhook endpoint', function() {
        const createWebhookController = (webhookAdapter) => {
            const routes = {};
            const webserver = {
                post: (uri, fn) => {
                    routes[uri] = fn;
                },
                use() {},
                get() {}
            };
            createController({ adapter: webhookAdapter, webserver, disable_webserver: false });
            return routes;
        };

        const createResponse = () => ({
            headersSent: false,
            statusCode: undefined,
            endCalls: 0,
            status(code) {
                this.statusCode = code;
                return this;
            },
            end() {
                this.endCalls++;
                this.headersSent = true;
            }
        });

        const waitForEnd = async (res) => {
            while (res.endCalls === 0) {
                await nextTick();
            }
            // allow a stray rejection to surface before asserting
            await nextTick();
        };

        it('should answer 500 without an unhandled rejection when a handler throws', async function() {
            const webhookAdapter = new ProbeAdapter();
            const routes = createWebhookController(webhookAdapter);
            webhookAdapter.controller.hears('boom', 'message', async () => {
                throw new Error('kaboom');
            });

            const res = createResponse();
            routes['/api/messages']({ body: { ...webhookAdapter.activity({ text: 'boom' }) } }, res);
            await waitForEnd(res);

            assert.strictEqual(res.statusCode, 500);
            assert.strictEqual(res.endCalls, 1);
            assert.deepStrictEqual(unhandled, []);
            assert(logged.some((args) => args[0] === 'Experienced an error inside the turn handler' && args[1].message === 'kaboom'), 'the error should be logged');
        });

        it('should not answer again when the adapter already sent a response', async function() {
            const webhookAdapter = new ProbeAdapter();
            webhookAdapter.processActivity = async (req, res) => {
                res.status(502);
                res.end();
                throw new Error('failed after responding');
            };
            const routes = createWebhookController(webhookAdapter);

            const res = createResponse();
            routes['/api/messages']({ body: webhookAdapter.activity({ text: 'hi' }) }, res);
            await waitForEnd(res);

            assert.strictEqual(res.statusCode, 502);
            assert.strictEqual(res.endCalls, 1);
        });
    });

    describe('unchanged behaviour', function() {
        it('should resolve a normal turn with undefined and save state', async function() {
            const storage = new SpyStorage();
            const saving = new ProbeAdapter();
            const instance = createController({ adapter: saving, storage });
            let heard = false;
            instance.hears('hello', 'message', async () => {
                heard = true;
            });

            let result = 'not set';
            const context = new TurnContext(saving, saving.activity({ text: 'hello' }));
            await saving.runMiddleware(context, async (turnContext) => {
                result = await instance.handleTurn(turnContext);
            });

            assert.strictEqual(heard, true);
            assert.strictEqual(result, undefined);
            assert.strictEqual(storage.writes.length, 1, 'state should be written once');
            assert(storage.writes[0][0].startsWith('probe/conversations/'), 'the conversation state should be written');
        });

        it('should reject when saving state fails', async function() {
            const storage = new SpyStorage();
            storage.writeError = new Error('disk full');
            const saving = new ProbeAdapter();
            const instance = createController({ adapter: saving, storage });
            instance.hears('hello', 'message', async () => {
                // no-op
            });

            await assert.rejects(saving.turn({ text: 'hello' }), /disk full/);
        });

        it('should reject when an ingest middleware calls next(err)', async function() {
            controller.middleware.ingest.use((bot, message, next) => next(new Error('mw')));

            await assert.rejects(adapter.turn({ text: 'hello' }), (err) => err.message === 'mw');
        });

        it('should reject when a receive middleware calls next(err)', async function() {
            controller.middleware.receive.use((bot, message, next) => next(new Error('receive mw')));

            await assert.rejects(adapter.turn({ text: 'hello' }), /receive mw/);
        });

        it('should reject when an interpret middleware calls next(err)', async function() {
            controller.middleware.interpret.use((bot, message, next) => next(new Error('interpret mw')));

            await assert.rejects(adapter.turn({ text: 'hello' }), /interpret mw/);
        });

        it('should fall through when an interrupts or hears handler returns false', async function() {
            const calls = [];
            controller.interrupts('hello', 'message', async () => {
                calls.push('interrupt');
                return false;
            });
            controller.hears('hello', 'message', async () => {
                calls.push('hears');
                return false;
            });
            controller.on('message', async () => {
                calls.push('on');
            });

            await adapter.turn({ text: 'hello' });
            assert.deepStrictEqual(calls, ['interrupt', 'hears', 'on']);
        });

        it('should stop later on() handlers when one returns false', async function() {
            const calls = [];
            controller.on('message', async () => {
                calls.push('first');
                return false;
            });
            controller.on('message', async () => {
                calls.push('second');
            });

            await adapter.turn({ text: 'hello' });
            assert.deepStrictEqual(calls, ['first']);
        });
    });
});
