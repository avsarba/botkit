const { PassThrough } = require('stream');
const { Botkit } = require('botkit');
const { CliAdapter } = require('../');

/**
 * Collect everything written to a stream as a string.
 */
function capture(stream) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk.toString()));
    return () => chunks.join('');
}

/**
 * Create a CliAdapter on PassThrough streams and a Botkit controller that uses it.
 * Defaults: color false, autoStart false, greeting false, user 'ann', conversation 'c1'.
 * @returns {{ adapter: CliAdapter, controller: Botkit, input: PassThrough, output: PassThrough, errorOutput: PassThrough, out: () => string, err: () => string }}
 */
function setup(options = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const out = capture(output);
    const err = capture(errorOutput);
    const adapter = new CliAdapter({
        input,
        output,
        errorOutput,
        color: false,
        autoStart: false,
        greeting: false,
        user: 'ann',
        conversation: 'c1',
        ...options
    });
    const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
    return { adapter, controller, input, output, errorOutput, out, err };
}

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
 * Split captured output into lines, dropping the final empty line.
 */
function lines(text) {
    return text.split('\n').filter((line, index, all) => !(index === all.length - 1 && line === ''));
}

/**
 * Wait for the next turn of the event loop, so stream events are delivered.
 */
function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}

module.exports = { setup, deferred, capture, lines, tick };
