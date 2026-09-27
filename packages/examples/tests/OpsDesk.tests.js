const assert = require('assert');
const { PassThrough } = require('stream');
const { CliAdapter } = require('botbuilder-adapter-cli');
const createOpsDesk = require('../ops-desk/opsdesk');
const createFleet = require('../ops-desk/fleet');
const { createCli, parseArgs } = require('../ops-desk/cli');
const { createMcpServer } = require('../ops-desk/mcp');
const ANSWERS = require('../ops-desk/answers.json');

const t0 = Date.parse('2026-09-27T12:00:00Z');

/**
 * A clock that only moves when a test says so. With schedulerAutoStart: false the scheduler never arms a timer,
 * and tests run due jobs with scheduler.tick(time).
 */
class FakeClock {
    constructor(t) {
        this.t = t;
        this.timers = [];
    }

    now() {
        return this.t;
    }

    setTimeout(fn, ms) {
        const timer = { fn, at: this.t + ms };
        this.timers.push(timer);
        return timer;
    }

    clearTimeout(timer) {
        this.timers = this.timers.filter((t) => t !== timer);
    }
}

/**
 * A storage that outlives the controllers that use it, like a database across restarts. Items are stored as JSON.
 */
class SharedStorage {
    constructor() {
        this.items = {};
    }

    async read(keys) {
        const found = {};
        keys.filter((key) => this.items[key] !== undefined).forEach((key) => {
            found[key] = JSON.parse(this.items[key]);
        });
        return found;
    }

    async write(changes) {
        Object.keys(changes).forEach((key) => {
            this.items[key] = JSON.stringify(changes[key]);
        });
    }

    async delete(keys) {
        keys.forEach((key) => delete this.items[key]);
    }
}

/**
 * Collect everything written to a stream.
 */
function capture(stream) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk.toString()));
    return () => chunks.join('');
}

/**
 * Let stream 'data' events run.
 */
