const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { PassThrough } = require('stream');
const { BotkitConversation } = require('botkit');
const { setup, lines, tick } = require('./shared');

/**
 * An installer dialog: a database menu and a validated password.
 */
function addSetup(controller, options = {}) {
    const dialog = new BotkitConversation('setup', controller);
    dialog.ask({
        text: ['Which database?'],
        quick_replies: [{ title: 'PostgreSQL', payload: 'postgres' }, { title: 'SQLite', payload: 'sqlite' }],
        channelData: options.defaultDb ? { default: options.defaultDb } : {}
    }, [], 'db');
    dialog.ask('Admin password (8+ chars)?', async (answer, convo, bot) => {
        if (answer.length < 8) {
            await bot.say('Too short.');
            await convo.repeat();
        }
    }, 'password');
    dialog.say('Setting up {{vars.app}} with {{vars.db}}.');
    controller.addDialog(dialog);
    controller.hears('^setup$', 'message', async (bot) => {
        await bot.beginDialog('setup', { app: 'old' });
    });
    return dialog;
}

/**
 * A confirmation dialog whose 'abort' thread stops the dialog and whose 'late' thread times it out.
 */
function addConfirm(controller) {
    const dialog = new BotkitConversation('confirm', controller);
    dialog.ask('Type yes to continue', [
        { pattern: '^yes$', handler: async (answer, convo) => { await convo.gotoThread('go'); } },
        { pattern: '^later$', handler: async (answer, convo) => { await convo.gotoThread('late'); } },
        { default: true, handler: async (answer, convo) => { await convo.gotoThread('abort'); } }
    ], 'ok');
    dialog.addMessage('Going.', 'go');
    dialog.addMessage('Aborting.', 'abort');
    dialog.addAction('stop', 'abort');
    dialog.addAction('timeout', 'late');
    controller.addDialog(dialog);
    return dialog;
}

const count = (text, part) => text.split(part).length - 1;

