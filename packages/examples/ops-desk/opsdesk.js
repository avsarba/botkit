/**
 * Ops Desk: one set of Botkit features (a guided deploy, fleet status, reminders, health watches and a nightly report)
 * that runs on any adapter. cli.js serves it in a terminal or a CI job, and mcp.js serves it to AI agents.
 */
const path = require('path');
const { Botkit } = require('botkit');
const { BotkitScheduler, parseDuration } = require('botkit-plugin-scheduler');
const createFleet = require('./fleet');

/**
 * The default destination of the nightly report, and of anything else the bot says on the scheduler's clock channel.
 * stderr keeps it out of the way of the terminal session, of JSON output and of the MCP protocol on stdout.
 */
function writeReport(activity) {
    if (activity && activity.text) {
        process.stderr.write(`[nightly-report] ${ activity.text }\n`);
    }
}

/**
 * Build the Ops Desk bot on an adapter.
 *
 * It creates the Botkit controller and a scheduler plugin, then loads every module in ./features.
 * Features find their shared state in `controller.plugins.opsdesk`:
 * `fleet`, `settings.watchInterval`, `now()` (the scheduler clock's time) and `startup`, a list of promises that must settle before `ready` resolves.
 *
 * ```javascript
 * const { CliAdapter } = require('botbuilder-adapter-cli');
 * const createOpsDesk = require('./opsdesk');
 *
 * const adapter = new CliAdapter({ autoStart: false });
 * const desk = createOpsDesk(adapter);
 * await desk.ready;
 * const result = await adapter.run({ dialog: 'deploy' });
 * ```
 *
 * @param adapter A BotAdapter for Botkit, such as a CliAdapter or an McpAdapter.
 * @param options Optional settings:
 * * `storage`: a Botkit storage for dialog state and scheduled jobs. Defaults to MemoryStorage.
 * * `clock`: a SchedulerClock (`now`, `setTimeout`, `clearTimeout`), for tests. Defaults to the system clock.
 * * `schedulerAutoStart`: start the scheduler's timer when Botkit is ready. Defaults to true; tests set false and call `scheduler.tick()`.
 * * `watchInterval`: how often `watch` checks the fleet, as a duration such as '30s'. Defaults to '30s'.
 * * `reportOutput`: `(activity, job) => void`, receives what the bot says in clock jobs such as the nightly report.
 *   Defaults to writing `[nightly-report] <text>` to stderr.
 * * `fleet`: the fleet to manage. Defaults to a new createFleet().
 * @returns `{ controller, scheduler, fleet, ready }`. `ready` resolves once the startup jobs (the nightly report) are declared.
 */
module.exports = function createOpsDesk(adapter, options = {}) {
    const watchInterval = options.watchInterval || '30s';
    // fail now, rather than the first time someone says "watch"
    parseDuration(watchInterval);

    const fleet = options.fleet || createFleet();
    const clock = options.clock;

    const controller = new Botkit({
        adapter: adapter,
        storage: options.storage,
        disable_webserver: true,
        disable_console: true
    });

    const scheduler = new BotkitScheduler({
        clock: clock,
        autoStart: options.schedulerAutoStart !== false,
        output: options.reportOutput || writeReport
    });
    controller.usePlugin(scheduler);

    const startup = [];
    controller.addPluginExtension('opsdesk', {
        fleet: fleet,
        settings: { watchInterval: watchInterval },
        now: () => (clock ? clock.now() : Date.now()),
        startup: startup
    });

    controller.loadModules(path.join(__dirname, 'features'));

    // Features queue their startup work in controller.ready() handlers, which run before this one.
    const ready = new Promise((resolve) => controller.ready(resolve))
        .then(() => Promise.all(startup))
        .then(() => undefined);

    return { controller, scheduler, fleet, ready };
};
