// A small terminal app used by the child-process tests. It reads the real process.stdin and writes to process.stdout.
// Usage: node wizard.js [--json] [--non-interactive] [--run <dialog>] [--answers <json>]
const { Botkit, BotkitConversation } = require('botkit');
const { CliAdapter } = require('../../');

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};

const adapter = new CliAdapter({
    format: args.includes('--json') ? 'json' : 'text',
    nonInteractive: args.includes('--non-interactive'),
    answers: option('--answers') ? JSON.parse(option('--answers')) : undefined,
    user: 'ann',
    greeting: false
});
const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });

const setup = new BotkitConversation('setup', controller);
setup.ask({ text: ['Which database?'], quick_replies: [{ title: 'PostgreSQL', payload: 'postgres' }, { title: 'SQLite', payload: 'sqlite' }] }, [], 'db');
setup.ask('Admin password?', [], 'password');
setup.say('Configured {{vars.db}}.');
controller.addDialog(setup);

controller.hears('hello', 'message', async (bot) => {
    console.log('log line from a handler');
    await bot.say('Hi');
});

// keep a timer alive until shutdown, like a plugin would
const timer = setInterval(() => {}, 1000);
controller.on('shutdown', async () => {
    clearInterval(timer);
});

const run = option('--run');
adapter.run(run ? { dialog: run } : {}).then((result) => {
    process.exitCode = result.exitCode;
});