describe('CliAdapter unattended runs', function() {
    let env;
    let adapter;
    let controller;
    let shutdowns;

    const init = (options) => {
        env = setup(options);
        adapter = env.adapter;
        controller = env.controller;
        shutdowns = 0;
        controller.on('shutdown', async () => {
            shutdowns++;
        });
        return env;
    };

    afterEach(async function() {
        if (controller) {
            await controller.shutdown();
        }
        env = adapter = controller = undefined;
    });

    it('should complete a dialog from the answers map', async function() {
        init({ answers: { db: 'sqlite', password: 'hunter2222' } });
        addSetup(controller);
        const result = await adapter.run({ dialog: 'setup', vars: { app: 'acme' } });

        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.vars.db, 'sqlite');
        assert.strictEqual(result.vars.password, 'hunter2222');
        assert.strictEqual(result.vars.app, 'acme');
        assert.deepStrictEqual(lines(env.out()), [
            'bot> Which database?',
            '     [1] PostgreSQL  [2] SQLite',
            'you> sqlite (from answers)',
            'bot> Admin password (8+ chars)?',
            'you> hunter2222 (from answers)',
            'bot> Setting up acme with sqlite.'
        ]);

        // the session ends with the dialog
        await tick();
        assert.strictEqual(shutdowns, 1);
        await assert.rejects(adapter.submit('hello'), /closed/);
    });

    it('should accept a choice title or number as an answer', async function() {
        init({ answers: { db: 'SQLite', password: 'hunter2222' } });
        addSetup(controller);
        let result = await adapter.run({ dialog: 'setup' });
        assert.strictEqual(result.vars.db, 'sqlite');
        await controller.shutdown();

        init({ answers: { db: '1', password: 'hunter2222' } });
        addSetup(controller);
        result = await adapter.run({ dialog: 'setup' });
        assert.strictEqual(result.vars.db, 'postgres');
    });

    it('should prefer a choice value over a choice number', async function() {
        init({ answers: { n: '2' } });
        const pick = new BotkitConversation('pick', controller);
        pick.ask({ text: ['Pick'], quick_replies: [{ title: 'Two', payload: '2' }, { title: 'One', payload: '1' }] }, [], 'n');
        controller.addDialog(pick);
        const result = await adapter.run({ dialog: 'pick' });
        assert.strictEqual(result.vars.n, '2');
    });

    it('should prefer a choice title over a choice number', async function() {
        init({ answers: { n: '2' } });
        const pick = new BotkitConversation('pick', controller);
        pick.ask({ text: ['Replicas?'], quick_replies: [{ title: '2', payload: 'two' }, { title: '4', payload: 'four' }] }, [], 'n');
        controller.addDialog(pick);
        const result = await adapter.run({ dialog: 'pick' });
        assert.strictEqual(result.vars.n, 'two');
    });

    it('should fail with exit code 2 when an answer is missing in non-interactive mode', async function() {
        init({ answers: { db: 'sqlite' }, nonInteractive: true });
        // no more input will come, as with `< /dev/null`
        env.input.end();
        addSetup(controller);
        const result = await adapter.run({ dialog: 'setup' });
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.exitCode, 2);
        assert.strictEqual(result.vars.db, 'sqlite');
        assert.strictEqual(result.error, undefined);
        assert.strictEqual(env.err(), 'error: Missing answer for "password": Admin password (8+ chars)?\n');
        await tick();
        assert.strictEqual(shutdowns, 1);
    });

    it('should use array answers in order for questions that repeat', async function() {
        init({ answers: { db: 'sqlite', password: ['short', 'longenough1'] } });
        addSetup(controller);
        const result = await adapter.run({ dialog: 'setup' });
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.vars.password, 'longenough1');
        assert.strictEqual(count(env.out(), 'Too short.'), 1);
        assert.strictEqual(count(env.out(), 'bot> Admin password (8+ chars)?'), 2);
    });

    it('should use a string answer only once, so a validation loop cannot spin forever', async function() {
        init({ answers: { db: 'sqlite', password: 'short' }, nonInteractive: true });
        env.input.end();
        addSetup(controller);
        const result = await adapter.run({ dialog: 'setup' });
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.exitCode, 2);
        assert.strictEqual(count(env.out(), 'Too short.'), 1);
        assert.ok(env.err().includes('Missing answer for "password"'));
    });

    it('should use the default for an unanswered question in non-interactive mode', async function() {
        init({ answers: { password: 'hunter2222' }, nonInteractive: true });
        env.input.end();
        addSetup(controller, { defaultDb: 'sqlite' });
        const result = await adapter.run({ dialog: 'setup' });
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.vars.db, 'sqlite');
        assert.ok(env.out().includes('     [1] PostgreSQL  [2] SQLite (default)\nyou> sqlite (default)\n'));
    });

    it('should treat an empty answer as a request for the default', async function() {
        init({ answers: { db: '', password: 'hunter2222' }, nonInteractive: true });
        addSetup(controller, { defaultDb: 'postgres' });
        const result = await adapter.run({ dialog: 'setup' });
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.vars.db, 'postgres');
        assert.ok(env.out().includes('you> postgres (default)\n'));
    });

    it('should treat an empty answer without a default as missing', async function() {
        init({ answers: { db: '  ' }, nonInteractive: true });
        env.input.end();
        addSetup(controller);
        const result = await adapter.run({ dialog: 'setup' });
        assert.deepStrictEqual({ status: result.status, exitCode: result.exitCode }, { status: 'failed', exitCode: 2 });
        assert.ok(env.err().includes('Missing answer for "db": Which database?'));
    });

    it('should accept answers that are not strings', async function() {
        init({ answers: { port: 8080, flags: [true, null, 'x'] } });
        const config = new BotkitConversation('config', controller);
        config.ask('Port?', [], 'port');
        config.ask('Flag?', [], 'flags');
        controller.addDialog(config);
        const result = await adapter.run({ dialog: 'config' });
        assert.strictEqual(result.vars.port, '8080');
        assert.strictEqual(result.vars.flags, 'true');
    });

    it('should complete a dialog that asks no questions in a single turn', async function() {
        init();
        const hello = new BotkitConversation('hello', controller);
        hello.say('Hello {{vars.name}}!');
        controller.addDialog(hello);
        const result = await adapter.run({ dialog: 'hello', vars: { name: 'Ann' } });
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(env.out(), 'bot> Hello Ann!\n');
    });

    it('should answer questions of dialogs started by typed input', async function() {
        init({ answers: { db: 'postgres', password: 'hunter2222' } });
        addSetup(controller);
        let results;
        controller.afterDialog('setup', async (bot, vars) => {
            results = vars;
        });
        await adapter.submit('setup');
        await adapter.idle();
        assert.strictEqual(results.db, 'postgres');
        assert.strictEqual(results.app, 'old');
    });

    it('should let queued input answer before failing in non-interactive mode', async function() {
        init({ nonInteractive: true });
        addSetup(controller);
        let results;
        controller.afterDialog('setup', async (bot, vars) => {
            results = vars;
        });
        const run = adapter.run();
        env.input.write('setup\n2\nhunter2222\n');
        env.input.end();
        assert.deepStrictEqual(await run, { status: 'eof', exitCode: 0 });
        assert.strictEqual(results.db, 'sqlite');
        assert.strictEqual(env.err(), '');
    });

    it('should wait for piped input that has not arrived yet in non-interactive mode', async function() {
        init({ nonInteractive: true });
        addSetup(controller);
        const run = adapter.run({ dialog: 'setup' });
        await adapter.idle();
        await tick();
        // the input is still open, so the first question waits for it instead of failing
        assert.strictEqual(env.err(), '');
        env.input.write('2\n');
        await tick();
        await adapter.idle();
        env.input.write('hunter2222\n');
        const result = await run;
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.vars.db, 'sqlite');
        assert.strictEqual(result.vars.password, 'hunter2222');
        assert.strictEqual(env.err(), '');
    });

    it('should not wait for a person at a terminal in non-interactive mode', async function() {
        const input = new PassThrough();
        input.isTTY = true;
        init({ input, answers: { db: 'sqlite' }, nonInteractive: true });
        addSetup(controller);
        const result = await adapter.run({ dialog: 'setup' });
        assert.deepStrictEqual({ status: result.status, exitCode: result.exitCode }, { status: 'failed', exitCode: 2 });
        assert.ok(env.err().includes('Missing answer for "password"'));
    });

    it('should decide about a question still waiting when the input ends in non-interactive mode', async function() {
        init({ nonInteractive: true });
        addSetup(controller, { defaultDb: 'postgres' });
        const run = adapter.run({ dialog: 'setup' });
        await adapter.idle();
        env.input.write('/state\n');
        env.input.end();
        const result = await run;
        assert.deepStrictEqual({ status: result.status, exitCode: result.exitCode }, { status: 'failed', exitCode: 2 });
        assert.strictEqual(result.vars.db, 'postgres');
        assert.ok(env.out().includes('you> postgres (default)\n'));
        assert.strictEqual(env.err(), 'error: Missing answer for "password": Admin password (8+ chars)?\n');
    });

    it('should not use a default again for a question the dialog asks again', async function() {
        const addPort = () => {
            const dialog = new BotkitConversation('port', controller);
            dialog.ask({ text: ['Port?'], channelData: { default: '80' } }, async (answer, convo, bot) => {
                if (Number(answer) < 1024) {
                    await bot.say('Pick a port >= 1024.');
                    await convo.repeat();
                }
            }, 'port');
            controller.addDialog(dialog);
        };
        init({ nonInteractive: true });
        env.input.end();
        addPort();
        let result = await adapter.run({ dialog: 'port' });
        assert.deepStrictEqual({ status: result.status, exitCode: result.exitCode }, { status: 'failed', exitCode: 2 });
        assert.strictEqual(count(env.out(), 'you> 80 (default)'), 1);
        assert.strictEqual(count(env.out(), 'Pick a port >= 1024.'), 1);
        assert.strictEqual(env.err(), 'error: Missing answer for "port" (the default, 80, was not accepted): Port?\n');
        await controller.shutdown();

        // an empty answer asks for the default once
        init({ nonInteractive: true, answers: { port: '' } });
        env.input.end();
        addPort();
        result = await adapter.run({ dialog: 'port' });
        assert.strictEqual(result.exitCode, 2);
        assert.strictEqual(count(env.out(), 'Pick a port >= 1024.'), 1);
        await controller.shutdown();

        // after a real answer, the default may be tried again
        init({ nonInteractive: true, answers: { port: ['22'] } });
        env.input.end();
        const dialog = new BotkitConversation('port', controller);
        dialog.ask({ text: ['Port?'], channelData: { default: '8080' } }, async (answer, convo) => {
            if (Number(answer) < 1024) {
                await convo.repeat();
            }
        }, 'port');
        controller.addDialog(dialog);
        result = await adapter.run({ dialog: 'port' });
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.vars.port, '8080');
    });

    it('should not cycle between questions that only get their defaults', async function() {
        init({ nonInteractive: true });
        env.input.end();
        const dialog = new BotkitConversation('cycle', controller);
        dialog.ask({ text: ['Name?'], channelData: { default: 'x' } }, async (answer, convo) => {
            await convo.gotoThread('more');
        }, 'name');
        dialog.addQuestion({ text: ['Add another?'], channelData: { default: 'yes' } }, async (answer, convo) => {
            if (answer === 'yes') {
                await convo.gotoThread('default');
            }
        }, 'more', 'more');
        controller.addDialog(dialog);
        const result = await adapter.run({ dialog: 'cycle' });
        assert.deepStrictEqual({ status: result.status, exitCode: result.exitCode }, { status: 'failed', exitCode: 2 });
        assert.strictEqual(count(env.out(), 'you> x (default)'), 1);
        assert.strictEqual(count(env.out(), 'you> yes (default)'), 1);
        assert.ok(env.err().startsWith('error: Missing answer for "name" (the default, x, was not accepted)'), env.err());
    });

    it('should let timers run between automatic answers', async function() {
        const answers = [];
        for (let a = 0; a < 20; a++) {
            answers.push('no');
        }
        answers.push('yes');
        init({ answers: { done: answers } });
        const dialog = new BotkitConversation('loop', controller);
        dialog.ask('Done?', async (answer, convo) => {
            if (answer !== 'yes') {
                await convo.repeat();
            }
        }, 'done');
        controller.addDialog(dialog);
        let fired = false;
        let firedBeforeEnd;
        controller.afterDialog('loop', async () => {
            firedBeforeEnd = fired;
        });
        setTimeout(() => {
            fired = true;
        }, 0);
        // make sure the timer is due before the run starts
        const until = Date.now() + 5;
        while (Date.now() < until) {
            // busy wait
        }
        const result = await adapter.run({ dialog: 'loop' });
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(firedBeforeEnd, true);
    });

    it('should end a run as canceled when its dialog is canceled without ending', async function() {
        init();
        addSetup(controller);
        controller.interrupts('cancel', 'message', async (bot, message) => {
            await bot.cancelAllDialogs();
            await bot.reply(message, 'Canceled.');
        });
        const run = adapter.run({ dialog: 'setup' });
        await adapter.idle();
        assert.deepStrictEqual(await adapter.submit('cancel'), ['bot> Canceled.']);
        assert.deepStrictEqual(await run, { status: 'canceled', exitCode: 1 });
        await tick();
        assert.strictEqual(shutdowns, 1);
    });

    it('should end a run as canceled when a proactive turn cancels its dialog', async function() {
        init();
        addSetup(controller);
        controller.interrupts(async () => true, 'expire', async (bot) => {
            await bot.cancelAllDialogs();
            await bot.say('Session expired.');
        });
        const run = adapter.run({ dialog: 'setup', closeOnComplete: false });
        await adapter.idle();
        // a timer or a scheduled job
        await adapter.continueConversation(adapter.getReference(), async (context) => {
            context.activity.channelData = { botkitEventType: 'expire' };
            await controller.handleTurn(context);
        });
        assert.deepStrictEqual(await run, { status: 'canceled', exitCode: 1 });
        assert.ok(env.out().endsWith('bot> Session expired.\n'));
        assert.strictEqual(shutdowns, 0);
    });

    it('should reject unknown dialogs and concurrent runs', async function() {
        init();
        addSetup(controller);
        await assert.rejects(adapter.run({ dialog: 'nope' }), /Unknown dialog "nope"\. Did you call controller\.addDialog\(\)\?/);

        const first = adapter.run({ dialog: 'setup' });
        await assert.rejects(adapter.run({ dialog: 'setup' }), /A run is already in progress/);
        await assert.rejects(adapter.run(), /A run is already in progress/);
        env.input.end();
        assert.deepStrictEqual(await first, { status: 'eof', exitCode: 1 });
        await assert.rejects(adapter.run(), /The CLI session is closed/);
    });

    it('should end with eof and exit code 1 when the input ends before the dialog does', async function() {
        init();
        addSetup(controller);
        const run = adapter.run({ dialog: 'setup' });
        await adapter.idle();
        env.input.end();
        const result = await run;
        assert.deepStrictEqual(result, { status: 'eof', exitCode: 1 });
        assert.ok(env.out().includes('bot> Which database?'));
    });

    it('should end an interactive run with quit and exit code 0 on /quit', async function() {
        init({ greeting: true });
        let greeted = 0;
        controller.on('conversationUpdate', async () => {
            greeted++;
        });
        const run = adapter.run();
        env.input.write('/quit\n');
        assert.deepStrictEqual(await run, { status: 'quit', exitCode: 0 });
        assert.strictEqual(greeted, 1);
        await tick();
        assert.strictEqual(shutdowns, 1);
    });

    it('should not send a greeting for a dialog run', async function() {
        init({ greeting: true, answers: { db: 'sqlite', password: 'hunter2222' } });
        addSetup(controller);
        let greeted = 0;
        controller.on('conversationUpdate', async () => {
            greeted++;
        });
        await adapter.run({ dialog: 'setup' });
        assert.strictEqual(greeted, 0);
    });

    it('should report a stopped dialog as canceled and a timed out one as timeout', async function() {
        init({ answers: { ok: 'no' } });
        addConfirm(controller);
        let result = await adapter.run({ dialog: 'confirm' });
        assert.strictEqual(result.status, 'canceled');
        assert.strictEqual(result.exitCode, 1);
        assert.strictEqual(result.vars._status, 'canceled');
        assert.ok(env.out().includes('bot> Aborting.'));
        await controller.shutdown();

        init({ answers: { ok: 'later' } });
        addConfirm(controller);
        result = await adapter.run({ dialog: 'confirm' });
        assert.strictEqual(result.status, 'timeout');
        assert.strictEqual(result.exitCode, 1);
    });

    it('should fail with exit code 1 when a dialog handler throws', async function() {
        init({ answers: { go: 'yes' } });
        const crash = new BotkitConversation('crash', controller);
        crash.ask('Continue?', async () => {
            throw new Error('kaboom');
        }, 'go');
        controller.addDialog(crash);
        const result = await adapter.run({ dialog: 'crash' });
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.exitCode, 1);
        assert.ok(result.error instanceof Error);
        assert.strictEqual(result.error.message, 'kaboom');
        assert.strictEqual(env.err(), 'error: kaboom\n');
    });

    it('should fail an interactive non-interactive-mode session on a turn error', async function() {
        init({ nonInteractive: true });
        controller.hears('boom', 'message', async () => {
            throw new Error('kaboom');
        });
        const run = adapter.run();
        env.input.write('boom\nhello\n');
        const result = await run;
        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.exitCode, 1);
        assert.strictEqual(result.error.message, 'kaboom');
        assert.ok(!env.out().includes('you> hello'));
    });

    it('should cancel a dialog left pending in the conversation and start fresh', async function() {
        init({ answers: { password: 'hunter2222' } });
        addSetup(controller);
        // started by a hears; waits for db, which has no answer
        await adapter.submit('setup');
        await adapter.idle();
        assert.deepStrictEqual(await adapter.submit('/state'), [
            '     waiting in dialog "setup" (thread default) for "db"',
            '     vars: {"app":"old"}'
        ]);

        const run = adapter.run({ dialog: 'setup', vars: { app: 'acme' } });
        await adapter.idle();
        assert.strictEqual(count(env.out(), 'bot> Which database?'), 2);
        await adapter.submit('2');
        const result = await run;
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.vars.app, 'acme');
        assert.strictEqual(result.vars.db, 'sqlite');
        assert.strictEqual(count(env.out(), 'Setting up'), 1);
    });

    it('should keep the session open when closeOnComplete is false, and reset answers for each run', async function() {
        init({ answers: { db: 'sqlite', password: 'hunter2222' } });
        addSetup(controller);
        controller.hears('hello', 'message', async (bot) => {
            await bot.say('Still here');
        });
        const first = await adapter.run({ dialog: 'setup', closeOnComplete: false });
        assert.strictEqual(first.status, 'completed');
        assert.deepStrictEqual(await adapter.submit('hello'), ['bot> Still here']);

        const second = await adapter.run({ dialog: 'setup', vars: { app: 'two' }, closeOnComplete: false });
        assert.strictEqual(second.status, 'completed');
        assert.strictEqual(second.vars.app, 'two');
        assert.strictEqual(second.vars.db, 'sqlite');
        assert.strictEqual(shutdowns, 0);
    });

    it('should only finish a run for the dialog it started', async function() {
        init();
        addSetup(controller);
        const run = adapter.run({ dialog: 'setup', vars: { app: 'ann-app' } });
        await adapter.idle();

        await adapter.submit('/as bob');
        await adapter.submit('setup');
        await adapter.submit('1');
        await adapter.submit('bobpassword');
        assert.ok(env.out().includes('Setting up old with postgres.'));

        await adapter.submit('/as ann');
        await adapter.submit('2');
        await adapter.submit('annpassword');
        const result = await run;
        assert.strictEqual(result.status, 'completed');
        assert.strictEqual(result.vars.app, 'ann-app');
        assert.strictEqual(result.vars.user, 'ann');
    });

    it('should not echo answers in json format', async function() {
        init({ format: 'json', answers: { db: 'sqlite', password: 'hunter2222' } });
        addSetup(controller);
        const result = await adapter.run({ dialog: 'setup' });
        assert.strictEqual(result.status, 'completed');
        const output = lines(env.out()).map((line) => JSON.parse(line));
        assert.deepStrictEqual(output.map((line) => line.text), ['Which database?', 'Admin password (8+ chars)?', 'Setting up  with sqlite.']);
    });
});

