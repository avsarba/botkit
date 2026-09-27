const assert = require('assert');
const { PassThrough } = require('stream');
const { JsonRpcConnection } = require('../');
const { setup, deferred, sleep } = require('./shared');

describe('JsonRpc framing and dispatch', function() {
    let t;

    beforeEach(function() {
        t = setup();
    });

    afterEach(async function() {
        await t.close();
    });

    it('should answer a line that is not JSON with a parse error', async function() {
        t.raw('{bad\n');
        const response = await t.waitFor((m) => m.error);
        assert.deepStrictEqual(response, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    });

    it('should ignore blank lines', async function() {
        t.raw('\n   \n\r\n');
        const response = await t.rpc('ping');
        assert.deepStrictEqual(response.result, {});
        assert.strictEqual(t.lines.length, 1);
    });

    it('should parse a request split across two chunks once', async function() {
        const line = JSON.stringify({ jsonrpc: '2.0', id: 'split', method: 'ping' });
        const response = t.waitFor((m) => m.id === 'split');
        t.raw(line.slice(0, 10));
        await sleep(10);
        t.raw(line.slice(10) + '\n');
        assert.deepStrictEqual(await response, { jsonrpc: '2.0', id: 'split', result: {} });
        await t.rpc('ping');
        assert.strictEqual(t.responses.filter((m) => m.id === 'split').length, 1);
    });

    it('should parse CRLF-terminated lines', async function() {
        const response = t.waitFor((m) => m.id === 'crlf');
        t.raw(JSON.stringify({ jsonrpc: '2.0', id: 'crlf', method: 'ping' }) + '\r\n');
        assert.deepStrictEqual((await response).result, {});
    });

    it('should answer an unknown method with -32601', async function() {
        const response = await t.rpc('nope');
        assert.strictEqual(response.error.code, -32601);
        assert.strictEqual(response.error.message, 'Method not found: nope');
    });

    it('should never answer a notification, even for an unknown method', async function() {
        t.notify('nope');
        const response = await t.rpc('ping');
        assert.deepStrictEqual(response.result, {});
        assert.strictEqual(t.lines.length, 1);
    });

    it('should answer an invalid request with -32600 and its id', async function() {
        const response = await t.request({ jsonrpc: '1.0', id: 1, method: 'ping' });
        assert.deepStrictEqual(response, { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } });
    });

    it('should answer other malformed messages with -32600', async function() {
        t.raw('42\n');
        t.raw(JSON.stringify({ jsonrpc: '2.0', id: 'm', method: 5 }) + '\n');
        t.raw(JSON.stringify({ jsonrpc: '2.0', id: { bad: true }, method: 'ping' }) + '\n');
        t.raw(JSON.stringify({ jsonrpc: '2.0', id: 'p', method: 'ping', params: 'oops' }) + '\n');
        await t.rpc('ping');
        const errors = t.responses.filter((m) => m.error);
        assert.deepStrictEqual(errors.map((m) => [m.id, m.error.code]), [[null, -32600], ['m', -32600], [null, -32600], ['p', -32600]]);
    });

    it('should answer a request with a null id with -32600, as MCP does not allow null ids', async function() {
        t.raw(JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }) + '\n');
        const response = await t.waitFor((m) => m.id === null);
        assert.deepStrictEqual(response, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        assert.deepStrictEqual(await t.adapter.handleMessage({ jsonrpc: '2.0', id: null, method: 'ping' }), response);
        assert.deepStrictEqual(await t.adapter.handleMessage({ jsonrpc: '2.0', id: 0, method: 'ping' }), { jsonrpc: '2.0', id: 0, result: {} });
    });

    it('should answer a batch with an array of responses, skipping notifications', async function() {
        t.raw(JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'ping' },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 2, method: 'ping' }
        ]) + '\n');
        const response = await t.waitFor((m) => Array.isArray(m));
        assert.deepStrictEqual(response, [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }]);
        assert.strictEqual(t.adapter.initialized, true);
    });

    it('should answer an empty batch with a single -32600 error', async function() {
        t.raw('[]\n');
        const response = await t.waitFor((m) => m.error);
        assert.deepStrictEqual(response, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    });

    it('should write nothing for a batch of notifications', async function() {
        t.raw(JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]) + '\n');
        await t.rpc('ping');
        assert.strictEqual(t.lines.length, 1);
    });

    it('should ignore responses sent by the client', async function() {
        t.raw(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }) + '\n');
        t.raw(JSON.stringify({ jsonrpc: '2.0', id: 98, error: { code: 1, message: 'x' } }) + '\n');
        await t.rpc('ping');
        assert.strictEqual(t.lines.length, 1);
    });

    it('should answer invalid params with -32602', async function() {
        const notObject = await t.request({ jsonrpc: '2.0', id: 'a', method: 'tools/list', params: [1, 2] });
        assert.strictEqual(notObject.error.code, -32602);
        const noName = await t.rpc('tools/call', { arguments: {} });
        assert.strictEqual(noName.error.code, -32602);
        assert.match(noName.error.message, /name must be a string/);
        const badArgs = await t.rpc('tools/call', { name: 'chat', arguments: ['hello'] });
        assert.strictEqual(badArgs.error.code, -32602);
        assert.match(badArgs.error.message, /arguments must be an object/);
    });

    it('should handle requests concurrently', async function() {
        const gate = deferred();
        t.adapter.tool('slow');
        t.controller.on('tool:slow', async () => {
            await gate.promise;
        });
        const slow = t.callTool('slow', {});
        const ping = await t.rpc('ping');
        assert.deepStrictEqual(ping.result, {});
        gate.resolve();
        await slow;
        assert.strictEqual(t.responses[0].id, ping.id);
    });

    it('should turn handler errors into -32603 responses', async function() {
        const response = await t.adapter.handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'chat', arguments: { message: 'x' } } });
        assert.ok(response.result);

        const adapter = t.adapter;
        const original = adapter.callTool;
        adapter.callTool = async () => {
            throw new Error('kaput');
        };
        try {
            const failed = await adapter.handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'chat', arguments: { message: 'x' } } });
            assert.deepStrictEqual(failed, { jsonrpc: '2.0', id: 6, error: { code: -32603, message: 'Internal error: kaput' } });
        } finally {
            adapter.callTool = original;
        }
    });
});

