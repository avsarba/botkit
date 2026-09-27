/**
 * Checks that the documentation owned by this package still matches what it documents:
 * commands and code from the guides are run, and the docs navigation index is compared with the build script.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, '..', 'docs');

/**
 * The environment for child processes: no colors, and no DEBUG output on stderr.
 */
function childEnv() {
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.DEBUG;
    return env;
}

/**
 * Start a child process in packages/examples. Resolves with its stdout lines once `until(lines)` is true,
 * then ends its stdin and waits for it to exit (or kills it after 10s).
 */
function talkTo(command, args, input, until) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: ROOT, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        const lines = [];
        let stderr = '';
        let done = false;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${ args.join(' ') } did not answer within 10s.\nstdout:\n${ lines.join('\n') }\nstderr:\n${ stderr }`));
        }, 10000);
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, lines, stderr });
        });
        readline.createInterface({ input: child.stdout }).on('line', (line) => {
            lines.push(line);
            if (!done && until(lines)) {
                done = true;
                child.stdin.end();
            }
        });
        child.stdin.write(input);
    });
}

/**
 * Parse every non-empty line as JSON, with the whole output in the error message when one does not parse.
 */
function parseLines(lines) {
    return lines.filter((line) => line.trim()).map((line) => {
        try {
            return JSON.parse(line);
        } catch (err) {
            throw new assert.AssertionError({ message: `stdout has a line that is not JSON: ${ JSON.stringify(line) }\nstdout:\n${ lines.join('\n') }` });
        }
    });
}

describe('Docs', function() {
    this.timeout(20000);

    describe('packages/examples/readme.md', function() {
        it('should document an npm command that writes only JSON-RPC to stdout', async function() {
            // npm_execpath is set when the tests run with `npm test`
            const npm = process.env.npm_execpath;
            if (!npm || !/npm-cli\.js$/.test(npm)) {
                this.skip();
            }
            const readme = fs.readFileSync(path.join(ROOT, 'readme.md'), 'utf8');
            const line = readme.split('\n').find((text) => /^npm run\b.*\bstart:mcp\b/.test(text));
            assert.ok(line, 'the readme has no npm command for start:mcp');
            const args = line.split('#')[0].trim().split(/\s+/).slice(1);

            const { code, lines } = await talkTo(process.execPath, [npm].concat(args), '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
                (seen) => seen.some((text) => text.includes('"id":1')));
            assert.deepStrictEqual(parseLines(lines), [{ jsonrpc: '2.0', id: 1, result: {} }]);
            assert.strictEqual(code, 0);
        });
    });

    describe('advanced.md: How to build a new adapter', function() {
        it('should work as written, and write only JSON lines to stdout', async function() {
            const guide = fs.readFileSync(path.join(DOCS, 'advanced.md'), 'utf8');
            const section = guide.slice(guide.indexOf('## How to build a new adapter'));
            const example = /```javascript\n([\s\S]*?)\n```/.exec(section)[1];
            const usage = /Use it like any other adapter: `([^`]+)`/.exec(section)[1];
            const script = [
                example,
                'const { Botkit } = require(\'botkit\');',
                usage + ';',
                'controller.hears(\'hi\', \'message\', async (bot, message) => { await bot.reply(message, \'hello\'); });'
            ].join('\n');

            const { code, lines, stderr } = await talkTo(process.execPath, ['-e', script], '{"type":"message","user":"ann","text":"hi"}\n',
                (seen) => seen.some((text) => text.includes('hello')));
            const messages = parseLines(lines);
            assert.deepStrictEqual(messages.map((message) => [message.type, message.text, message.to, message.conversation]), [
                ['message', 'hello', 'ann', 'ann']
            ]);
            // the input ended: with nothing else running, the process exits by itself
            assert.strictEqual(code, 0, stderr);
        });
    });

    describe('index.json', function() {
        const index = JSON.parse(fs.readFileSync(path.join(DOCS, 'index.json'), 'utf8'));
        const parse = fs.readFileSync(path.join(DOCS, 'build', 'parse.js'), 'utf8');
        const build = fs.readFileSync(path.join(DOCS, 'build', 'build.sh'), 'utf8');

        // build.sh: --name "Botkit for the Command Line" ... --json build/cli.json
        const names = {};
        for (const match of build.matchAll(/--name "([^"]+)".*--json build\/([\w-]+)\.json/g)) {
            names[match[2]] = match[1];
        }

        it('should list every reference page that parse.js generates, in order', function() {
            const expected = Array.from(parse.matchAll(/^generateReference\(__dirname \+ '\/([\w-]+)\.json',\s*__dirname \+ '\/\.\.\/(reference\/[\w-]+\.md)'\)/gm))
                .map((match) => ({ name: names[match[1]], path: match[2] }));
            assert.ok(expected.length >= 11, JSON.stringify(expected));
            assert.deepStrictEqual(index.reference.map((entry) => ({ name: entry.name, path: entry.path })), expected);
        });

        it('should list every platform and plugin page that parse.js generates, in order', function() {
            const pages = (kind, dir) => Array.from(parse.matchAll(new RegExp(`^${ kind }\\(.*\\{name: '([^']+)'\\}\\s*,\\s*__dirname \\+ '\\/\\.\\.\\/(${ dir }\\/[\\w-]+\\.md)'\\)`, 'gm')))
                .map((match) => ({ name: match[1], path: match[2] }));
            assert.deepStrictEqual(index.adapters, pages('generateAdapter', 'platforms'));
            assert.deepStrictEqual(index.plugins, pages('generatePlugin', 'plugins'));
        });

        it('should match the class index and the platform and plugin indexes', function() {
            // reference/index.md, platforms/index.md and plugins/index.md are generated from the same lists
            const toc = fs.readFileSync(path.join(DOCS, 'reference', 'index.md'), 'utf8');
            const fromToc = [];
            for (const match of toc.matchAll(/^( *)\* \[([^\]]+)\]\(\.\.\/(reference\/[\w-]+\.md)(?:#(\w+))?\)/gm)) {
                if (!match[1]) {
                    fromToc.push({ name: match[2], path: match[3], classes: [] });
                } else {
                    fromToc[fromToc.length - 1].classes.push(match[4]);
                }
            }
            assert.deepStrictEqual(index.reference.map((entry) => ({ name: entry.name, path: entry.path, classes: entry.classes.map((c) => c.name) })), fromToc);

            const links = (file) => Array.from(fs.readFileSync(path.join(DOCS, file), 'utf8').matchAll(/^\* \[([^\]]+)\]\(\.\.\/((?:platforms|plugins)\/[\w-]+\.md)\)/gm))
                .map((match) => ({ name: match[1], path: match[2] }));
            assert.deepStrictEqual(index.adapters, links('platforms/index.md'));
            assert.deepStrictEqual(index.plugins, links('plugins/index.md'));
        });
    });

    describe('ops-desk entry points', function() {
        it('should be executable when they start with a shebang', function() {
            if (process.platform === 'win32') {
                this.skip();
            }
            for (const file of ['ops-desk/cli.js', 'ops-desk/mcp.js']) {
                const full = path.join(ROOT, file);
                if (fs.readFileSync(full, 'utf8').startsWith('#!')) {
                    assert.ok(fs.statSync(full).mode & 0o111, `${ file } starts with #! but is not executable`);
                }
            }
        });
    });
});