function flush() {
    return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Ops Desk on a CliAdapter with PassThrough streams, as user 'ann' in conversation 'ops-1'.
 */
function setupCli(adapterOptions = {}, deskOptions = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const adapter = new CliAdapter({
        input,
        output,
        errorOutput,
        color: false,
        autoStart: false,
        greeting: false,
        user: 'ann',
        conversation: 'ops-1',
        ...adapterOptions
    });
    const clock = new FakeClock(t0);
    const reports = [];
    const desk = createOpsDesk(adapter, {
        clock,
        schedulerAutoStart: false,
        reportOutput: (activity) => reports.push(activity.text),
        ...deskOptions
    });
    return { adapter, desk, clock, reports, input, out: capture(output), err: capture(errorOutput) };
}

describe('Ops Desk', function() {
    describe('fleet', function() {
        it('should start every fleet from the same state', function() {
            const fleet = createFleet();
            assert.deepStrictEqual(fleet.names(), ['api', 'billing', 'search']);
            assert.deepStrictEqual(fleet.status(), [
                { name: 'api', staging: '2.3.1', production: '2.3.0', healthy: true },
                { name: 'billing', staging: '1.4.2', production: '1.4.1', healthy: true },
                { name: 'search', staging: '0.9.8', production: '0.9.8', healthy: true }
            ]);
            assert.deepStrictEqual(fleet.audit, []);
        });

        it('should bump the staging patch version, and promote staging to production', function() {
            const fleet = createFleet();
            assert.strictEqual(fleet.deploy('search', 'staging'), '0.9.9');
            assert.strictEqual(fleet.deploy('search', 'production'), '0.9.9');
            assert.strictEqual(fleet.deploy('search', 'staging'), '0.9.10');
            assert.deepStrictEqual(fleet.status()[2], { name: 'search', staging: '0.9.10', production: '0.9.9', healthy: true });
        });

        it('should reject unknown services and environments', function() {
            const fleet = createFleet();
            assert.throws(() => fleet.deploy('payments', 'staging'), /Unknown service "payments"/);
            assert.throws(() => fleet.deploy('api', 'qa'), /Unknown environment "qa"/);
            assert.throws(() => fleet.setHealthy('payments', false), /Unknown service "payments"/);
        });

        it('should return copies from status()', function() {
            const fleet = createFleet();
            fleet.status()[0].production = '9.9.9';
            assert.strictEqual(fleet.status()[0].production, '2.3.0');
        });

        it('should render a table with aligned columns', function() {
            const fleet = createFleet();
            fleet.setHealthy('billing', false);
            assert.strictEqual(fleet.table(), [
                'SERVICE  STAGING  PRODUCTION  HEALTH',
                'api      2.3.1    2.3.0       healthy',
                'billing  1.4.2    1.4.1       UNHEALTHY',
                'search   0.9.8    0.9.8       healthy'
            ].join('\n'));
        });
    });

    describe('createOpsDesk', function() {
        let desk;

        afterEach(async function() {
            if (desk) {
                await desk.controller.shutdown();
                desk = null;
            }
        });

        it('should declare the nightly report before ready resolves', async function() {
            ({ desk } = setupCli());
            await desk.ready;
            const job = await desk.scheduler.get('nightly-report');
            assert.strictEqual(job.kind, 'cron');
            assert.strictEqual(job.reference, null);
            assert.strictEqual(job.nextRunAt, '2026-09-28T02:00:00.000Z');
            assert.strictEqual(desk.controller.plugins.opsdesk.fleet, desk.fleet);
        });

        it('should use the fleet it is given', async function() {
            const fleet = createFleet();
            ({ desk } = setupCli({}, { fleet }));
            assert.strictEqual(desk.fleet, fleet);
        });

        it('should reject an invalid watch interval', function() {
            const adapter = new CliAdapter({ input: new PassThrough(), output: new PassThrough(), autoStart: false });
            assert.throws(() => createOpsDesk(adapter, { watchInterval: 'often' }), /Invalid duration "often"/);
        });
    });

    describe('in the terminal', function() {
        let adapter, desk, clock, reports, out;

        beforeEach(async function() {
            ({ adapter, desk, clock, reports, out } = setupCli());
            await desk.ready;
        });

        afterEach(async function() {
            await desk.controller.shutdown();
        });

        it('should greet with a menu that answers by number', async function() {
            adapter.start({ greeting: true });
            await adapter.idle();
            assert.ok(out().includes('bot> Ops Desk ready. Pick one or type "help".\n     [1] Deploy  [2] Status  [3] Help\n'), out());
            const lines = await adapter.submit('2');
            assert.strictEqual(lines[0], 'bot> SERVICE  STAGING  PRODUCTION  HEALTH');
        });

        it('should greet people, but not the bot joining', async function() {
            assert.deepStrictEqual(await adapter.submit('/json {"type":"conversationUpdate","membersAdded":[{"id":"bot"}]}'), []);
            assert.deepStrictEqual(await adapter.submit('/json {"type":"conversationUpdate","membersAdded":[{"id":"bot"},{"id":"ann"}]}'), [
                'bot> Ops Desk ready. Pick one or type "help".',
                '     [1] Deploy  [2] Status  [3] Help'
            ]);
        });

        it('should not greet when members leave, or when nobody joins', async function() {
            assert.deepStrictEqual(await adapter.submit('/json {"type":"conversationUpdate","membersRemoved":[{"id":"ann"}]}'), []);
            assert.deepStrictEqual(await adapter.submit('/json {"type":"conversationUpdate","membersAdded":[]}'), []);
            assert.deepStrictEqual(await adapter.submit('/json {"type":"conversationUpdate"}'), []);
        });

        it('should list the commands on help', async function() {
            const lines = await adapter.submit('help');
            assert.strictEqual(lines[0], 'bot> Ops Desk commands:');
            ['deploy', 'status', 'remind me in <n> <seconds|minutes> to <task>', 'watch / unwatch', 'break <service> / fix <service>', 'jobs'].forEach((command) => {
                assert.ok(lines.some((line) => line.trim().startsWith(command)), command);
            });
            // how to leave the deploy dialog
            assert.ok(lines.some((line) => line.trim().startsWith('deploy') && line.includes('"cancel"')), lines.join('\n'));
        });

        it('should point unknown commands to help', async function() {
            assert.deepStrictEqual(await adapter.submit('dance'), ['bot> Sorry, I don\'t know "dance". Type "help" to see what I can do.']);
            assert.deepStrictEqual(await adapter.submit('/json {"text":""}'), ['bot> Type "help" to see what I can do.']);
            // a known command is not also answered by the fallback
            assert.strictEqual((await adapter.submit('status')).length, 4);
        });

        it('should show the fleet status', async function() {
            const lines = await adapter.submit('status');
            const text = lines.join('\n');
            assert.ok(text.includes('billing'), text);
            assert.ok(text.includes('1.4.2'), text);
            assert.ok(text.includes('1.4.1'), text);
            assert.strictEqual(lines.length, 4);
        });

        it('should walk the deploy dialog to a production deploy', async function() {
            assert.deepStrictEqual(await adapter.submit('deploy'), ['bot> Which service?', '     [1] api  [2] billing  [3] search']);
            assert.deepStrictEqual(await adapter.submit('2'), ['bot> Deploy billing to which environment?', '     [1] Staging  [2] Production']);
            assert.deepStrictEqual(await adapter.submit('Production'), ['bot> Type the service name (billing) to confirm a PRODUCTION deploy.']);
            assert.deepStrictEqual(await adapter.submit('billing'), ['bot> Deployed billing 1.4.2 to production.']);

            assert.strictEqual(desk.fleet.status()[1].production, '1.4.2');
            assert.deepStrictEqual(desk.fleet.audit, [
                { service: 'billing', env: 'production', version: '1.4.2', user: 'ann', at: new Date(t0).toISOString() }
            ]);
        });

        it('should deploy to staging without a confirmation', async function() {
            await adapter.submit('deploy');
            await adapter.submit('API');
            assert.deepStrictEqual(await adapter.submit('staging'), ['bot> Deployed api 2.3.2 to staging.']);
            assert.strictEqual(desk.fleet.audit.length, 1);
            assert.strictEqual(desk.fleet.audit[0].env, 'staging');
        });

        it('should re-ask for an unknown service', async function() {
            await adapter.submit('deploy');
            assert.deepStrictEqual(await adapter.submit('payments'), [
                'bot> Unknown service "payments".',
                'bot> Which service?',
                '     [1] api  [2] billing  [3] search'
            ]);
            // the dialog is still waiting for the service
            assert.deepStrictEqual(await adapter.submit('search'), ['bot> Deploy search to which environment?', '     [1] Staging  [2] Production']);
        });

        it('should re-ask for an unknown environment', async function() {
            await adapter.submit('deploy');
            await adapter.submit('api');
            const lines = await adapter.submit('qa');
            assert.deepStrictEqual(lines.slice(0, 2), ['bot> Please choose Staging or Production.', 'bot> Deploy api to which environment?']);
        });

        it('should cancel a production deploy when the confirmation does not match', async function() {
            await adapter.submit('deploy');
            await adapter.submit('billing');
            await adapter.submit('production');
            assert.deepStrictEqual(await adapter.submit('api'), ['bot> Confirmation did not match. Deploy canceled.']);
            assert.strictEqual(desk.fleet.status()[1].production, '1.4.1');
            assert.deepStrictEqual(desk.fleet.audit, []);
            // the dialog is over: the next message goes to hears() again
            assert.strictEqual((await adapter.submit('status'))[0], 'bot> SERVICE  STAGING  PRODUCTION  HEALTH');
        });

        it('should let a person cancel the deploy at any question', async function() {
            await adapter.submit('deploy');
            assert.deepStrictEqual(await adapter.submit('cancel'), ['bot> Deploy canceled.']);
            // the dialog is over: the next message goes to hears() again
            assert.strictEqual((await adapter.submit('status'))[0], 'bot> SERVICE  STAGING  PRODUCTION  HEALTH');

            await adapter.submit('deploy');
            await adapter.submit('billing');
            assert.deepStrictEqual(await adapter.submit('Stop'), ['bot> Deploy canceled.']);

            await adapter.submit('deploy');
            await adapter.submit('billing');
            await adapter.submit('production');
            assert.deepStrictEqual(await adapter.submit('cancel'), ['bot> Deploy canceled.']);

            assert.strictEqual(desk.fleet.status()[1].production, '1.4.1');
            assert.deepStrictEqual(desk.fleet.audit, []);
            assert.strictEqual((await adapter.submit('help'))[0], 'bot> Ops Desk commands:');
        });

        it('should deliver a reminder into the terminal session', async function() {
            assert.deepStrictEqual(await adapter.submit('remind me in 10 seconds to check the logs'), ['bot> OK, I will remind you in 10 seconds: check the logs.']);
            const [job] = await desk.scheduler.list({ event: 'reminder' });
            assert.strictEqual(job.nextRunAt, new Date(t0 + 10000).toISOString());
            assert.strictEqual(job.reference.conversation.id, 'ops-1');

            assert.strictEqual(await desk.scheduler.tick(t0 + 10000), 1);
            await flush();
            assert.ok(out().includes('bot> Reminder: check the logs\n'), out());
            assert.deepStrictEqual(await desk.scheduler.list({ event: 'reminder' }), []);
        });

        it('should understand minutes and singular units', async function() {
            assert.deepStrictEqual(await adapter.submit('Remind me in 1 min to stretch.'), ['bot> OK, I will remind you in 1 minute: stretch.']);
            const [job] = await desk.scheduler.list({ event: 'reminder' });
            assert.strictEqual(job.nextRunAt, new Date(t0 + 60000).toISOString());
            assert.deepStrictEqual(job.payload, { what: 'stretch' });
        });

        it('should refuse a reminder in 0 seconds', async function() {
            assert.deepStrictEqual(await adapter.submit('remind me in 0 seconds to panic'), ['bot> Pick a time of at least 1 second.']);
            assert.deepStrictEqual(await desk.scheduler.list({ event: 'reminder' }), []);
        });

        it('should explain a reminder that cannot be scheduled', async function() {
            const lines = await adapter.submit('remind me in 999999999999999999 minutes to wait');
            assert.strictEqual(lines.length, 1);
            assert.ok(lines[0].startsWith('bot> Sorry, I could not set that reminder: '), lines[0]);
            assert.deepStrictEqual(await desk.scheduler.list({ event: 'reminder' }), []);
        });

        it('should deliver a reminder without answering a pending question', async function() {
            await adapter.submit('remind me in 5 seconds to breathe');
            await adapter.submit('deploy');
            await desk.scheduler.tick(t0 + 5000);
            await flush();
            assert.ok(out().includes('bot> Reminder: breathe\n'), out());
            // the deploy dialog is still waiting for the service
            assert.deepStrictEqual(await adapter.submit('billing'), ['bot> Deploy billing to which environment?', '     [1] Staging  [2] Production']);
        });

        it('should watch the fleet and alert on outages', async function() {
            assert.ok((await adapter.submit('watch'))[0].startsWith('bot> Watching fleet health every 30s'));
            const jobs = await adapter.submit('jobs');
            assert.ok(jobs.join('\n').includes('watch:ops-1:ann'), jobs.join('\n'));
            assert.deepStrictEqual(jobs, ['bot> watch:ops-1:ann  health_check  next 2026-09-27T12:00:30.000Z']);

            assert.deepStrictEqual(await adapter.submit('break search'), ['bot> Simulated an outage of search.']);
            await desk.scheduler.tick(t0 + 30000);
            await flush();
            assert.ok(out().includes('bot> ALERT: search is unhealthy\n'), out());

            assert.deepStrictEqual(await adapter.submit('unwatch'), ['bot> Stopped watching.']);
            assert.deepStrictEqual(await desk.scheduler.list({ conversation: 'ops-1' }), []);
        });

        it('should confirm the first healthy check only', async function() {
            await adapter.submit('watch');
            await desk.scheduler.tick(t0 + 30000);
            await flush();
            assert.strictEqual(out().split('All services healthy.').length - 1, 1);
            await desk.scheduler.tick(t0 + 60000);
            await flush();
            assert.strictEqual(out().split('All services healthy.').length - 1, 1);
            assert.strictEqual((await desk.scheduler.get('watch:ops-1:ann')).runs, 2);
        });

        it('should answer unwatch when nothing is watched', async function() {
            assert.deepStrictEqual(await adapter.submit('unwatch'), ['bot> You are not watching anything.']);
        });

        it('should break and fix services by name', async function() {
            assert.deepStrictEqual(await adapter.submit('break payments'), ['bot> Unknown service "payments".']);
            assert.deepStrictEqual(await adapter.submit('break Search'), ['bot> Simulated an outage of search.']);
            assert.strictEqual(desk.fleet.status()[2].healthy, false);
            assert.deepStrictEqual(await adapter.submit('fix search'), ['bot> search is healthy again.']);
            assert.strictEqual(desk.fleet.status()[2].healthy, true);
        });

        it('should say when a conversation has no jobs', async function() {
            assert.deepStrictEqual(await adapter.submit('jobs'), ['bot> No scheduled jobs for this conversation.']);
        });

        it('should send the nightly report to reportOutput', async function() {
            await adapter.submit('break api');
            await desk.scheduler.tick(Date.parse('2026-09-28T02:00:00Z'));
            assert.deepStrictEqual(reports, ['Nightly report: 2/3 services healthy.']);
            assert.strictEqual((await desk.scheduler.get('nightly-report')).nextRunAt, '2026-09-29T02:00:00.000Z');
            assert.strictEqual(clock.timers.length, 0);
        });
    });

    describe('nightly report', function() {
        it('should report a healthy fleet', async function() {
            const { desk, reports } = setupCli();
            try {
                await desk.ready;
                await desk.scheduler.tick(Date.parse('2026-09-28T02:00:00Z'));
                assert.deepStrictEqual(reports, ['Nightly report: 3/3 services healthy.']);
            } finally {
                await desk.controller.shutdown();
            }
        });
    });

    describe('with a storage', function() {
        // The ops-desk readme: with a storage, give the CliAdapter a fixed conversation (setupCli uses 'ops-1'),
        // so that a later session finds the jobs of an earlier one.
        it('should find and stop a watch after a restart in the same conversation', async function() {
            const storage = new SharedStorage();
            let { adapter, desk } = setupCli({}, { storage });
            try {
                await desk.ready;
                await adapter.submit('watch');
            } finally {
                await desk.controller.shutdown();
            }

            ({ adapter, desk } = setupCli({}, { storage }));
            try {
                await desk.ready;
                assert.deepStrictEqual(await adapter.submit('jobs'), ['bot> watch:ops-1:ann  health_check  next 2026-09-27T12:00:30.000Z']);
                assert.deepStrictEqual(await adapter.submit('unwatch'), ['bot> Stopped watching.']);
                assert.deepStrictEqual(await desk.scheduler.list({ event: 'health_check' }), []);
            } finally {
                await desk.controller.shutdown();
            }
        });
    });

    describe('unattended', function() {
        let desk;

        afterEach(async function() {
            await desk.controller.shutdown();
        });

        it('should cancel when the confirmation does not match', async function() {
            let adapter, out;
            ({ adapter, desk, out } = setupCli({ answers: { service: 'api', env: 'production', confirm: 'nope' }, nonInteractive: true }));
            await desk.ready;
            const result = await adapter.run({ dialog: 'deploy' });
            assert.strictEqual(result.status, 'canceled');
            assert.strictEqual(result.exitCode, 1);
            await flush();
            assert.ok(out().includes('Confirmation did not match. Deploy canceled.'), out());
            assert.strictEqual(desk.fleet.status()[0].production, '2.3.0');
        });

        it('should complete with the answers file', async function() {
            let adapter, out;
            ({ adapter, desk, out } = setupCli({ answers: ANSWERS, nonInteractive: true }));
            await desk.ready;
            const result = await adapter.run({ dialog: 'deploy' });
            assert.strictEqual(result.status, 'completed');
            assert.strictEqual(result.exitCode, 0);
            assert.strictEqual(result.vars.version, '1.4.2');
            assert.strictEqual(result.vars.env, 'production');
            await flush();
            assert.ok(out().includes('you> billing (from answers)'), out());
            assert.strictEqual(desk.fleet.audit.length, 1);
        });

        it('should end with status canceled when an answer says cancel', async function() {
            let adapter;
            ({ adapter, desk } = setupCli({ answers: { service: 'api', env: 'cancel' }, nonInteractive: true }));
            await desk.ready;
            const result = await adapter.run({ dialog: 'deploy' });
            assert.strictEqual(result.status, 'canceled');
            assert.strictEqual(result.exitCode, 1);
            assert.strictEqual(desk.fleet.status()[0].staging, '2.3.1');
            assert.deepStrictEqual(desk.fleet.audit, []);
        });

        it('should fail with exit code 2 when an answer is missing', async function() {
            let adapter, err, input;
            ({ adapter, desk, err, input } = setupCli({ answers: { service: 'api' }, nonInteractive: true }));
            await desk.ready;
            // non-interactive runs read input that is not a TTY to its end before they give up on an answer
            input.end();
            const result = await adapter.run({ dialog: 'deploy' });
            assert.strictEqual(result.status, 'failed');
            assert.strictEqual(result.exitCode, 2);
            assert.strictEqual(result.vars.service, 'api');
            await flush();
            assert.ok(err().includes('Missing answer for "env"'), err());
            assert.deepStrictEqual(desk.fleet.audit, []);
        });

        it('should build the same bot with createCli', async function() {
            const output = new PassThrough();
            const cli = createCli({
                input: new PassThrough(),
                output,
                errorOutput: new PassThrough(),
                answers: { service: 'search', env: 'staging' },
                nonInteractive: true,
                autoStart: false,
                clock: new FakeClock(t0),
                schedulerAutoStart: false
            });
            desk = cli;
            const out = capture(output);
            await cli.ready;
            const result = await cli.adapter.run({ dialog: 'deploy' });
            assert.strictEqual(result.status, 'completed');
            assert.strictEqual(cli.fleet.status()[2].staging, '0.9.9');
            assert.strictEqual(cli.controller.plugins.scheduler, cli.scheduler);
            await flush();
            assert.ok(out().includes('bot> Deployed search 0.9.9 to staging.'), out());
        });
    });

    describe('command line', function() {
        it('should parse flags and options', function() {
            assert.deepStrictEqual(parseArgs([]), { json: false, answersFile: undefined, run: undefined, nonInteractive: false, user: undefined, help: false });
            assert.deepStrictEqual(parseArgs(['--run', 'deploy', '--answers', 'a.json', '--non-interactive', '--json', '--user', 'ci']), {
                json: true, answersFile: 'a.json', run: 'deploy', nonInteractive: true, user: 'ci', help: false
            });
            assert.deepStrictEqual(parseArgs(['--run=deploy', '--answers=ops-desk/answers.json']).answersFile, 'ops-desk/answers.json');
            assert.strictEqual(parseArgs(['-h']).help, true);
        });

        it('should reject unknown options and missing values', function() {
            assert.throws(() => parseArgs(['--verbose']), /Unknown option "--verbose"/);
            assert.throws(() => parseArgs(['--run']), /--run needs a value/);
            assert.throws(() => parseArgs(['--run', '--json']), /--run needs a value/);
            assert.throws(() => parseArgs(['--run=']), /--run needs a value/);
            assert.throws(() => parseArgs(['--json=yes']), /--json does not take a value/);
        });
    });

    describe('over MCP', function() {
        let server, clock;

        beforeEach(async function() {
            clock = new FakeClock(t0);
            server = createMcpServer({
                input: new PassThrough(),
                output: new PassThrough(),
                autoStart: false,
                clock,
                schedulerAutoStart: false,
                reportOutput: () => {}
            });
            await server.ready;
        });

        afterEach(async function() {
            await server.controller.shutdown();
        });

        const chat = (message, session) => server.adapter.callTool('chat', { message, session });

        it('should let an agent walk the deploy dialog', async function() {
            let result = await chat('deploy', 's1');
            assert.strictEqual(result.structuredContent.awaitingInput, true);
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'service');
            assert.deepStrictEqual(result.structuredContent.choices.map((choice) => choice.value), ['api', 'billing', 'search']);

            result = await chat('billing', 's1');
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'env');

            result = await chat('Production', 's1');
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'confirm');

            result = await chat('billing', 's1');
            assert.ok(result.content[0].text.includes('Deployed billing 1.4.2 to production.'), result.content[0].text);
            assert.strictEqual(result.structuredContent.awaitingInput, false);
            assert.strictEqual(result.isError, undefined);
            assert.strictEqual(server.fleet.audit[0].user, 'mcp-client');
        });

        it('should let an agent cancel the deploy dialog', async function() {
            await chat('deploy', 's1');
            await chat('billing', 's1');
            const result = await chat('cancel', 's1');
            assert.strictEqual(result.content[0].text, 'Deploy canceled.');
            assert.strictEqual(result.structuredContent.awaitingInput, false);
            assert.strictEqual(result.structuredContent.pendingQuestion, null);
            assert.deepStrictEqual(server.fleet.audit, []);
        });

        it('should keep sessions apart', async function() {
            await chat('deploy', 's1');
            const other = await chat('status', 's2');
            assert.strictEqual(other.structuredContent.awaitingInput, false);
            assert.ok(other.content[0].text.startsWith('SERVICE'), other.content[0].text);
            const result = await chat('api', 's1');
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'env');
        });

        it('should answer the read-only tools with structured data', async function() {
            const status = await server.adapter.callTool('service_status', {});
            assert.strictEqual(status.structuredContent.services.length, 3);
            assert.strictEqual(status.content[0].text, '3 services, 3 healthy.');

            const jobs = await server.adapter.callTool('list_jobs', {});
            assert.ok(jobs.structuredContent.jobs.map((job) => job.id).includes('nightly-report'));
            assert.deepStrictEqual(jobs.structuredContent.jobs[0], { id: 'nightly-report', event: 'nightly_report', kind: 'cron', nextRunAt: '2026-09-28T02:00:00.000Z' });
        });

        it('should reject arguments that do not match the schema', async function() {
            const result = await server.adapter.callTool('list_jobs', { session: 42 });
            assert.strictEqual(result.isError, true);
            assert.ok(result.content[0].text.includes('session'), result.content[0].text);
        });

        it('should list the jobs of one session', async function() {
            await chat('remind me in 5 seconds to rotate keys', 's2');
            const s2 = await server.adapter.callTool('list_jobs', { session: 's2' });
            assert.deepStrictEqual(s2.structuredContent.jobs.map((job) => job.event), ['reminder']);
            assert.strictEqual(s2.content[0].text, '1 scheduled job(s).');
            const s1 = await server.adapter.callTool('list_jobs', { session: 's1' });
            assert.deepStrictEqual(s1.structuredContent.jobs, []);
        });

        it('should put reminders in the session outbox', async function() {
            const set = await chat('remind me in 5 seconds to rotate keys', 's2');
            assert.strictEqual(set.content[0].text, 'OK, I will remind you in 5 seconds: rotate keys.');
            await server.scheduler.tick(t0 + 5000);

            const result = await chat('', 's2');
            assert.strictEqual(result.structuredContent.proactive[0].text, 'Reminder: rotate keys');
            // the outbox is emptied by the call that returns it
            const again = await chat('', 's2');
            assert.deepStrictEqual(again.structuredContent.proactive, []);
        });
    });
});
