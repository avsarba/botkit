/**
 * The scheduled jobs: "jobs" lists this conversation's jobs, and the MCP tool list_jobs returns them as data.
 */

module.exports = function(controller) {
    const { scheduler } = controller.plugins;

    controller.hears(/^jobs$/i, 'message', async (bot, message) => {
        const jobs = await scheduler.list({ conversation: message.channel });
        if (!jobs.length) {
            await bot.reply(message, 'No scheduled jobs for this conversation.');
            return;
        }
        await bot.reply(message, jobs.map((job) => `${ job.id }  ${ job.event }  next ${ job.nextRunAt || 'never' }`).join('\n'));
    });

    // Declared as an MCP tool in mcp.js. Chat sessions use the conversation id 'session:<session>'.
    controller.on('tool:list_jobs', async (bot, message) => {
        const session = message.value && message.value.session;
        const jobs = await scheduler.list(session ? { conversation: 'session:' + session } : {});
        await bot.say(`${ jobs.length } scheduled job(s).`);
        if (bot.toolResult) {
            bot.toolResult({
                jobs: jobs.map((job) => ({ id: job.id, event: job.event, kind: job.kind, nextRunAt: job.nextRunAt }))
            });
        }
    });
};
