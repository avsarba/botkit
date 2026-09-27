const assert = require('assert');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * The environment for child processes: no colors, and no DEBUG output on stderr.
 */
function childEnv() {
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.DEBUG;
    return env;
}

/**
 * Run a script from packages/examples with the given stdin, and collect its exit code and output.
 */
function runScript(args, input = '') {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`node ${ args.join(' ') } did not exit within 10s.\nstdout:\n${ stdout }\nstderr:\n${ stderr }`));
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
        child.stdin.end(input);
    });
}

/**
 * A minimal MCP client for ops-desk/mcp.js: it sends one JSON-RPC message per line and matches responses by id.
 */
class McpClient {
    constructor() {
        this.child = spawn(process.execPath, ['ops-desk/mcp.js'], { cwd: ROOT, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        this.lines = [];
        this.stderr = '';
        this.waiting = new Map();
        this.child.stderr.on('data', (chunk) => {
            this.stderr += chunk;
        });
        readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
            this.lines.push(line);
            let message;
            try {
                message = JSON.parse(line);
            } catch (err) {
                return; // reported by the test, which checks every line
            }
            if (message && this.waiting.has(message.id)) {
                this.waiting.get(message.id).resolve(message);
                this.waiting.delete(message.id);
            }
        });
        this.exited = new Promise((resolve) => {
            this.child.on('close', (code) => {
                this.code = code;
                this.waiting.forEach((waiter) => waiter.reject(new Error(`The server exited (code ${ code }) before answering.\nstderr:\n${ this.stderr }`)));
                this.waiting.clear();
                resolve(code);
            });
        });
        this.nextId = 1;
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.waiting.set(id, { resolve, reject });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method, params) {
        this.send({ jsonrpc: '2.0', method, params });
    }

    async chat(message, session = 'default') {
        const response = await this.request('tools/call', { name: 'chat', arguments: { message, session } });
        assert.ok(response.result, JSON.stringify(response));
        return response.result;
    }

    send(message) {
        this.child.stdin.write(JSON.stringify(message) + '\n');
    }

    /**
     * Close stdin and wait for the exit code, killing the server after `ms`.
     */
    async end(ms = 10000) {
        this.child.stdin.end();
        let timer;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`The server did not exit within ${ ms }ms after stdin closed.\nstderr:\n${ this.stderr }`)), ms);
        });
        try {
            return await Promise.race([this.exited, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    kill() {
        if (this.code === undefined) {
            this.child.kill('SIGKILL');
        }
    }
}

describe('Ops Desk processes', function() {
    this.timeout(20000);

    describe('cli.js', function() {
        it('should run the deploy dialog unattended from an answers file', async function() {
            const { code, stdout, stderr } = await runScript(['ops-desk/cli.js', '--run', 'deploy', '--answers', 'ops-desk/answers.json', '--non-interactive']);
            assert.strictEqual(code, 0, `exit code ${ code }\nstdout:\n${ stdout }\nstderr:\n${ stderr }`);
            assert.ok(stdout.includes('you> billing (from answers)'), stdout);
            assert.ok(stdout.includes('Deployed billing 1.4.2 to production.'), stdout);
            assert.ok(!/error/i.test(stderr), stderr);
            // --run skips the greeting
            assert.ok(!stdout.includes('Ops Desk ready'), stdout);
        });

        it('should exit with code 2 when an answer is missing', async function() {
            const { code, stdout, stderr } = await runScript(['ops-desk/cli.js', '--run', 'deploy', '--non-interactive']);
            assert.strictEqual(code, 2, `exit code ${ code }\nstdout:\n${ stdout }\nstderr:\n${ stderr }`);
            assert.ok(stderr.includes('Missing answer for "service": Which service?'), stderr);
        });

        it('should process piped commands and quit', async function() {
            const { code, stdout, stderr } = await runScript(['ops-desk/cli.js'], 'status\nhelp\n/quit\n');
            assert.strictEqual(code, 0, `exit code ${ code }\nstderr:\n${ stderr }`);
            assert.ok(stdout.includes('Ops Desk ready. Pick one or type "help".'), stdout);
            assert.ok(stdout.includes('you> status'), stdout);
            assert.ok(stdout.includes('billing'), stdout);
            assert.ok(stdout.includes('deploy'), stdout);
        });

        it('should write only JSON lines in --json mode', async function() {
            const { code, stdout, stderr } = await runScript(['ops-desk/cli.js', '--json'], 'status\n');
            assert.strictEqual(code, 0, `exit code ${ code }\nstderr:\n${ stderr }`);
            const lines = stdout.split('\n').filter((line) => line.trim() !== '');
            assert.ok(lines.length >= 2, stdout);
            const messages = lines.map((line) => JSON.parse(line));
            assert.ok(messages.some((message) => message.type === 'message' && /billing\s+1\.4\.2\s+1\.4\.1/.test(message.text)), stdout);
        });

        it('should reject unknown options with a usage message', async function() {
            const { code, stdout, stderr } = await runScript(['ops-desk/cli.js', '--bogus']);
            assert.strictEqual(code, 2);
            assert.strictEqual(stdout, '');
            assert.ok(stderr.includes('error: Unknown option "--bogus"'), stderr);
            assert.ok(stderr.includes('Usage: node ops-desk/cli.js'), stderr);
        });

        it('should report an unreadable answers file', async function() {
            const { code, stderr } = await runScript(['ops-desk/cli.js', '--run', 'deploy', '--answers', 'ops-desk/missing.json']);
            assert.strictEqual(code, 2);
            assert.ok(stderr.includes('Could not read the answers file ops-desk/missing.json'), stderr);
        });

        it('should report an unknown dialog and still exit', async function() {
            const { code, stderr } = await runScript(['ops-desk/cli.js', '--run', 'rollback']);
            assert.strictEqual(code, 1);
            assert.ok(stderr.includes('Unknown dialog "rollback"'), stderr);
        });
    });

    describe('mcp.js', function() {
        let client;

        afterEach(function() {
            if (client) {
                client.kill();
                client = null;
            }
        });

        it('should serve Ops Desk to an MCP client over stdio', async function() {
            client = new McpClient();

            const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } });
            assert.strictEqual(init.result.protocolVersion, '2025-06-18');
            assert.deepStrictEqual(init.result.serverInfo, { name: 'ops-desk', version: '1.0.0', title: 'Ops Desk' });
            assert.ok(init.result.instructions.startsWith('Ops Desk manages deploys'), init.result.instructions);
            client.notify('notifications/initialized');

            const list = await client.request('tools/list', {});
            assert.deepStrictEqual(list.result.tools.map((tool) => tool.name), ['chat', 'service_status', 'list_jobs']);

            let result = await client.chat('deploy');
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'service');
            result = await client.chat('search');
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'env');
            result = await client.chat('staging');
            assert.ok(result.content[0].text.includes('Deployed search 0.9.9 to staging.'), result.content[0].text);
            assert.strictEqual(result.structuredContent.awaitingInput, false);

            const status = await client.request('tools/call', { name: 'service_status', arguments: {} });
            assert.strictEqual(status.result.structuredContent.services[2].staging, '0.9.9');

            const code = await client.end();
            assert.strictEqual(code, 0, client.stderr);
            client.lines.forEach((line) => {
                assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${ line }`);
            });
            assert.ok(!/error/i.test(client.stderr), client.stderr);
        });
    });
});