describe('CliAdapter as a process', function() {
    this.timeout(20000);

    /**
     * Run tests/fixtures/wizard.js with the given arguments and stdin, and collect its exit code and output.
     * Options: keepStdinOpen writes stdin without ending it; closeStderr closes the reading end of the child's stderr at once.
     * A child still running after 10s is killed and resolves with code null.
     */
    function runWizard(args, stdin, options = {}) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'wizard.js'), ...args], {
                cwd: __dirname,
                env: { ...process.env, NO_COLOR: '1' },
                stdio: ['pipe', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            const killer = setTimeout(() => child.kill('SIGKILL'), 10000);
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            if (options.closeStderr) {
                child.stderr.destroy();
            } else {
                child.stderr.on('data', (chunk) => { stderr += chunk; });
            }
            child.on('error', reject);
            child.on('close', (code) => {
                clearTimeout(killer);
                resolve({ code, stdout, stderr, ms: Date.now() - started });
            });
            if (options.keepStdinOpen) {
                child.stdin.write(stdin);
            } else {
                child.stdin.end(stdin);
            }
        });
    }

    it('should run a dialog unattended and exit 0', async function() {
        const result = await runWizard(['--run', 'setup', '--non-interactive', '--answers', '{"db":"sqlite","password":"hunter2222"}'], '');
        assert.strictEqual(result.code, 0, result.stderr);
        assert.ok(result.stdout.includes('you> sqlite (from answers)\n'));
        assert.ok(result.stdout.includes('bot> Configured sqlite.\n'));
        assert.ok(!/error/i.test(result.stderr), result.stderr);
    });

    it('should exit 2 when an answer is missing', async function() {
        const result = await runWizard(['--run', 'setup', '--non-interactive', '--answers', '{"db":"sqlite"}'], '');
        assert.strictEqual(result.code, 2);
        assert.ok(result.stderr.includes('Missing answer for "password": Admin password?'));
    });

    it('should exit 1 when the input ends before the dialog does', async function() {
        const result = await runWizard(['--run', 'setup'], '2\n');
        assert.strictEqual(result.code, 1);
        assert.ok(result.stdout.includes('you> 2\nbot> Admin password?\n'));
    });

    it('should run piped REPL input and exit on /quit', async function() {
        const result = await runWizard([], 'hello\n/quit\nhello\n');
        assert.strictEqual(result.code, 0);
        assert.strictEqual(result.stdout, 'you> hello\nlog line from a handler\nbot> Hi\nyou> /quit\nshutdown handler log\n');
    });

    it('should read piped answers in non-interactive mode', async function() {
        const result = await runWizard(['--run', 'setup', '--non-interactive'], '2\nsecret\n');
        assert.strictEqual(result.code, 0, result.stderr);
        assert.ok(result.stdout.includes('you> 2\nbot> Admin password?\nyou> secret\nbot> Configured sqlite.\n'), result.stdout);
        assert.ok(!/error/i.test(result.stderr), result.stderr);
    });

    it('should fail a turn that never finishes instead of exiting quietly', async function() {
        // with no plugin timer, only the turn timeout is left to keep the process alive
        let result = await runWizard(['--non-interactive', '--timeout', '300', '--no-timer'], 'hang\n');
        assert.strictEqual(result.code, 1);
        assert.ok(result.stderr.includes('error: Turn timed out after 300ms\n'), result.stderr);

        result = await runWizard(['--timeout', '300', '--no-timer'], 'hang\nhello\n');
        assert.strictEqual(result.code, 0);
        assert.ok(result.stderr.includes('error: Turn timed out after 300ms\n'), result.stderr);
        assert.ok(result.stdout.includes('you> hello\nlog line from a handler\nbot> Hi\n'), result.stdout);
    });

    it('should not let a turn that never finishes keep the process alive after the session ends', async function() {
        // the default turnTimeout is 30s
        const result = await runWizard(['--shutdown-after', '300'], 'hang\n');
        assert.strictEqual(result.code, 0);
        assert.ok(result.ms < 8000, `exited after ${ result.ms }ms`);
    });

    it('should shut down and exit when the session is closed from code', async function() {
        const result = await runWizard([], 'bye\n', { keepStdinOpen: true });
        assert.strictEqual(result.code, 0);
        assert.strictEqual(result.stdout, 'you> bye\nbot> Goodbye!\nshutdown handler log\n');
    });

    it('should keep going when stderr is closed', async function() {
        const result = await runWizard([], 'boom\nhello\n', { closeStderr: true });
        assert.strictEqual(result.code, 0);
        assert.ok(result.stdout.includes('you> boom\nyou> hello\nlog line from a handler\nbot> Hi\n'), result.stdout);
    });

    it('should keep stdout pure JSON in json format', async function() {
        const result = await runWizard(['--json'], 'hello\n');
        assert.strictEqual(result.code, 0);
        const output = result.stdout.split('\n').filter((line) => line !== '');
        assert.deepStrictEqual(output.map((line) => JSON.parse(line)), [{ type: 'message', text: 'Hi', to: 'ann', conversation: JSON.parse(output[0]).conversation }]);
        assert.ok(result.stderr.includes('log line from a handler'));
        // shutdown handlers run after the session has ended, and still cannot write into the JSON
        assert.ok(result.stderr.includes('shutdown handler log'), result.stderr);
    });
});
