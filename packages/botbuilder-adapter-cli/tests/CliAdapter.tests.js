const assert = require('assert');
const { PassThrough } = require('stream');
const { BotkitConversation } = require('botkit');
const { CliAdapter, CliBotWorker, stripAnsi } = require('../');
const { setup, deferred, lines, tick } = require('./shared');

const ESC = '\u001b';

/**
 * Wait until lines written to the input stream have been read and processed.
 */
async function settle(adapter) {
    await tick();
    await adapter.idle();
}

/**
 * A release dialog: pick an environment; production asks for confirmation in the 'confirm' thread.
 */
function addRelease(controller) {
    const rel = new BotkitConversation('rel', controller);
    rel.ask({
        text: ['Which environment?'],
        quick_replies: [{ title: 'Staging', payload: 'staging' }, { title: 'Production', payload: 'production' }]
    }, [
        {
            pattern: '^production$',
            handler: async (answer, convo) => {
                await convo.gotoThread('confirm');
            }
        },
        {
            default: true,
            handler: async (answer, convo, bot) => {
                await bot.say(`Deploying to ${ answer }.`);
            }
        }
    ], 'env');
    rel.addQuestion({ text: ['Type the service name to confirm a PRODUCTION deploy'] }, async (answer, convo, bot) => {
        await bot.say(`Deploying ${ answer } to production.`);
    }, 'service', 'confirm');
    controller.addDialog(rel);
    controller.hears('release', 'message', async (bot) => {
        await bot.beginDialog('rel');
    });
    return rel;
}