describe('JsonRpcConnection', function() {
    let input;
    let output;
    let written;

    beforeEach(function() {
        input = new PassThrough();
        output = new PassThrough();
        written = [];
        output.on('data', (chunk) => {
            chunk.toString().split('\n').filter((line) => line).forEach((line) => written.push(JSON.parse(line)));
        });
    });

    it('should wait for pending messages before calling onClose listeners', async function() {
        const gate = deferred();
        const closed = deferred();
        const connection = new JsonRpcConnection(input, output, async (message) => {
            await gate.promise;
            return { jsonrpc: '2.0', id: message.id, result: 'done' };
        });
        connection.onClose(() => closed.resolve(written.slice()));
        connection.start();
        input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slow' }) + '\n');
        input.end();
        await sleep(20);
        assert.strictEqual(connection.pending.size, 1);
        gate.resolve();
        const atClose = await closed.promise;
        assert.deepStrictEqual(atClose, [{ jsonrpc: '2.0', id: 1, result: 'done' }]);
        assert.strictEqual(connection.pending.size, 0);
    });

    it('should drop messages sent after close() and not call onClose listeners', async function() {
        let closeCalls = 0;
        const connection = new JsonRpcConnection(input, output, async () => null);
        connection.onClose(() => closeCalls++);
        connection.start();
        connection.close();
        connection.close();
        connection.send({ jsonrpc: '2.0', method: 'late' });
        input.end();
        await sleep(10);
        assert.deepStrictEqual(written, []);
        assert.strictEqual(closeCalls, 0);
    });

    it('should answer with an internal error when a handler rejects', async function() {
        const connection = new JsonRpcConnection(input, output, async () => {
            throw new Error('boom');
        });
        connection.start();
        input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'x' }) + '\n');
        input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notified' }) + '\n');
        await sleep(10);
        assert.deepStrictEqual(written, [{ jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'Internal error: boom' } }]);
        connection.close();
    });

    it('should replace a response that cannot be serialized with an internal error', async function() {
        const connection = new JsonRpcConnection(input, output, async () => null);
        connection.start();
        const circular = {};
        circular.self = circular;
        connection.send({ jsonrpc: '2.0', id: 4, result: circular });
        connection.send({ jsonrpc: '2.0', method: 'notifications/message', params: circular });
        connection.send([{ jsonrpc: '2.0', id: 5, result: 'ok' }, { jsonrpc: '2.0', id: 6, result: circular }]);
        await sleep(10);
        assert.strictEqual(written.length, 2);
        assert.strictEqual(written[0].id, 4);
        assert.strictEqual(written[0].error.code, -32603);
        assert.match(written[0].error.message, /could not be serialized/);
        assert.strictEqual(written[1][0].result, 'ok');
        assert.strictEqual(written[1][1].error.code, -32603);
        connection.close();
    });

    it('should close when the output stream fails', async function() {
        const closed = deferred();
        const connection = new JsonRpcConnection(input, output, async () => null);
        connection.onClose(() => closed.resolve());
        connection.start();
        output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        await closed.promise;
        connection.send({ jsonrpc: '2.0', method: 'late' });
        await sleep(10);
        assert.deepStrictEqual(written, []);
    });

    it('should close when the input stream fails', async function() {
        const closed = deferred();
        const connection = new JsonRpcConnection(input, output, async () => null);
        connection.onClose(() => closed.resolve());
        connection.start();
        input.emit('error', new Error('read EIO'));
        await closed.promise;
    });
});
