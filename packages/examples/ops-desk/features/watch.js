/**
 * "watch": a recurring health check bound to this conversation and user. "break" and "fix" simulate outages to watch for.
 */

module.exports = function(controller) {
    const { fleet, settings } = controller.plugins.opsdesk;

    // one watch per conversation and user; scheduling the same id again updates the job instead of adding one
    const watchId = (message) => `watch:${ message.channel }:${ message.user }`;

    controller.hears(/^watch$/i, 'message', async (bot, message) => {
        await bot.schedule({ id: watchId(message), every: settings.watchInterval, event: 'health_check' });
        await bot.reply(message, `Watching fleet health every ${ settings.watchInterval }. Say "unwatch" to stop.`);
    });

    controller.on('health_check', async (bot, message) => {
        const unhealthy = fleet.status().filter((service) => !service.healthy);
        if (unhealthy.length) {
            for (const service of unhealthy) {
                await bot.say(`ALERT: ${ service.name } is unhealthy`);
            }
        } else if (message.job && message.job.runs === 1) {
            // confirm the first check; after that, stay quiet while all is well
            await bot.say('All services healthy.');
        }
    });

    controller.hears(/^unwatch$/i, 'message', async (bot, message) => {
        const stopped = await bot.cancelSchedule(watchId(message));
        await bot.reply(message, stopped ? 'Stopped watching.' : 'You are not watching anything.');
    });

    controller.hears(/^break (\w+)$/i, 'message', async (bot, message) => {
        const name = message.matches[1].toLowerCase();
        if (!fleet.names().includes(name)) {
            await bot.reply(message, `Unknown service "${ message.matches[1] }".`);
            return;
        }
        fleet.setHealthy(name, false);
        await bot.reply(message, `Simulated an outage of ${ name }.`);
    });

    controller.hears(/^fix (\w+)$/i, 'message', async (bot, message) => {
        const name = message.matches[1].toLowerCase();
        if (!fleet.names().includes(name)) {
            await bot.reply(message, `Unknown service "${ message.matches[1] }".`);
            return;
        }
        fleet.setHealthy(name, true);
        await bot.reply(message, `${ name } is healthy again.`);
    });
};
