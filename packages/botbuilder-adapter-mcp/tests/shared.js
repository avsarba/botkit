const { PassThrough } = require('stream');
const readline = require('readline');
const { Botkit } = require('botkit');
const { McpAdapter } = require('../');

/**
 * A promise with its resolve and reject functions exposed.
 */
function deferred() {
    const result = {};
    result.promise = new Promise((resolve, reject) => {
        result.resolve = resolve;
        result.reject = reject;
    });
    return result;
}

/**
 * Wait a number of milliseconds.
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an McpAdapter on PassThrough streams, a Botkit controller that uses it, and a small JSON-RPC client.
 * autoStart is left at its default, so the adapter starts listening once Botkit is ready.
 * @param options McpAdapter options, merged over { input, output, serverInfo: { name: 'test-bot', version: '0.0.1' } }.
 */
function setup(options = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    const adapter = new McpAdapter({
        input,
        output,
        serverInfo: { name: 'test-bot', version: '0.0.1' },
        ...options
    });
    const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });

    const lines = [];
    const responses = [];
    const notifications = [];
    const waiters = [];
    let nextId = 1;

    const reader = readline.createInterface({ input: output });
    reader.on('line', (line) => {
        lines.push(line);
        const message = JSON.parse(line);
        if (Array.isArray(message) || message.method === undefined) {
            responses.push(message);
        } else {
            notifications.push(message);
        }
        for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].predicate(message)) {
                waiters[i].resolve(message);
                waiters.splice(i, 1);
            }
        }
    });

    /**
     * Resolve with the first output message matching predicate, including messages already received.
     */
    function waitFor(predicate) {
        const seen = lines.map((line) => JSON.parse(line)).find(predicate);
        if (seen) {
            return Promise.resolve(seen);
        }
        return new Promise((resolve) => waiters.push({ predicate, resolve }));
    }

    /**
     * Write a request object and resolve with the response that has its id.
     */
    function request(message) {
        const response = waitFor((m) => !Array.isArray(m) && m.method === undefined && m.id === message.id);
        input.write(JSON.stringify(message) + '\n');
        return response;
    }

    /**
     * Send a request with the next numeric id. meta becomes params._meta.
     */
    function rpc(method, params, meta) {
        const message = { jsonrpc: '2.0', id: nextId++, method };
        if (params !== undefined || meta !== undefined) {
            message.params = { ...(params || {}) };
            if (meta !== undefined) {
                message.params._meta = meta;
            }
        }
        return request(message);
    }

    /**
     * Send a notification (no id).
     */
    function notify(method, params) {
        const message = { jsonrpc: '2.0', method };
        if (params !== undefined) {
            message.params = params;
        }
        input.write(JSON.stringify(message) + '\n');
    }

    /**
     * Write text to the input exactly as given.
     */
    function raw(text) {
        input.write(text);
    }

    /**
     * Initialize the session like a client would.
     */
    async function initialize(protocolVersion = '2025-11-25', clientInfo = { name: 'test-client', version: '1.0.0' }) {
        const response = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo });
        notify('notifications/initialized');
        return response;
    }

    /**
     * Call a tool and resolve with its result. Rejects on a JSON-RPC error.
     */
    async function callTool(name, args, meta) {
        const response = await rpc('tools/call', { name, arguments: args }, meta);
        if (response.error) {
            throw new Error(`tools/call ${ name } failed: ${ response.error.code } ${ response.error.message }`);
        }
        return response.result;
    }

    /**
     * Call the chat tool.
     */
    function chat(message, session, extra) {
        const args = { message, ...extra };
        if (session !== undefined) {
            args.session = session;
        }
        return callTool('chat', args);
    }

    /**
     * Stop reading the output and shut Botkit down.
     */
    async function close() {
        reader.close();
        await controller.shutdown();
    }

    return { adapter, controller, input, output, lines, responses, notifications, rpc, request, notify, raw, waitFor, initialize, callTool, chat, close };
}

/**
 * The texts of a tool result's content items.
 */
function texts(result) {
    return result.content.map((item) => item.text);
}

module.exports = { setup, deferred, sleep, texts };
