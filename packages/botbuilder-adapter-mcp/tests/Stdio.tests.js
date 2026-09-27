const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const FIXTURE = path.join(__dirname, 'fixtures', 'stdio-server.js');

/**
 * Run the fixture server with the given input lines, close its stdin, and collect its output.
 */
function runServer(messages) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`The server did not exit within 10s. stderr:\n${ stderr }`));
        }, 10000);
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        messages.forEach((message) => child.stdin.write(JSON.stringify(message) + '\n'));
        child.stdin.end();
    });
}

describe('MCP over stdio', function() {
    this.timeout(15000);

    it('should keep stdout clean and exit when stdin closes', async function() {
        const { code, stdout, stderr } = await runServer([
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1.0.0' } } },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chat', arguments: { message: 'hello' } } }
        ]);

        assert.strictEqual(code, 0, `exit code ${ code }, stderr:\n${ stderr }`);
        const lines = stdout.split('\n').filter((line) => line.trim());
        const messages = lines.map((line) => JSON.parse(line));
        assert.deepStrictEqual(messages.map((message) => message.id), [1, 2]);
        assert.strictEqual(messages[0].result.protocolVersion, '2025-06-18');
        assert.strictEqual(messages[0].result.serverInfo.name, 'stdio-bot');
        assert.strictEqual(messages[1].result.content[0].text, 'Hi from stdio');
        assert.strictEqual(messages[1].result.structuredContent.replies[0].text, 'Hi from stdio');

        assert.ok(stderr.includes('noise from handler'), stderr);
        assert.ok(stderr.includes('stdio-test'), stderr);
        assert.ok(stderr.includes('Enabling plugin'), stderr);
        assert.ok(stderr.includes('Bot is shutting down!'), stderr);
    });
});
