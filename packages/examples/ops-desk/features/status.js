/**
 * Fleet status, as a table in conversations and as structured data for the MCP tool service_status.
 */

module.exports = function(controller) {
    const { fleet } = controller.plugins.opsdesk;

    controller.hears(/^status$/i, 'message', async (bot, message) => {
        await bot.reply(message, fleet.table());
    });

    // Declared as an MCP tool in mcp.js. Any adapter can fire it, so check for the MCP-only worker method.
    controller.on('tool:service_status', async (bot) => {
        const services = fleet.status();
        const healthy = services.filter((service) => service.healthy).length;
        await bot.say(`${ services.length } services, ${ healthy } healthy.`);
        if (bot.toolResult) {
            bot.toolResult({ services: services });
        }
    });
};
