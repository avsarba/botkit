/**
 * A nightly report at 02:00 UTC. It is a clock job: it has no conversation, so it runs on the scheduler's
 * own clock channel, and what the bot says goes to the scheduler's `output` option (reportOutput in opsdesk.js).
 */

module.exports = function(controller) {
    const { fleet, startup } = controller.plugins.opsdesk;
    const { scheduler } = controller.plugins;

    controller.ready(() => {
        // Declaring the same job at every start is safe: an unchanged job keeps its next run time.
        startup.push(scheduler.cron('nightly-report', '0 2 * * *', { event: 'nightly_report' }).catch(console.error));
    });

    controller.on('nightly_report', async (bot) => {
        const services = fleet.status();
        const healthy = services.filter((service) => service.healthy).length;
        await bot.say(`Nightly report: ${ healthy }/${ services.length } services healthy.`);
    });
};
