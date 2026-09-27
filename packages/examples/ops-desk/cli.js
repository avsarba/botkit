#!/usr/bin/env node
/**
 * Ops Desk in the terminal.
 *
 *   node ops-desk/cli.js                          an interactive session (or pipe commands in)
 *   node ops-desk/cli.js --json                   one JSON object per line, for other programs
 *   node ops-desk/cli.js --run deploy             run the deploy wizard, then exit with its status
 *   node ops-desk/cli.js --run deploy --answers ops-desk/answers.json --non-interactive
 *                                                 the same wizard as an unattended CI step
 */
const fs = require('fs');
const path = require('path');
const { CliAdapter } = require('botbuilder-adapter-cli');
const createOpsDesk = require('./opsdesk');

const USAGE = [
    'Usage: node ops-desk/cli.js [options]',
    '',
    'Options:',
    '  --run <dialog>       Run a dialog (such as deploy) from start to finish, then exit with its status',
    '  --answers <file>     A JSON file of answers to dialog questions, keyed by question key',
    '  --non-interactive    Never wait for input: fail with exit code 2 when an answer is missing',
    '  --json               Write one JSON object per line instead of text',
    '  --user <name>        The user id to talk as (default: $USER)',
    '  -h, --help           Show this help',
    ''
].join('\n');

/**
 * Parse command-line arguments. Values can follow the option (`--run deploy`) or use `=` (`--run=deploy`).
 *
 * ```javascript
 * parseArgs(['--run', 'deploy', '--non-interactive']);
 * // { json: false, answersFile: undefined, run: 'deploy', nonInteractive: true, user: undefined, help: false }
 * ```
 *
 * @param argv The arguments, without the node binary and script path.
 * @returns `{ json, answersFile, run, nonInteractive, user, help }`.
 * @throws Error for an unknown option or a missing value.
 */
function parseArgs(argv) {
    const args = { json: false, answersFile: undefined, run: undefined, nonInteractive: false, user: undefined, help: false };
    for (let i = 0; i < argv.length; i++) {
        let name = argv[i];
        let value;
        const eq = name.indexOf('=');
        if (name.startsWith('--') && eq > 0) {
            value = name.slice(eq + 1);
            name = name.slice(0, eq);
        }
        const flag = (field) => {
            if (value !== undefined) {
                throw new Error(`${ name } does not take a value`);
            }
            args[field] = true;
        };
        const option = (field) => {
            if (value === undefined) {
                if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
                    throw new Error(`${ name } needs a value`);
                }
                value = argv[++i];
            }
            if (value === '') {
                throw new Error(`${ name } needs a value`);
            }
            args[field] = value;
        };
        switch (name) {
        case '--json':
            flag('json');
            break;
        case '--non-interactive':
            flag('nonInteractive');
            break;
        case '-h':
        case '--help':
            flag('help');
            break;
        case '--answers':
            option('answersFile');
            break;
        case '--run':
            option('run');
            break;
        case '--user':
            option('user');
            break;
        default:
            throw new Error(`Unknown option "${ name }"`);
        }
    }
    return args;
}

/**
 * Read an answers file: a JSON object whose values are strings, or arrays of strings for questions asked more than once.
 */
function readAnswers(file) {
    let answers;
    try {
        answers = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    } catch (err) {
        throw new Error(`Could not read the answers file ${ file }: ${ err.message }`);
    }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
        throw new Error(`The answers file ${ file } must contain a JSON object, such as { "service": "billing" }`);
    }
    return answers;
}

/**
 * Create Ops Desk on a CliAdapter.
 *
 * ```javascript
 * const { adapter, ready } = createCli({ answers: { service: 'api', env: 'staging' }, nonInteractive: true, autoStart: false });
 * await ready;
 * const result = await adapter.run({ dialog: 'deploy' });
 * ```
 *
 * @param options CliAdapter options (format, answers, nonInteractive, user, input, output...) and createOpsDesk options
 * (storage, clock, schedulerAutoStart, watchInterval, reportOutput, fleet), in one object.
 * @returns `{ adapter, controller, scheduler, fleet, ready }`.
 */
function createCli(options = {}) {
    const adapter = new CliAdapter(options);
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
    let args;
    let answers;
    try {
        args = parseArgs(process.argv.slice(2));
        answers = args.answersFile ? readAnswers(args.answersFile) : undefined;
    } catch (err) {
        process.stderr.write(`error: ${ err.message }\n\n${ USAGE }`);
        process.exitCode = 2;
        return;
    }
    if (args.help) {
        process.stdout.write(USAGE);
        return;
    }

    // autoStart: false, so the session starts in run() after the startup jobs are declared, and a --run dialog is not preceded by the greeting.
    const cli = createCli({
        format: args.json ? 'json' : 'text',
        answers: answers,
        nonInteractive: args.nonInteractive,
        user: args.user,
        autoStart: false
    });
    try {
        await cli.ready;
        const result = await cli.adapter.run(args.run ? { dialog: args.run } : {});
        process.exitCode = result.exitCode;
    } catch (err) {
        process.stderr.write(`error: ${ err.message }\n`);
        process.exitCode = 1;
        // stop the scheduler's timer so the process can exit
        await cli.controller.shutdown();
    }
}

if (require.main === module) {
    main();
}

module.exports = { createCli, parseArgs };
