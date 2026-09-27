const assert = require('assert');
const { BotAdapter, MemoryStorage, TurnContext } = require('botbuilder');
const { Dialog, TextPrompt, WaterfallDialog } = require('botbuilder-dialogs');
const { Botkit, BotkitConversation } = require('../');

/**
 * A minimal in-memory adapter that runs every turn through the full Botkit pipeline.
 */
class ProbeAdapter extends BotAdapter {
    constructor() {
        super();
        this.name = 'Probe';
        this.sent = [];
    }

    init(controller) {
        this.controller = controller;
    }

    async sendActivities(context, activities) {
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

    context(partial) {
        return new TurnContext(this, { type: 'message', channelId: 'probe', conversation: { id: 'c1' }, from: { id: 'u1' }, recipient: { id: 'bot' }, ...partial });
    }

    async run(context) {
        await this.runMiddleware(context, this.controller.handleTurn.bind(this.controller));
        return context;
    }

    async turn(partial) {
        return this.run(this.context(partial));
    }
}

/**
 * MemoryStorage that counts writes.
 */
class SpyStorage extends MemoryStorage {
    constructor() {
        super();
        this.writeCount = 0;
    }

    async write(changes) {
        this.writeCount++;
        return super.write(changes);
    }
}

describe('Botkit getPendingQuestion', function() {
    let adapter;
    let controller;
    let storage;
    let results;

    const addReleaseDialog = (options = {}) => {
        const rel = new BotkitConversation('rel', controller);
        if (options.greeting) {
            rel.say('Let us ship it.');
        }
        rel.ask({
            text: 'Which env?',
            quick_replies: [{ title: 'Staging', payload: 'staging' }, { title: 'Production', payload: 'production' }]
        }, [
            {
                pattern: '^production$',
                handler: async (answer, convo) => convo.gotoThread('confirm')
            },
            {
                default: true,
                handler: async () => {
                    // any other answer completes the dialog
                }
            }
        ], 'env');
        rel.addQuestion('Service?', [], 'service', 'confirm');
        controller.addDialog(rel);
        controller.afterDialog('rel', async (bot, dialogResults) => {
            results = dialogResults;
        });
        controller.hears('release', 'message', async (bot, message) => {
            await bot.beginDialog('rel', message.value);
        });
        return rel;
    };

    beforeEach(function() {
        results = undefined;
        storage = new SpyStorage();
        adapter = new ProbeAdapter();
        controller = new Botkit({ adapter, storage, disable_webserver: true, disable_console: true });
    });

    afterEach(async function() {
        await controller.shutdown();
    });

    it('should return null when no dialog is active', async function() {
        controller.hears('hello', 'message', async (bot, message) => {
            await bot.reply(message, 'hi');
        });

        const context = await adapter.turn({ text: 'hello' });
        assert.strictEqual(await controller.getPendingQuestion(context), null);

        // a conversation that has never been seen has nothing waiting either
        assert.strictEqual(await controller.getPendingQuestion(new TurnContext(adapter, {
            type: 'message', channelId: 'probe', conversation: { id: 'never' }, from: { id: 'nobody' }
        })), null);
    });

    it('should describe the question a dialog is waiting on', async function() {
        addReleaseDialog();

        const context = await adapter.turn({ text: 'release' });
        const question = await controller.getPendingQuestion(context);

        assert(question, 'a question should be pending');
        assert.strictEqual(question.dialog, 'rel');
        assert.strictEqual(question.thread, 'default');
        assert.strictEqual(question.index, 0);
        assert.strictEqual(question.key, 'env');
        assert.strictEqual(question.template.text, 'Which env?');
        assert.strictEqual(question.template.quick_replies.length, 2);
        assert.strictEqual(question.template.collect.key, 'env');
        assert.strictEqual(question.vars.user, 'u1');
        assert.strictEqual(question.vars.channel, 'c1');
        assert.deepStrictEqual(question.stack, ['rel:botkit-wrapper', 'rel', 'rel_default_prompt']);
    });

    it('should report the index of the question after earlier messages', async function() {
        addReleaseDialog({ greeting: true });

        const context = await adapter.turn({ text: 'release' });
        const question = await controller.getPendingQuestion(context);

        assert.strictEqual(question.index, 1);
        assert.strictEqual(question.key, 'env');
    });

    it('should follow the dialog into another thread', async function() {
        addReleaseDialog();

        await adapter.turn({ text: 'release' });
        const context = await adapter.turn({ text: 'production' });
        const question = await controller.getPendingQuestion(context);

        assert.strictEqual(question.dialog, 'rel');
        assert.strictEqual(question.thread, 'confirm');
        assert.strictEqual(question.index, 0);
        assert.strictEqual(question.key, 'service');
        assert.strictEqual(question.vars.env, 'production');
    });

    it('should return a question with an undefined key when ask() has no key', async function() {
        const convo = new BotkitConversation('nokey', controller);
        convo.ask('Anything to add?', [], null);
        controller.addDialog(convo);
        controller.hears('start', 'message', async (bot) => bot.beginDialog('nokey'));

        const context = await adapter.turn({ text: 'start' });
        const question = await controller.getPendingQuestion(context);

        assert(question, 'a question should be pending');
        assert.strictEqual(question.dialog, 'nokey');
        assert.strictEqual(question.key, undefined);
    });

    it('should return null once the dialog completes', async function() {
        addReleaseDialog();

        await adapter.turn({ text: 'release' });
        const context = await adapter.turn({ text: 'staging' });

        assert.strictEqual(await controller.getPendingQuestion(context), null);
        assert.strictEqual(results.env, 'staging');
    });

    it('should report the child dialog while its question is pending', async function() {
        const child = new BotkitConversation('child', controller);
        child.ask('Child question?', [], 'answer');
        controller.addDialog(child);

        const parent = new BotkitConversation('parent', controller);
        parent.say('Welcome');
        parent.addChildDialog('child', 'childvars');
        parent.say('Done: {{vars.childvars.answer}}');
        controller.addDialog(parent);
        controller.hears('start', 'message', async (bot) => bot.beginDialog('parent'));

        let context = await adapter.turn({ text: 'start' });
        const question = await controller.getPendingQuestion(context);

        assert.strictEqual(question.dialog, 'child');
        assert.strictEqual(question.key, 'answer');
        assert.deepStrictEqual(question.stack, ['parent:botkit-wrapper', 'parent', 'child:botkit-wrapper', 'child', 'child_default_prompt']);

        context = await adapter.turn({ text: 'forty-two' });
        assert.strictEqual(await controller.getPendingQuestion(context), null);
        assert.strictEqual(adapter.sent[adapter.sent.length - 1].text, 'Done: forty-two');
    });

    it('should return null when a non-Botkit dialog is waiting on a prompt', async function() {
        controller.addDialog(new WaterfallDialog('wf', [
            async (step) => step.prompt('tp', 'name?'),
            async (step) => step.endDialog()
        ]));
        controller.dialogSet.add(new TextPrompt('tp'));
        controller.hears('start', 'message', async (bot) => bot.beginDialog('wf'));

        const context = await adapter.turn({ text: 'start' });

        assert.strictEqual(adapter.sent[0].text, 'name?');
        assert.strictEqual(await controller.getPendingQuestion(context), null);
    });

    it('should recognise BotkitConversation-like dialogs without instanceof', async function() {
        // stands in for a BotkitConversation created by a second copy of the botkit package
        class ForeignConversation extends Dialog {
            constructor(id) {
                super(id);
                this.script = { default: [{ text: ['Foreign?'], collect: { key: 'foreign' } }, { action: 'next' }] };
            }

            async beginDialog(dc) {
                dc.activeDialog.state.stepIndex = 0;
                dc.activeDialog.state.values = { origin: 'elsewhere' };
                return Dialog.EndOfTurn;
            }
        }
        controller.addDialog(new ForeignConversation('foreign'));
        controller.hears('start', 'message', async (bot) => bot.beginDialog('foreign'));

        const context = await adapter.turn({ text: 'start' });
        const question = await controller.getPendingQuestion(context);

        assert.strictEqual(question.dialog, 'foreign');
        assert.strictEqual(question.key, 'foreign');
        assert.deepStrictEqual(question.vars, { origin: 'elsewhere' });
    });

    it('should load the same result from storage for a new context', async function() {
        addReleaseDialog();

        const context = await adapter.turn({ text: 'release' });
        const afterTurn = await controller.getPendingQuestion(context);
        const writes = storage.writeCount;

        const fresh = await controller.getPendingQuestion(adapter.context({ text: '' }));

        assert.deepStrictEqual(fresh, afterTurn);
        assert.strictEqual(storage.writeCount, writes, 'reading the pending question must not write state');
        assert.deepStrictEqual(adapter.sent.map((a) => a.text), ['Which env?'], 'reading the pending question must not send anything');
    });

    it('should return copies that cannot change the dialog', async function() {
        addReleaseDialog();

        await adapter.turn({ text: 'release', value: { profile: { name: 'Ann' } } });

        // peek at the question with the same context that then runs the turn,
        // so any change leaking into the loaded state would be saved
        const context = adapter.context({ text: 'staging' });
        const question = await controller.getPendingQuestion(context);
        question.vars.user = 'hacked';
        question.vars.injected = true;
        question.vars.profile.name = 'Eve';
        question.template.text = 'changed';
        question.template.quick_replies.push({ title: 'Dev', payload: 'dev' });
        question.template.collect.key = 'hijacked';
        question.stack.pop();

        await adapter.run(context);

        assert.strictEqual(results.env, 'staging');
        assert.strictEqual(results.user, 'u1');
        assert.strictEqual(results.profile.name, 'Ann');
        assert.strictEqual(results.injected, undefined);
        assert.strictEqual(results.hijacked, undefined);

        // the dialog definition is untouched
        await adapter.turn({ text: 'release' });
        const again = await controller.getPendingQuestion(adapter.context({ text: '' }));
        assert.strictEqual(again.key, 'env');
        assert.strictEqual(again.template.text, 'Which env?');
        assert.strictEqual(again.template.quick_replies.length, 2);
        assert.strictEqual(adapter.sent[adapter.sent.length - 1].channelData.quick_replies.length, 2);
    });

    it('should keep the key during a convo.repeat() validation loop', async function() {
        const convo = new BotkitConversation('age', controller);
        convo.ask('How old are you?', [
            {
                pattern: '^\\d+$',
                handler: async () => {
                    // valid answer
                }
            },
            {
                default: true,
                handler: async (answer, convo, bot) => {
                    await bot.say('Please answer with a number.');
                    await convo.repeat();
                }
            }
        ], 'age');
        controller.addDialog(convo);
        let ageResults;
        controller.afterDialog('age', async (bot, dialogResults) => {
            ageResults = dialogResults;
        });
        controller.hears('start', 'message', async (bot) => bot.beginDialog('age'));

        await adapter.turn({ text: 'start' });
        const context = await adapter.turn({ text: 'old enough' });
        const question = await controller.getPendingQuestion(context);

        assert.strictEqual(question.key, 'age');
        assert.strictEqual(question.index, 0);
        assert.deepStrictEqual(adapter.sent.map((a) => a.text), ['How old are you?', 'Please answer with a number.', 'How old are you?']);

        await adapter.turn({ text: '42' });
        assert.strictEqual(ageResults.age, '42');
    });

    it('should report a question held open by a wait action', async function() {
        const convo = new BotkitConversation('waiting', controller);
        convo.ask('Ready?', [
            { pattern: 'later', action: 'wait' },
            {
                default: true,
                handler: async () => {
                    // any other answer completes the dialog
                }
            }
        ], 'ready');
        controller.addDialog(convo);
        controller.hears('start', 'message', async (bot) => bot.beginDialog('waiting'));

        await adapter.turn({ text: 'start' });
        let context = await adapter.turn({ text: 'later' });
        const question = await controller.getPendingQuestion(context);

        // no prompt is on the stack, but the next message still answers the question
        assert.deepStrictEqual(question.stack, ['waiting:botkit-wrapper', 'waiting']);
        assert.strictEqual(question.key, 'ready');

        context = await adapter.turn({ text: 'yes' });
        assert.strictEqual(await controller.getPendingQuestion(context), null);
    });

    it('should return null while the dialog is not stopped on a question', async function() {
        let observed = 'not called';
        const convo = new BotkitConversation('statement', controller);
        convo.say('One moment...');
        convo.before('default', async (convo, bot) => {
            // the dialog is on the stack, but on a statement rather than a question
            observed = await controller.getPendingQuestion(bot.getConfig('context'));
        });
        controller.addDialog(convo);
        controller.hears('start', 'message', async (bot) => bot.beginDialog('statement'));

        await adapter.turn({ text: 'start' });
        assert.strictEqual(observed, null);
    });

    describe('templates', function() {
        it('should render string arrays in channelData instead of failing the prompt', async function() {
            const convo = new BotkitConversation('q', controller);
            convo.ask({ text: 'Q', channelData: { tags: ['a', '{{vars.x}}'] } }, [], 'q');
            controller.addDialog(convo);
            controller.hears('start', 'message', async (bot) => bot.beginDialog('q', { x: 'X' }));

            const context = await adapter.turn({ text: 'start' });

            assert(!adapter.sent.some((a) => a.text === 'Failed to start prompt q_default_prompt'), 'the prompt should start');
            assert.strictEqual(adapter.sent.length, 1);
            assert.strictEqual(adapter.sent[0].text, 'Q');
            assert.deepStrictEqual(adapter.sent[0].channelData.tags, ['a', 'X']);

            // the pending question exposes the raw, un-rendered template
            const question = await controller.getPendingQuestion(context);
            assert.deepStrictEqual(question.template.channelData.tags, ['a', '{{vars.x}}']);
        });

        it('should render strings nested in arrays and leave other values unchanged', async function() {
            const convo = new BotkitConversation('nested', controller);
            convo.say({
                text: ['S'],
                channelData: {
                    mixed: ['{{vars.x}}', 2, true, null],
                    nested: [['{{vars.x}}', { label: '{{vars.x}}' }]],
                    url: ['{{{vars.url}}}']
                },
                attachments: [{ contentType: 'test', content: { items: ['{{vars.x}}'] } }]
            });
            controller.addDialog(convo);
            controller.hears('start', 'message', async (bot) => bot.beginDialog('nested', { x: 'X', url: 'https://example.com/?a=1&b=2' }));

            await adapter.turn({ text: 'start' });

            const sent = adapter.sent[0];
            assert.deepStrictEqual(sent.channelData.mixed, ['X', 2, true, null]);
            assert.deepStrictEqual(sent.channelData.nested, [['X', { label: 'X' }]]);
            assert.deepStrictEqual(sent.channelData.url, ['https://example.com/?a=1&b=2']);
            assert.deepStrictEqual(sent.attachments[0].content.items, ['X']);
        });
    });
});
