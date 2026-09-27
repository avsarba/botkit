// A Botkit bot served over MCP on the real stdin and stdout, used by Stdio.tests.js.
// Botkit's console output is left on (no disable_console), and a handler writes to console.log,
// to prove that the adapter keeps everything but JSON-RPC off stdout.
const { Botkit } = require('botkit');
const { McpAdapter } = require('../../');

const adapter = new McpAdapter({
    serverInfo: { name: 'stdio-bot', version: '1.0.0' }
});

const controller = new Botkit({
    adapter: adapter,
    disable_webserver: true
});

controller.hears('hello', 'message', async (bot, message) => {
    console.log('noise from handler');
    console.info({ user: message.user });
    await bot.reply(message, 'Hi from stdio');
});
