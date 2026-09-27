/**
 * "remind me in 10 minutes to check the logs": a one-shot job bound to this conversation.
 * When it fires, the scheduler continues the conversation on the adapter that owns it,
 * so the reminder is printed in the terminal session, or lands in the MCP session's outbox.
 */

const PATTERN = /^remind me in (\d+)\s*(seconds?|secs?|s|minutes?|mins?|m)\s+to\s+(.+)$/i;

module.exports = function(controller) {
    controller.hears(PATTERN, 'message', async (bot, message) => {
        const n = parseInt(message.matches[1], 10);
        const unit = /^m/i.test(message.matches[2]) ? 'minute' : 'second';
        const what = message.matches[3].trim().replace(/[.!]+$/, '');

        if (!(n >= 1)) {
            await bot.reply(message, 'Pick a time of at least 1 second.');
            return;
        }
        try {
            // bot.schedule() binds the job to this conversation (message.reference)
            await bot.schedule({ in: n * (unit === 'minute' ? 60000 : 1000), event: 'reminder', payload: { what: what } });
        } catch (err) {
            await bot.reply(message, `Sorry, I could not set that reminder: ${ err.message }`);
            return;
        }
        await bot.reply(message, `OK, I will remind you in ${ n } ${ unit }${ n === 1 ? '' : 's' }: ${ what }.`);
    });

    controller.on('reminder', async (bot, message) => {
        const what = message.value && message.value.what;
        await bot.say(`Reminder: ${ what || '(no details)' }`);
    });
};
