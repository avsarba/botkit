#!/usr/bin/env node
/**
 * Ops Desk as a Model Context Protocol (MCP) server on stdio, for AI agents such as Claude Code:
 *
 *   claude mcp add ops-desk -- node /absolute/path/to/packages/examples/ops-desk/mcp.js
 *
 * Agents talk to the bot with the chat tool (the same deploy dialog people use in the terminal),
 * and read data with the service_status and list_jobs tools.
 * stdout carries only JSON-RPC; everything else goes to stderr.
 */
const { McpAdapter } = require('botbuilder-adapter-mcp');
const createOpsDesk = require('./opsdesk');

const INSTRUCTIONS = 'Ops Desk manages deploys for api, billing and search. Use the chat tool: say "help" to list commands, ' +
    '"deploy" to start a guided deploy (answer each question with one of the offered values, or "cancel" to stop), ' +
    '"remind me in 5 minutes to <task>" for reminders. Use service_status and list_jobs for read-only data.';

/**
 * Create Ops Desk on an McpAdapter, with two read-only tools besides chat: service_status and list_jobs.
 *
 * ```javascript
 * const { adapter, ready } = createMcpServer({ autoStart: false });
 * await ready;
 * const result = await adapter.callTool('chat', { message: 'deploy', session: 'ci' });
 * console.log(result.structuredContent.pendingQuestion); // { dialog: 'deploy', thread: 'default', key: 'service' }
 * ```
 *
 * @param options McpAdapter options (input, output, autoStart, turnTimeout...) and createOpsDesk options
 * (storage, clock, schedulerAutoStart, watchInterval, reportOutput, fleet), in one object.
 * @returns `{ adapter, controller, scheduler, fleet, ready }`.
 */
function createMcpServer(options = {}) {
    // The adapter must exist before Botkit does, so its console redirection catches everything Botkit prints.
    const adapter = new McpAdapter({
        serverInfo: { name: 'ops-desk', title: 'Ops Desk', version: '1.0.0' },
        instructions: INSTRUCTIONS,
        ...options
    });

    adapter.tool('service_status', {
        title: 'Service status',
        description: 'Versions and health of every service',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true }
    });
    adapter.tool('list_jobs', {
        description: 'Scheduled jobs (reminders, health watches, reports)',
        inputSchema: {
            type: 'object',
            properties: {
                session: { type: 'string', description: 'Only list the jobs of this chat session' }
            }
        },
        annotations: { readOnlyHint: true }
    });

    const desk = createOpsDesk(adapter, options);
    return {
        adapter: adapter,
        controller: desk.controller,
        scheduler: desk.scheduler,
        fleet: desk.fleet,
        ready: desk.ready
    };
}

async function main() {
    // Answer requests only once the startup jobs are declared; requests sent before then wait in stdin.
    const server = createMcpServer({ autoStart: false });
    try {
        await server.ready;
        server.adapter.listen();
    } catch (err) {
        console.error('ops-desk: could not start the MCP server', err);
        process.exitCode = 1;
        await server.controller.shutdown();
    }
}

if (require.main === module) {
    main();
}

module.exports = { createMcpServer };
