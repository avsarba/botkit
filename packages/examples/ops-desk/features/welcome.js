/**
 * Greet people when a session starts, list the commands on "help", and point unknown commands to "help".
 */

const COMMANDS = [
    ['deploy', 'ship a service to staging or production, step by step (say "cancel" to stop)'],
    ['status', 'versions and health of every service'],
    ['remind me in <n> <seconds|minutes> to <task>', 'set a reminder in this conversation'],
    ['watch / unwatch', 'check fleet health on a schedule, or stop'],
    ['break <service> / fix <service>', 'simulate an outage, or end it'],
    ['jobs', 'list the jobs scheduled for this conversation']
];

module.exports = function(controller) {
    controller.on('conversationUpdate', async (bot, message) => {
        const activity = message.incoming_message || {};
        const added = activity.membersAdded;
        const botId = activity.recipient && activity.recipient.id;
        // Greet only when a person joins. Channels also send updates when the bot joins, when members leave, or when nothing about members changed.
        if (!Array.isArray(added) || !added.some((member) => member && member.id !== botId)) {
            return;
        }
        await bot.reply(message, {
            text: 'Ops Desk ready. Pick one or type "help".',
            quick_replies: [
                { title: 'Deploy', payload: 'deploy' },
                { title: 'Status', payload: 'status' },
                { title: 'Help', payload: 'help' }
            ]
        });
    });

    controller.hears(/^help$/i, 'message', async (bot, message) => {
        const width = Math.max(...COMMANDS.map((command) => command[0].length)) + 2;
        const lines = COMMANDS.map((command) => command[0].padEnd(width) + command[1]);
        await bot.reply(message, ['Ops Desk commands:'].concat(lines).join('\n'));
    });

    // Runs only when no hears() pattern matched and no dialog took the message.
    // Without it, an unknown command gets no answer at all, which looks like a hang in a terminal and like "(no reply)" to an agent.
    controller.on('message', async (bot, message) => {
        const text = (message.text || '').trim();
        await bot.reply(message, text ? `Sorry, I don't know "${ text }". Type "help" to see what I can do.` : 'Type "help" to see what I can do.');
    });
};