describe('CliAdapter', function() {
    let env;
    let adapter;
    let controller;

    const init = (options) => {
        env = setup(options);
        adapter = env.adapter;
        controller = env.controller;
        return env;
    };

    afterEach(async function() {
        if (controller) {
            await controller.shutdown();
        }
        env = adapter = controller = undefined;
    });

    describe('turns', function() {
        it('should run a message through hears and return the reply lines', async function() {
            init();
            let seen;
            controller.hears('hello', 'message', async (bot, message) => {
                seen = message;
                await bot.say('Hi Ann!');
            });
            const result = await adapter.submit('hello');
            assert.deepStrictEqual(result, ['bot> Hi Ann!']);
            assert.strictEqual(env.out(), 'you> hello\nbot> Hi Ann!\n');
            assert.strictEqual(seen.user, 'ann');
            assert.strictEqual(seen.channel, 'c1');
            assert.strictEqual(seen.incoming_message.channelId, 'cli');
            assert.strictEqual(seen.incoming_message.recipient.id, 'bot');
            assert.ok(/^cli-in-\d+$/.test(seen.incoming_message.id));
            assert.ok(seen.incoming_message.timestamp instanceof Date);
        });

        it('should spawn CliBotWorkers', async function() {
            init();
            let worker;
            controller.hears('who', 'message', async (bot, message) => {
                worker = bot;
                await bot.reply(message, `You are ${ bot.cli.user } in ${ bot.cli.conversationId }`);
            });
            assert.deepStrictEqual(await adapter.submit('who'), ['bot> You are ann in c1']);
            assert.ok(worker instanceof CliBotWorker);
            assert.strictEqual(worker.cli, adapter);
        });

        it('should render quick replies as a menu and map numbers and titles to their values', async function() {
            init();
            addRelease(controller);
            assert.deepStrictEqual(await adapter.submit('release'), ['bot> Which environment?', '     [1] Staging  [2] Production']);
            assert.deepStrictEqual(await adapter.submit('2'), ['bot> Type the service name to confirm a PRODUCTION deploy']);
            assert.deepStrictEqual(await adapter.submit('billing'), ['bot> Deploying billing to production.']);

            assert.deepStrictEqual(await adapter.submit('/new'), [`     (new conversation ${ adapter.conversationId })`]);
            assert.notStrictEqual(adapter.conversationId, 'c1');
            assert.deepStrictEqual(await adapter.submit('release'), ['bot> Which environment?', '     [1] Staging  [2] Production']);
            assert.deepStrictEqual(await adapter.submit('PRODUCTION'), ['bot> Type the service name to confirm a PRODUCTION deploy']);
        });

        it('should describe a mapped choice in message.cli_choice', async function() {
            init();
            let choice;
            controller.hears('pick', 'message', async (bot) => {
                await bot.say({ text: 'Pick one', quick_replies: [{ title: 'Alpha', payload: 'a' }, { title: 'Beta', payload: 'b' }] });
            });
            controller.hears('^b$', 'message', async (bot, message) => {
                choice = message;
                await bot.say('picked b');
            });
            assert.deepStrictEqual(await adapter.submit('pick'), ['bot> Pick one', '     [1] Alpha  [2] Beta']);
            assert.deepStrictEqual(await adapter.submit('2'), ['bot> picked b']);
            assert.strictEqual(choice.text, 'b');
            assert.strictEqual(choice.value, 'b');
            assert.deepStrictEqual(choice.cli_choice, { index: 1, title: 'Beta', value: 'b' });

            // the menu is forgotten after a turn with no pending question and no new choices
            assert.deepStrictEqual(await adapter.submit('2'), []);
        });

        it('should send a backslash-escaped line literally', async function() {
            init();
            addRelease(controller);
            const heard = [];
            controller.hears(/^2$/, 'message', async (bot, message) => {
                heard.push(message.text);
            });
            await adapter.submit('release');
            assert.deepStrictEqual(await adapter.submit('\\2'), ['bot> Deploying to 2.']);
            assert.deepStrictEqual(heard, []);
            assert.ok(env.out().includes('you> \\2\n'));

            await adapter.submit('\\/help');
            assert.ok(!env.out().includes('Commands:'));
        });

        it('should pass numbers through unchanged when no menu is showing', async function() {
            init();
            const heard = [];
            controller.hears(/^2$/, 'message', async (bot, message) => {
                heard.push(message.text);
            });
            await adapter.submit('2');
            assert.deepStrictEqual(heard, ['2']);
        });

        it('should not map a number that is out of range', async function() {
            init();
            addRelease(controller);
            await adapter.submit('release');
            assert.deepStrictEqual(await adapter.submit('3'), ['bot> Deploying to 3.']);
        });

        it('should answer with the default on an empty line', async function() {
            init();
            let results;
            const db = new BotkitConversation('db', controller);
            db.ask({
                text: ['Which database?'],
                quick_replies: [{ title: 'PostgreSQL', payload: 'postgres' }, { title: 'SQLite', payload: 'sqlite' }],
                channelData: { default: 'sqlite' }
            }, [], 'db');
            controller.addDialog(db);
            controller.afterDialog('db', async (bot, vars) => {
                results = vars;
            });
            controller.hears('db', 'message', async (bot) => {
                await bot.beginDialog('db');
            });

            assert.deepStrictEqual(await adapter.submit('db'), ['bot> Which database?', '     [1] PostgreSQL  [2] SQLite (default)']);
            await adapter.submit('');
            assert.strictEqual(results.db, 'sqlite');
            assert.ok(env.out().includes('you> sqlite (default)\n'));
        });

        it('should ignore an empty line when there is no default', async function() {
            init();
            let received = 0;
            controller.middleware.receive.use((bot, message, next) => {
                received++;
                next();
            });
            assert.deepStrictEqual(await adapter.submit(''), []);
            assert.deepStrictEqual(await adapter.submit('   '), []);
            assert.strictEqual(received, 0);
            assert.strictEqual(env.out(), '');
            await adapter.submit('x');
            assert.strictEqual(received, 1);
        });

        it('should forget a menu once the dialog moves on to a question without choices', async function() {
            init();
            let results;
            const two = new BotkitConversation('two', controller);
            two.ask({ text: ['Color?'], quick_replies: [{ title: 'Red', payload: 'red' }, { title: 'Blue', payload: 'blue' }] }, [], 'color');
            two.ask('How many?', [], 'count');
            controller.addDialog(two);
            controller.afterDialog('two', async (bot, vars) => {
                results = vars;
            });
            controller.hears('two', 'message', async (bot) => {
                await bot.beginDialog('two');
            });
            await adapter.submit('two');
            assert.deepStrictEqual(await adapter.submit('1'), ['bot> How many?']);
            await adapter.submit('1');
            assert.strictEqual(results.color, 'red');
            assert.strictEqual(results.count, '1');
        });

        it('should unescape URLs that mustache escaped in dialog templates', async function() {
            init();
            const link = new BotkitConversation('link', controller);
            link.say('Visit {{vars.url}}');
            controller.addDialog(link);
            controller.hears('link', 'message', async (bot) => {
                await bot.beginDialog('link', { url: 'https://a.b/c?d=1' });
            });
            assert.deepStrictEqual(await adapter.submit('link'), ['bot> Visit https://a.b/c?d=1']);
        });

        it('should show progress events, hide typing and honor delays', async function() {
            init();
            controller.hears('migrate', 'message', async (bot) => {
                await bot.say({ type: 'typing' });
                await bot.progress(3, 10, 'Migrating');
            });
            controller.hears('wait', 'message', async (bot) => {
                await bot.say({ type: 'delay', value: 50 });
            });
            assert.deepStrictEqual(await adapter.submit('migrate'), ['     [###-------] 30% Migrating']);

            let started = Date.now();
            assert.deepStrictEqual(await adapter.submit('wait'), []);
            assert.ok(Date.now() - started < 40, 'delays are skipped when honorDelays is false');

            await controller.shutdown();
            init({ honorDelays: true, maxDelay: 60 });
            controller.hears('wait', 'message', async (bot) => {
                await bot.say({ type: 'delay', value: 50 });
                await bot.say({ type: 'delay', value: 100000 });
            });
            started = Date.now();
            await adapter.submit('wait');
            const elapsed = Date.now() - started;
            assert.ok(elapsed >= 45 + 55, `expected at least 100ms, took ${ elapsed }ms`);
        });

        it('should print update and delete notices', async function() {
            init();
            controller.hears('edit', 'message', async (bot, message) => {
                await message.context.updateActivity({ id: 'cli-out-1', text: 'Fixed &amp; better' });
                await message.context.deleteActivity('cli-out-2');
            });
            assert.deepStrictEqual(await adapter.submit('edit'), ['bot> (edited) Fixed & better', '     (deleted message cli-out-2)']);
        });

        it('should write update and delete notices as JSON in json format', async function() {
            init({ format: 'json' });
            controller.hears('edit', 'message', async (bot, message) => {
                await message.context.updateActivity({ id: 'cli-out-1', text: 'Fixed' });
                await message.context.deleteActivity('cli-out-2');
            });
            const result = (await adapter.submit('edit')).map((line) => JSON.parse(line));
            assert.deepStrictEqual(result, [
                { type: 'messageUpdate', id: 'cli-out-1', text: 'Fixed', conversation: 'c1' },
                { type: 'messageDelete', id: 'cli-out-2', conversation: 'c1' }
            ]);
        });

        it('should return ids for sent activities', async function() {
            init();
            let responses;
            controller.hears('ids', 'message', async (bot) => {
                responses = [await bot.say('a'), await bot.say({ type: 'typing' })];
            });
            await adapter.submit('ids');
            assert.ok(/^cli-out-\d+$/.test(responses[0].id));
            assert.ok(/^cli-out-\d+$/.test(responses[1].id));
            assert.notStrictEqual(responses[0].id, responses[1].id);
        });

        it('should keep conversation state separate for each user', async function() {
            init();
            addRelease(controller);
            let hello;
            controller.hears('hello', 'message', async (bot, message) => {
                hello = message.user;
                await bot.say(`Hi ${ message.user }!`);
            });
            await adapter.submit('release');
            assert.deepStrictEqual(await adapter.submit('/as bob'), ['     (you are now bob)']);
            assert.strictEqual(adapter.user, 'bob');
            assert.deepStrictEqual(await adapter.submit('hello'), ['bot> Hi bob!']);
            assert.strictEqual(hello, 'bob');

            await adapter.submit('/as ann');
            assert.deepStrictEqual(await adapter.submit('1'), ['bot> Deploying to staging.']);
        });
    });

    describe('commands', function() {
        it('should start a new conversation with /new', async function() {
            init();
            addRelease(controller);
            let hello = 0;
            controller.hears('hello', 'message', async () => {
                hello++;
            });
            await adapter.submit('release');
            assert.deepStrictEqual(await adapter.submit('/state'), ['     waiting in dialog "rel" (thread default) for "env"', '     vars: {}']);

            assert.deepStrictEqual(await adapter.submit('/new ops-2'), ['     (new conversation ops-2)']);
            assert.strictEqual(adapter.conversationId, 'ops-2');
            assert.deepStrictEqual(await adapter.submit('/state'), ['     no dialog is waiting for input']);
            await adapter.submit('hello');
            assert.strictEqual(hello, 1);
        });

        it('should show collected vars with /state', async function() {
            init();
            const two = new BotkitConversation('pair', controller);
            two.ask('First?', [], 'first');
            two.ask('Second?', [], 'second');
            controller.addDialog(two);
            controller.hears('pair', 'message', async (bot) => {
                await bot.beginDialog('pair', { app: 'acme' });
            });
            await adapter.submit('pair');
            await adapter.submit('one');
            assert.deepStrictEqual(await adapter.submit('/state'), [
                '     waiting in dialog "pair" (thread default) for "second"',
                '     vars: {"app":"acme","first":"one"}'
            ]);
        });

        it('should send events with /event', async function() {
            init();
            let event;
            controller.on('build_finished', async (bot, message) => {
                event = message;
                await bot.say(`Build ${ message.build }: ${ message.value.status }`);
            });
            const result = await adapter.submit('/event build_finished {"build":"#412","status":"green"}');
            assert.deepStrictEqual(result, ['bot> Build #412: green']);
            assert.strictEqual(event.type, 'build_finished');
            assert.strictEqual(event.build, '#412');
            assert.strictEqual(event.value.status, 'green');
            assert.strictEqual(event.incoming_message.type, 'event');
            assert.strictEqual(event.incoming_message.name, 'build_finished');
        });

        it('should send events with non-object and missing payloads', async function() {
            init();
            const events = [];
            controller.on('ping', async (bot, message) => {
                events.push(message.value);
            });
            await adapter.submit('/event ping');
            await adapter.submit('/event ping [1,2]');
            await adapter.submit('/event ping 42');
            assert.deepStrictEqual(events, [undefined, [1, 2], 42]);
        });

        it('should report invalid JSON and missing names without running a turn', async function() {
            init();
            let received = 0;
            controller.middleware.receive.use((bot, message, next) => {
                received++;
                next();
            });
            assert.deepStrictEqual(await adapter.submit('/event x {bad'), []);
            assert.ok(env.err().includes('error: invalid JSON'));
            await adapter.submit('/event');
            assert.ok(env.err().includes('usage: /event <name> [json]'));
            await adapter.submit('/json nope');
            await adapter.submit('/json [1]');
            assert.ok(env.err().includes('/json expects a JSON object'));
            await adapter.submit('/as');
            assert.ok(env.err().includes('usage: /as <user>'));
            assert.strictEqual(received, 0);
        });

        it('should warn when an event would be consumed by a pending question', async function() {
            init();
            addRelease(controller);
            await adapter.submit('release');
            const result = await adapter.submit('/event ping');
            assert.strictEqual(result[0], '     (note: a question is pending; this event will be consumed as its answer unless you handle "ping" with controller.interrupts())');
        });

        it('should show the last activity with /raw', async function() {
            init();
            assert.deepStrictEqual(await adapter.submit('/raw'), ['     (nothing sent yet)']);
            controller.hears('hello', 'message', async (bot) => {
                await bot.say({ text: 'Hi', extra: 42 });
                await bot.say({ type: 'typing' });
            });
            await adapter.submit('hello');
            const raw = await adapter.submit('/raw');
            assert.strictEqual(raw.length, 1);
            const activity = JSON.parse(raw[0].trim());
            assert.strictEqual(activity.text, 'Hi');
            assert.strictEqual(activity.channelData.extra, 42);
            assert.strictEqual(activity.recipient.id, 'ann');
            assert.strictEqual(activity.conversation.id, 'c1');
        });

        it('should send an activity with /json using the adapter address', async function() {
            init();
            let seen;
            controller.hears('hello', 'message', async (bot, message) => {
                seen = message;
            });
            await adapter.submit('/json {"text":"hello","from":{"id":"mallory"},"channelId":"x","channelData":{"x":1}}');
            assert.strictEqual(seen.user, 'ann');
            assert.strictEqual(seen.channel, 'c1');
            assert.strictEqual(seen.incoming_message.channelId, 'cli');
            assert.strictEqual(seen.x, 1);
        });

        it('should run custom commands and list them in /help', async function() {
            const calls = [];
            init({
                commands: {
                    deploy: { description: 'Deploy a service', run: async (args, cli) => { calls.push(cli); return 'ok ' + args; } },
                    multi: () => ['one', 'two'],
                    quiet: () => undefined
                }
            });
            let nope;
            controller.hears('/nope', 'message', async (bot, message) => {
                nope = message.text;
            });
            assert.deepStrictEqual(await adapter.submit('/deploy api'), ['     ok api']);
            assert.strictEqual(calls[0], adapter);
            assert.deepStrictEqual(await adapter.submit('/multi'), ['     one', '     two']);
            assert.deepStrictEqual(await adapter.submit('/quiet'), []);

            const help = await adapter.submit('/help');
            assert.strictEqual(help[0], '     Commands:');
            assert.ok(help.some((line) => /^ +\/deploy +Deploy a service$/.test(line)));
            assert.ok(help.some((line) => /^ +\/multi$/.test(line)));
            assert.ok(help.some((line) => line.includes('/event <name> [json]')));

            await adapter.submit('/nope');
            assert.strictEqual(nope, '/nope');
        });

        it('should not treat Object.prototype names as commands', async function() {
            init();
            let text;
            controller.on('message', async (bot, message) => {
                text = message.text;
            });
            await adapter.submit('/constructor');
            assert.strictEqual(text, '/constructor');
        });

        it('should reject invalid command definitions', async function() {
            assert.throws(() => new CliAdapter({ commands: { bad: { description: 'no run' } } }), /must be a function or an object with a run\(\) function/);
            assert.throws(() => new CliAdapter({ commands: { '2fa': () => 'x' } }), /must start with a letter/);
            assert.throws(() => new CliAdapter({ commands: { 'a b': () => 'x' } }), /must start with a letter/);
            assert.throws(() => new CliAdapter({ format: 'xml' }), /Unknown CliAdapter format "xml"/);
        });

        it('should reject a failing custom command like a failing turn', async function() {
            init({ commands: { boom: () => { throw new Error('bad command'); } } });
            await assert.rejects(adapter.submit('/boom'), /bad command/);
        });
    });

    describe('formats and output', function() {
        it('should write one JSON object per line in json format', async function() {
            init({ format: 'json' });
            addRelease(controller);
            controller.hears('hello', 'message', async (bot) => {
                await bot.say({ type: 'typing' });
                await bot.say('Hi');
            });
            const result = await adapter.submit('release');
            assert.strictEqual(result.length, 1);
            const parsed = result.map((line) => JSON.parse(line));
            assert.deepStrictEqual(parsed[0], {
                type: 'message',
                text: 'Which environment?',
                choices: [{ title: 'Staging', value: 'staging' }, { title: 'Production', value: 'production' }],
                to: 'ann',
                conversation: 'c1'
            });
            await adapter.submit('2');
            await adapter.submit('/new j1');
            await adapter.submit('/help');
            await adapter.submit('hello');
            const output = lines(env.out());
            output.forEach((line) => JSON.parse(line));
            assert.ok(!env.out().includes('you>'));
            const commands = output.map((line) => JSON.parse(line)).filter((obj) => obj.type === 'cli');
            assert.deepStrictEqual(commands[0], { type: 'cli', command: 'new', lines: ['(new conversation j1)'] });
            assert.strictEqual(commands[1].command, 'help');
        });

        it('should add colors that strip back to the plain output', async function() {
            const register = (c) => {
                addRelease(c);
            };
            init({ color: true });
            register(controller);
            const colored = env;
            await adapter.submit('release');
            await adapter.submit('/new x');
            await colored.controller.shutdown();

            init({ color: false });
            register(controller);
            await adapter.submit('release');
            await adapter.submit('/new x');

            assert.ok(colored.out().includes(`${ ESC }[`));
            assert.ok(!env.out().includes(`${ ESC }[`));
            assert.strictEqual(stripAnsi(colored.out()), env.out());
        });

        it('should print errors in red when color is on', async function() {
            init({ color: true });
            await adapter.submit('/event x {');
            assert.ok(env.err().startsWith(`${ ESC }[31merror: invalid JSON`));
        });

        it('should print proactive messages but not return them from submit', async function() {
            init();
            controller.hears('hello', 'message', async (bot) => {
                await bot.say('Hi');
            });
            const bot = await controller.spawn({}, adapter);
            await bot.startConversationWithUser();
            await bot.say('from timer');
            assert.strictEqual(env.out(), 'bot> from timer\n');
            assert.deepStrictEqual(await adapter.submit('hello'), ['bot> Hi']);

            const other = await controller.spawn({}, adapter);
            await other.startConversationWithUser('bob');
            await other.say('psst');
            assert.ok(env.out().endsWith('bot (to bob)> psst\n'));
        });

        it('should remember the menu of a proactive message', async function() {
            init();
            let choice;
            controller.hears('^b$', 'message', async (bot, message) => {
                choice = message.cli_choice;
            });
            const bot = await controller.spawn({}, adapter);
            await bot.startConversationWithUser();
            await bot.say({ text: 'Approve?', quick_replies: [{ title: 'Approve', payload: 'a' }, { title: 'Block', payload: 'b' }] });
            await adapter.submit('Block');
            assert.deepStrictEqual(choice, { index: 1, title: 'Block', value: 'b' });
        });

        it('should run continueConversation turns immediately, even while a turn is running', async function() {
            init();
            const reference = adapter.getReference();
            assert.deepStrictEqual(reference, {
                channelId: 'cli',
                conversation: { id: 'c1' },
                user: { id: 'ann', name: 'ann' },
                bot: { id: 'bot', name: 'bot' }
            });
            controller.on('reminder', async (bot) => {
                await bot.say('Reminder!');
            });
            controller.hears('nested', 'message', async (bot) => {
                await adapter.continueConversation(reference, async (context) => {
                    context.activity.channelData = { botkitEventType: 'reminder' };
                    await controller.handleTurn(context);
                });
                await bot.say('after');
            });
            assert.deepStrictEqual(await adapter.submit('nested'), ['bot> after']);
            assert.strictEqual(env.out(), 'you> nested\nbot> Reminder!\nbot> after\n');
        });

        it('should answer webhook requests with 405', async function() {
            init();
            const res = {
                headers: {},
                setHeader(name, value) {
                    this.headers[name.toLowerCase()] = value;
                },
                end(body) {
                    this.body = body;
                }
            };
            await adapter.processActivity({ body: {} }, res, async () => {});
            assert.strictEqual(res.statusCode, 405);
            assert.strictEqual(res.headers['content-type'], 'application/json');
            assert.deepStrictEqual(JSON.parse(res.body), { error: 'The CLI adapter does not accept HTTP requests' });
        });

        it('should route console output to errorOutput when redirectConsole is set', async function() {
            const original = console.log;
            init({ redirectConsole: true });
            try {
                assert.notStrictEqual(console.log, original);
                console.log('hello %s', 'world');
                console.info();
                console.dir({ a: 1 });
                assert.ok(env.err().includes('hello world\n\n{ a: 1 }'));
                assert.ok(env.err().includes('{ a: 1 }\n'));
                assert.strictEqual(env.out(), '');
            } finally {
                await controller.shutdown();
            }
            assert.strictEqual(console.log, original);
        });
    });

    describe('input and lifecycle', function() {
        it('should process piped input in order and shut down at the end of input', async function() {
            init({ autoStart: true });
            addRelease(controller);
            controller.afterDialog('rel', async (bot, vars) => {
                await bot.say(`sentinel: ${ vars.env } ${ vars.service }`);
            });
            let shutdowns = 0;
            const done = deferred();
            controller.on('shutdown', async () => {
                shutdowns++;
                done.resolve();
            });

            env.input.write('release\n2\nbilling\n');
            env.input.end();
            await done.promise;

            assert.deepStrictEqual(lines(env.out()), [
                'you> release',
                'bot> Which environment?',
                '     [1] Staging  [2] Production',
                'you> 2',
                'bot> Type the service name to confirm a PRODUCTION deploy',
                'you> billing',
                'bot> Deploying billing to production.',
                'bot> sentinel: production billing'
            ]);
            assert.strictEqual(shutdowns, 1);
        });

        it('should not shut Botkit down at the end of input when shutdownOnClose is false', async function() {
            init({ shutdownOnClose: false });
            let shutdowns = 0;
            controller.on('shutdown', async () => {
                shutdowns++;
            });
            const run = adapter.run();
            env.input.end();
            assert.deepStrictEqual(await run, { status: 'eof', exitCode: 0 });
            assert.strictEqual(shutdowns, 0);
        });

        it('should print errors from typed lines and keep going', async function() {
            init();
            controller.hears('boom', 'message', async () => {
                throw new Error('kaboom');
            });
            controller.hears('hello', 'message', async (bot) => {
                await bot.say('Hi Ann!');
            });
            await assert.rejects(adapter.submit('boom'), /kaboom/);
            assert.strictEqual(env.err(), '');

            adapter.start();
            env.input.write('boom\nhello\n');
            await settle(adapter);
            assert.strictEqual(env.err(), 'error: kaboom\n');
            assert.ok(env.out().endsWith('you> boom\nyou> hello\nbot> Hi Ann!\n'));
        });

        it('should print stacks in verbose mode', async function() {
            init({ verbose: true });
            controller.hears('boom', 'message', async () => {
                throw new Error('kaboom');
            });
            adapter.start();
            env.input.write('boom\n');
            await settle(adapter);
            assert.ok(env.err().startsWith('error: kaboom\nError: kaboom\n    at '));
        });

        it('should time out a turn that never finishes and keep going', async function() {
            init({ turnTimeout: 50 });
            controller.hears('hang', 'message', async () => {
                await new Promise(() => {});
            });
            controller.hears('hello', 'message', async (bot) => {
                await bot.say('Hi Ann!');
            });
            await assert.rejects(adapter.submit('hang'), (err) => err.name === 'TurnTimeoutError' && err.message === 'Turn timed out after 50ms');

            adapter.start();
            env.input.write('hang\nhello\n');
            await settle(adapter);
            assert.ok(/timed out after 50ms/.test(env.err()));
            assert.ok(env.out().endsWith('bot> Hi Ann!\n'));
        });

        it('should send one greeting when it starts', async function() {
            init({ autoStart: true, greeting: true });
            const updates = [];
            controller.on('conversationUpdate', async (bot, message) => {
                updates.push(message);
                await bot.say('Welcome!');
            });
            await tick();
            await settle(adapter);
            adapter.start();
            await settle(adapter);
            assert.strictEqual(updates.length, 1);
            assert.strictEqual(updates[0].incoming_message.membersAdded[0].id, 'ann');
            assert.strictEqual(updates[0].user, 'ann');
            assert.strictEqual(env.out(), 'bot> Welcome!\n');
        });

        it('should stop reading input when Botkit shuts down', async function() {
            init();
            let heard = 0;
            controller.hears('hello', 'message', async () => {
                heard++;
            });
            adapter.start();
            await controller.shutdown();
            env.input.write('hello\n');
            await settle(adapter);
            assert.strictEqual(heard, 0);
            await assert.rejects(adapter.submit('hello'), /The CLI session is closed/);
        });

        it('should drop queued input and end the session on /quit', async function() {
            init();
            let shutdowns = 0;
            controller.on('shutdown', async () => {
                shutdowns++;
            });
            const quit = adapter.submit('/quit');
            const after = adapter.submit('hello');
            assert.deepStrictEqual(await quit, []);
            await assert.rejects(after, /The CLI session is closed/);
            await tick();
            assert.strictEqual(shutdowns, 1);
        });

        it('should end the session quietly when the output pipe closes', async function() {
            init();
            const run = adapter.run();
            const error = new Error('write EPIPE');
            error.code = 'EPIPE';
            env.output.emit('error', error);
            assert.deepStrictEqual(await run, { status: 'eof', exitCode: 0 });
            assert.strictEqual(env.err(), '');
        });

        it('should show a prompt in terminal mode and end on Ctrl+C', async function() {
            init({ terminal: true });
            controller.hears('hello', 'message', async (bot) => {
                await bot.say('Hi');
            });
            const run = adapter.run();
            await tick();
            // readline draws the prompt with cursor movement sequences
            assert.ok(env.out().includes('you> '));
            env.input.write('hello\r');
            await settle(adapter);
            assert.ok(env.out().includes('bot> Hi\n'));
            assert.ok(!env.out().includes('you> hello\n'), 'typed lines are not echoed in terminal mode');
            env.input.write('\u0003');
            assert.deepStrictEqual(await run, { status: 'interrupted', exitCode: 130 });
        });

        it('should redraw the prompt and partial input around proactive messages in terminal mode', async function() {
            init({ terminal: true });
            adapter.start();
            await tick();
            env.input.write('hel');
            await tick();
            const before = env.out().length;
            const bot = await controller.spawn({}, adapter);
            await bot.startConversationWithUser();
            await bot.say('Build finished');
            const written = env.out().slice(before);
            // clear the line, move to column 1, print the message, then redraw the prompt with the typed text
            assert.ok(written.startsWith(`${ ESC }[2K${ ESC }[1Gbot> Build finished\n`), JSON.stringify(written));
            assert.ok(written.endsWith(`you> hel${ ESC }[9G`), JSON.stringify(written));
        });

        it('should complete slash-commands with Tab in terminal mode', async function() {
            init({ terminal: true, commands: { deploy: () => 'deploying' } });
            adapter.start();
            await tick();
            env.input.write('/dep\t');
            await tick();
            env.input.write('\r');
            await settle(adapter);
            assert.ok(env.out().includes('     deploying\n'), JSON.stringify(env.out()));
            env.input.write('/he\t');
            await tick();
            env.input.write('\r');
            await settle(adapter);
            assert.ok(env.out().includes('     Commands:\n'));
            env.input.end();
            await tick();
            assert.ok(env.out().endsWith('\n'));
        });

        it('should announce defaults in terminal mode', async function() {
            init({ terminal: true });
            const db = new BotkitConversation('db', controller);
            db.ask({ text: ['Which database?'], channelData: { default: 'sqlite' } }, [], 'db');
            controller.addDialog(db);
            let results;
            controller.afterDialog('db', async (bot, vars) => {
                results = vars;
            });
            controller.hears('db', 'message', async (bot) => {
                await bot.beginDialog('db');
            });
            await adapter.submit('db');
            assert.deepStrictEqual(await adapter.submit(''), []);
            assert.ok(env.out().includes('     (using default: sqlite)\n'));
            assert.strictEqual(results.db, 'sqlite');
        });

        it('should reject turns when the adapter is not used with Botkit', async function() {
            const standalone = new CliAdapter({ input: new PassThrough(), output: new PassThrough(), errorOutput: new PassThrough(), autoStart: false });
            await assert.rejects(standalone.submit('hi'), /works with Botkit only/);
            await assert.rejects(standalone.run(), /works with Botkit only/);
            standalone.close();
        });
    });
});
