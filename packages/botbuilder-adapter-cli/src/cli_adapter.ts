/**
 * @module botbuilder-adapter-cli
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Activity, ActivityTypes, BotAdapter, ConversationAccount, ConversationReference, ResourceResponse, TurnContext } from 'botbuilder';
import { Botkit, BotkitMessage, BotkitPendingQuestion, BotWorker } from 'botkit';
import * as crypto from 'crypto';
import * as Debug from 'debug';
import * as readline from 'readline';
import * as util from 'util';
import { CliBotWorker } from './botworker';
import { CliChoice, RenderOptions, renderActivity, renderJson, stripAnsi, unescapeHtml } from './render';
import { TurnQueue, withTimeout } from './turn_queue';
const debug = Debug('botkit:cli');

/**
 * A slash-command for the terminal session, registered with the `commands` option.
 * Either a function, or an object with a `description` (shown by `/help`) and a `run` function.
 * The function receives the text after the command name and the adapter.
 * It may be async; a returned string or array of strings is printed.
 */
export type CliCommand = ((args: string, adapter: CliAdapter) => any) | { description?: string; run: (args: string, adapter: CliAdapter) => any };

/**
 * How a session or a [run()](#run) ended.
 */
export type CliRunStatus = 'completed' | 'canceled' | 'timeout' | 'eof' | 'quit' | 'interrupted' | 'failed';

/**
 * Options passed to the CliAdapter constructor. Every option is optional.
 */
export interface CliAdapterOptions {
    /**
     * The stream to read user input from, one line per message. Defaults to `process.stdin`.
     */
    input?: NodeJS.ReadableStream;

    /**
     * The stream the bot's messages are written to. Defaults to `process.stdout`.
     */
    output?: NodeJS.WritableStream;

    /**
     * The stream errors are written to. Defaults to `process.stderr`.
     */
    errorOutput?: NodeJS.WritableStream;

    /**
     * The id of the user at the keyboard (`message.user`). Defaults to `$USER`, `$USERNAME` or `'user'`. Change it later with `/as <user>`.
     */
    user?: string;

    /**
     * The conversation id (`message.channel`). Defaults to a random id such as `cli-1a2b3c4d`, so every session starts fresh. Change it later with `/new`.
     */
    conversation?: string;

    /**
     * The prompt shown in terminal mode and used to echo input. Defaults to `'you> '`.
     */
    prompt?: string;

    /**
     * The name in front of bot messages, as in `bot> Hello`. Defaults to `'bot'`.
     */
    botName?: string;

    /**
     * `'text'` for people, or `'json'` to write one JSON object per line for programs. Defaults to `'text'`.
     */
    format?: 'text' | 'json';

    /**
     * Use ANSI colors. Defaults to true when the output is a TTY and the `NO_COLOR` environment variable is not set.
     * Errors are colored when `errorOutput` is a TTY, unless this option is set.
     */
    color?: boolean;

    /**
     * Run readline in terminal mode, with a prompt, line editing, history, Tab completion of commands and Ctrl+C handling.
     * Defaults to true when both input and output are TTYs. When false, each line read is echoed as `you> <line>`.
     */
    terminal?: boolean;

    /**
     * Send a `conversationUpdate` activity with `membersAdded: [{ id: user }]` when the session starts. Defaults to true.
     */
    greeting?: boolean;

    /**
     * Answers for dialog questions, keyed by the question's `key`. A string answers once; an array answers several times in order.
     * The value may be a choice's value, its title or its number. Used after every turn in which a question is waiting.
     */
    answers?: { [key: string]: string | string[] };

    /**
     * Never wait for a person: when a question has no answer in `answers` and no more input is queued, use its `channelData.default`
     * or end the session with status `failed` and exit code 2. Input that is not a TTY, such as a pipe or a file, is read to its end first,
     * so piped lines can answer questions. A default is not used again for a question that the dialog asks again straight after it.
     * Turn errors also end the session. Defaults to false.
     */
    nonInteractive?: boolean;

    /**
     * Pause for `delay` activities. Defaults to true when the output is a TTY.
     */
    honorDelays?: boolean;

    /**
     * The longest pause for a `delay` activity, in milliseconds. Defaults to 3000.
     */
    maxDelay?: number;

    /**
     * The longest a turn or a custom command may take, in milliseconds, before it fails with a `TurnTimeoutError`. Defaults to 30000; 0 disables the limit.
     */
    turnTimeout?: number;

    /**
     * Custom slash-commands, keyed by name without the slash. Each is a function `(args, adapter) => result` or an object `{ description, run }`;
     * a returned string or array of strings is printed, and `/help` lists the descriptions.
     */
    commands?: { [name: string]: CliCommand };

    /**
     * Start reading input automatically once Botkit is ready. Defaults to true. Set to false to call [start()](#start) or [run()](#run) yourself.
     */
    autoStart?: boolean;

    /**
     * Call `controller.shutdown()` when the session ends (end of input, `/quit`, [close()](#close), Ctrl+C, a finished run or a failure),
     * so timers and plugins stop and the process can exit. Defaults to true.
     */
    shutdownOnClose?: boolean;

    /**
     * Decode the HTML entities mustache adds to `{{vars.x}}` in dialog templates, such as `&#x2F;` in URLs. Defaults to true.
     */
    unescapeHtml?: boolean;

    /**
     * Show extra `channelData` fields as `data: <json>` and print error stacks. Defaults to false.
     */
    verbose?: boolean;

    /**
     * Send `console.log`, `console.info`, `console.debug` and `console.dir` to `errorOutput` from the moment the adapter is created
     * until the session ends and Botkit has shut down, so they cannot corrupt the output.
     * Defaults to true when `format` is `'json'` and the output is `process.stdout`.
     */
    redirectConsole?: boolean;
}

/**
 * Options for [run()](#run).
 */
export interface CliRunOptions {
    /**
     * The id of a BotkitConversation, added with `controller.addDialog()`, to run from the start. Omit it to run an interactive session.
     */
    dialog?: string;

    /**
     * Initial variables for the dialog, available as `{{vars.x}}` and in the result.
     */
    vars?: { [key: string]: any };

    /**
     * End the session when the dialog finishes. Defaults to true when `dialog` is set.
     */
    closeOnComplete?: boolean;
}

/**
 * The result of [run()](#run).
 */
export interface CliRunResult {
    /**
     * How the run ended: `completed`, `canceled` or `timeout` (the dialog ended with that status, or `canceled` when it was removed without ending),
     * `eof` (the input ended), `quit` (`/quit`, `/exit` or `close()`), `interrupted` (Ctrl+C)
     * or `failed` (an error, or a missing answer in non-interactive mode).
     */
    status: CliRunStatus;

    /**
     * The dialog's variables, including the collected answers, when the dialog ended or an answer was missing.
     */
    vars?: { [key: string]: any };

    /**
     * A suggested process exit code: 0 for success, 1 for a canceled, timed out, unfinished or failed dialog, 2 for a missing answer and 130 for Ctrl+C.
     */
    exitCode: number;

    /**
     * The error that ended the run, when the status is `failed` because of an error.
     */
    error?: Error;
}

/**
 * The remembered menu for a conversation and user.
 */
interface CliPrompt {
    choices: CliChoice[];
    default?: string;
    text?: string;
    /** Identifies the pending question the prompt belongs to; null when none was pending, undefined when unknown. */
    question?: string | null;
    /** Increases with every menu shown, to tell which of two menus came last. */
    seq: number;
}

/**
 * Per-turn output collector, stored in turnState.
 */
interface CliTurnCollector {
    lines: string[];
    done: boolean;
    prompt?: CliPrompt;
    lastText?: string;
}

/**
 * The run() in progress.
 */
interface CliActiveRun {
    dialog?: string;
    closeOnComplete: boolean;
    resolve: (result: CliRunResult) => void;
    /** `${ conversation }|${ user }` of the turn that started the dialog. */
    address?: string;
    outcome?: { status: CliRunStatus; vars: any };
}

/**
 * One unit of work for the input queue.
 */
interface CliQueueItem {
    line?: string;
    activity?: Partial<Activity>;
    source: 'input' | 'submit' | 'answer' | 'internal';
    /** An automatic answer that uses the question's default. */
    isDefault?: boolean;
    echo?: string;
    run?: CliActiveRun;
    resolve?: (lines: string[]) => void;
    reject?: (err: Error) => void;
}

const TURN_STATE_KEY = 'cli.lines';
const BUILTIN_COMMANDS = ['help', 'quit', 'exit', 'event', 'as', 'new', 'state', 'raw', 'json'];
const COMMAND_NAME = /^[A-Za-z][\w:.-]*$/;
const COMMAND_LINE = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/;
const ESC = '\u001b';
const RESET = `${ ESC }[0m`;
const BOLD_CYAN = `${ ESC }[1;36m`;
const DIM = `${ ESC }[2m`;
const RED = `${ ESC }[31m`;

function hasOwn(object: any, key: string): boolean {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value: any): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function newConversationId(): string {
    return 'cli-' + crypto.randomBytes(4).toString('hex');
}

function errorMessage(err: any): string {
    return err && err.message ? err.message : String(err);
}

function safeJson(value: any): string {
    try {
        return JSON.stringify(value);
    } catch (err) {
        return util.inspect(value, { depth: 4, breakLength: Infinity });
    }
}

function questionId(question: BotkitPendingQuestion | null): string | null {
    return question ? `${ question.stack.join('>') }#${ question.thread }#${ question.index }` : null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

type StreamErrorHandler = (err: any) => void;

/**
 * The sessions listening for errors on each stream. A stream gets one 'error' listener, shared by every adapter that uses it,
 * so adapters do not pile up listeners on process.stdout, and an error after the session has closed cannot crash the process.
 */
const streamErrorHandlers = new WeakMap<object, Set<StreamErrorHandler>>();

/**
 * Call `handler` for errors on `stream` until the returned function is called.
 */
function onStreamError(stream: NodeJS.EventEmitter, handler: StreamErrorHandler): () => void {
    let handlers = streamErrorHandlers.get(stream);
    if (!handlers) {
        const created = new Set<StreamErrorHandler>();
        streamErrorHandlers.set(stream, created);
        stream.on('error', (err: any) => {
            if (!created.size) {
                debug('Ignored an error on a stream that no CLI session uses any more:', errorMessage(err));
            }
            created.forEach((listener) => listener(err));
        });
        handlers = created;
    }
    const set = handlers;
    set.add(handler);
    return (): void => {
        set.delete(handler);
    };
}

/**
 * Connect [Botkit](https://www.npmjs.com/package/botkit) to the command line.
 * Every line typed (or piped) becomes a message that runs through the full Botkit pipeline: middleware, `hears()`, `interrupts()`,
 * `on()` handlers and BotkitConversation dialogs. Replies are printed as `bot> ...`, quick replies become numbered menus,
 * and slash-commands send events, switch users or conversations and show state.
 *
 * The same bot can run as an interactive REPL, as a wizard or installer ([run()](#run) with a dialog),
 * as a scripted CI step (`answers` and `nonInteractive`), or as a Unix filter (`format: 'json'`).
 * This adapter works with Botkit only: pass it to `new Botkit({ adapter })`.
 */
export class CliAdapter extends BotAdapter {
    /**
     * Name used to register this adapter with Botkit.
     * @ignore
     */
    public name = 'CLI Adapter';

    /**
     * The BotWorker class spawned for this adapter: [CliBotWorker](#CliBotWorker).
     * @ignore
     */
    public botkit_worker = CliBotWorker;

    /**
     * The id of the user at the keyboard, sent as `from.id` (`message.user`). `/as <user>` changes it.
     */
    public user: string;

    /**
     * The id of the current conversation, sent as `conversation.id` (`message.channel`). `/new` changes it.
     */
    public conversationId: string;

    private options: Required<CliAdapterOptions>;
    private controller: Botkit;
    private rl: readline.Interface;
    private queue: TurnQueue<CliQueueItem>;
    private started = false;
    private closed = false;
    private inputEnded = false;
    private outputBroken = false;
    private errorOutputBroken = false;
    private errorColor: boolean;
    private shutdownRequested = false;
    private activeRun: CliActiveRun = null;
    private watchedDialogs: string[] = [];
    private answers: { [key: string]: string | string[] } = {};
    private prompts = new Map<string, CliPrompt>();
    private promptSeq = 0;
    /** `${ key }#${ questionId }` of questions answered with their default since the last answer that was not a default. */
    private defaultsUsed = new Set<string>();
    /** The last message text shown by a turn, used to describe a question with a missing answer. */
    private lastAsked: { key: string; text: string };
    private lastSent: Partial<Activity>;
    private incomingCount = 0;
    private outgoingCount = 0;
    /** Pending turn and command timers, unref'd when the session closes so they do not keep the process alive. */
    private timers = new Set<any>();
    private unsubscribers: (() => void)[] = [];
    private restoreConsole: () => void;
    private restoreOnShutdown = false;

    /**
     * Create an adapter that reads messages from a stream (stdin by default) and writes the bot's replies to another (stdout by default).
     *
     * An interactive terminal bot:
     * ```javascript
     * const { Botkit } = require('botkit');
     * const { CliAdapter } = require('botbuilder-adapter-cli');
     *
     * const adapter = new CliAdapter();
     * const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
     *
     * controller.hears('hello', 'message', async (bot, message) => {
     *     await bot.reply(message, 'Hi there!');
     * });
     * ```
     *
     * A scripted installer that fails fast in CI:
     * ```javascript
     * const adapter = new CliAdapter({ answers: require('./answers.json'), nonInteractive: !process.stdin.isTTY });
     * const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
     * controller.addDialog(setupDialog);
     * adapter.run({ dialog: 'setup' }).then((result) => { process.exitCode = result.exitCode; });
     * ```
     *
     * @param options An optional [CliAdapterOptions](#CliAdapterOptions) object.
     */
    public constructor(options: CliAdapterOptions = {}) {
        super();

        const input = options.input || process.stdin;
        const output = options.output || process.stdout;
        const format = options.format || 'text';
        if (format !== 'text' && format !== 'json') {
            throw new Error(`Unknown CliAdapter format "${ format }": use 'text' or 'json'`);
        }
        const commands = options.commands || {};
        Object.keys(commands).forEach((name) => {
            const command = commands[name];
            if (!COMMAND_NAME.test(name)) {
                throw new Error(`CliAdapter command name "${ name }" must start with a letter and contain only letters, digits, _ : . or -`);
            }
            if (typeof command !== 'function' && !(command && typeof command.run === 'function')) {
                throw new Error(`CliAdapter command "/${ name }" must be a function or an object with a run() function`);
            }
        });
        const pick = <T>(value: T, fallback: T): T => (value === undefined || value === null) ? fallback : value;
        const errorOutput = options.errorOutput || process.stderr;
        const noColor = !!process.env.NO_COLOR;

        this.options = {
            input: input,
            output: output,
            errorOutput: errorOutput,
            user: options.user || process.env.USER || process.env.USERNAME || 'user',
            conversation: options.conversation || newConversationId(),
            prompt: pick(options.prompt, 'you> '),
            botName: pick(options.botName, 'bot'),
            format: format,
            color: pick(options.color, !!(output as any).isTTY && !noColor),
            terminal: pick(options.terminal, !!((input as any).isTTY && (output as any).isTTY)),
            greeting: pick(options.greeting, true),
            answers: options.answers || {},
            nonInteractive: pick(options.nonInteractive, false),
            honorDelays: pick(options.honorDelays, !!(output as any).isTTY),
            maxDelay: pick(options.maxDelay, 3000),
            turnTimeout: pick(options.turnTimeout, 30000),
            commands: commands,
            autoStart: pick(options.autoStart, true),
            shutdownOnClose: pick(options.shutdownOnClose, true),
            unescapeHtml: pick(options.unescapeHtml, true),
            verbose: pick(options.verbose, false),
            redirectConsole: pick(options.redirectConsole, format === 'json' && output === process.stdout)
        };

        // errors go to their own stream, so they are colored when that stream is a terminal
        this.errorColor = pick(options.color, !!(errorOutput as any).isTTY && !noColor);
        this.user = this.options.user;
        this.conversationId = this.options.conversation;
        this.answers = this.copyAnswers();
        this.queue = new TurnQueue<CliQueueItem>((item) => this.processItem(item), () => this.promptIfIdle());

        this.unsubscribers.push(onStreamError(output, (err: any) => {
            if (err && err.code === 'EPIPE') {
                debug('Output closed (EPIPE), ending the session');
                this.outputBroken = true;
                this.finish('eof');
            } else {
                this.printError(`output stream: ${ errorMessage(err) }`);
            }
        }));
        this.unsubscribers.push(onStreamError(errorOutput, (err: any) => {
            // there is nowhere left to report errors: stop writing them
            debug('Error output failed, no longer writing errors:', errorMessage(err));
            this.errorOutputBroken = true;
        }));

        // Redirect from the start, so that logs written while Botkit and its plugins boot cannot corrupt the output either.
        // The session restores the console when it ends, including when Botkit shuts down before it started.
        if (this.options.redirectConsole) {
            this.redirectConsole();
        }
    }

    /**
     * Botkit-only: called automatically by Botkit when the adapter is passed to `new Botkit({ adapter })`.
     * Registers the `cli_run` interrupt used by [run()](#run), closes the session on `controller.shutdown()`,
     * and, unless `autoStart` is false, calls [start()](#start) once Botkit is ready.
     * @param botkit The Botkit controller.
     */
    public init(botkit: Botkit): void {
        this.controller = botkit;

        botkit.interrupts(async () => true, 'cli_run', async (bot: BotWorker, message: BotkitMessage) => {
            const value: any = message.value;
            if (value && value.dialog) {
                await bot.cancelAllDialogs();
                await bot.beginDialog(value.dialog, value.vars || {});
            }
        });

        botkit.on('shutdown', async () => {
            // End the session without calling controller.shutdown() again. When start() has added a later shutdown handler
            // that restores the console, the console stays redirected until the app's own shutdown handlers have run.
            this.shutdownRequested = true;
            this.closeSession(this.restoreOnShutdown);
        });

        if (this.options.autoStart) {
            botkit.ready(() => {
                setImmediate(() => {
                    if (!this.started && !this.closed) {
                        this.start();
                    }
                });
            });
        }
    }

    /**
     * Start reading input. Each line becomes a turn, processed strictly one at a time.
     * Called automatically unless `autoStart` is false; calling it again does nothing.
     * When the input ends, the queued turns (including answers they trigger) finish first, then the session ends with status `eof`.
     *
     * ```javascript
     * const adapter = new CliAdapter({ autoStart: false });
     * const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
     * // ... register handlers ...
     * adapter.start();
     * ```
     *
     * @param options Set `greeting` to override the adapter's `greeting` option for this start.
     */
    public start(options: { greeting?: boolean } = {}): void {
        if (this.started || this.closed) {
            debug('start() ignored: the session has already started or closed');
            return;
        }
        this.started = true;

        const terminal = this.options.terminal;
        this.rl = readline.createInterface({
            input: this.options.input,
            output: terminal ? this.options.output : undefined,
            terminal: terminal,
            prompt: this.options.prompt,
            crlfDelay: Infinity,
            completer: terminal ? (line: string): [string[], string] => this.complete(line) : undefined
        });
        this.rl.on('line', (line: string) => {
            this.enqueue({ line: line, source: 'input' });
        });
        this.rl.on('close', () => {
            this.onInputClosed().catch((err) => this.printError(err));
        });
        // Node 16+ readline re-emits input errors; older versions leave them on the input stream
        const onInputError = (err: any): void => {
            if (!this.closed) {
                this.printError(`input stream: ${ errorMessage(err) }`);
                this.finish('failed', { exitCode: 1, error: err instanceof Error ? err : new Error(errorMessage(err)) });
            }
        };
        this.rl.on('error', onInputError);
        this.unsubscribers.push(onStreamError(this.options.input, onInputError));
        this.restoreConsoleOnShutdown();
        if (terminal) {
            this.rl.on('SIGINT', () => {
                if (this.options.format === 'text') {
                    this.write('\n');
                }
                this.finish('interrupted');
            });
        }

        const greeting = options.greeting === undefined ? this.options.greeting : options.greeting;
        if (greeting) {
            this.enqueue({
                activity: { type: ActivityTypes.ConversationUpdate, membersAdded: [{ id: this.user, name: this.user }] },
                source: 'internal'
            });
        }
        this.promptIfIdle();
    }

    /**
     * Process one line exactly as if it had been typed, after any lines already queued.
     * Commands, choice numbers and titles, defaults and backslash escapes all apply.
     * Resolves with the lines this input produced (bot replies and command output, with ANSI colors removed),
     * which are also written to the output. Messages the bot sends outside the turn (proactive messages) are not included.
     * In JSON format, each line is a JSON string.
     *
     * Do not await `submit()`, [run()](#run) or [idle()](#idle) inside a bot handler or a custom command: they wait for the queue,
     * which is waiting for that handler, so the turn or command fails with a `TurnTimeoutError` after `turnTimeout`.
     * To queue work that runs after the current turn, call them without `await`, and handle a rejection with `.catch()`.
     *
     * ```javascript
     * const lines = await adapter.submit('hello');
     * assert.deepStrictEqual(lines, ['bot> Hi Ann!']);
     * ```
     *
     * @param line The text of the line.
     * @returns The output lines. Rejects if the turn fails or the session is closed.
     */
    public submit(line: string): Promise<string[]> {
        if (this.closed) {
            return Promise.reject(new Error('The CLI session is closed'));
        }
        this.restoreConsoleOnShutdown();
        return new Promise<string[]>((resolve, reject) => {
            this.queue.push({ line: String(line === undefined || line === null ? '' : line), source: 'submit', resolve: resolve, reject: reject });
        });
    }

    /**
     * Run the session, or run one dialog from start to finish, and resolve with how it ended.
     *
     * With a `dialog`, any dialog pending in the conversation is canceled and the dialog begins fresh with `vars`.
     * Its questions are answered by the person at the keyboard, by the `answers` option, or, when `nonInteractive` is set, by their defaults.
     * The run resolves when the dialog ends (`completed`, `canceled` or `timeout`), and then, unless `closeOnComplete` is false, the session ends too.
     * A dialog that is removed without ending, for example by `bot.cancelAllDialogs()` in an interrupt, also counts as `canceled`.
     * The run also resolves if the session ends first (`eof`, `quit`, `interrupted` or `failed`).
     * `/as` and `/new` do not end the run: it waits until you switch back to its user and conversation.
     * The `answers` are reset at the start of each run with a dialog.
     *
     * Without a `dialog`, the promise resolves when the session ends. Starts the session if needed; the greeting is sent only without a dialog.
     * If your code awaits I/O before calling `run()`, create the adapter with `autoStart: false`, or the session may start (and greet) first.
     * Do not await `run()` inside a bot handler or a custom command (see [submit()](#submit)).
     *
     * ```javascript
     * // An installer that also runs unattended in CI:
     * // node install.js --answers answers.json --non-interactive
     * const result = await adapter.run({ dialog: 'setup', vars: { app: 'acme' } });
     * if (result.status === 'completed') {
     *     writeConfig(result.vars);
     * }
     * process.exitCode = result.exitCode;
     * ```
     *
     * @param options An optional [CliRunOptions](#CliRunOptions) object.
     * @returns A [CliRunResult](#CliRunResult). Rejects if a run is already in progress, the session is closed or the dialog is unknown.
     */
    public run(options: CliRunOptions = {}): Promise<CliRunResult> {
        if (this.activeRun) {
            return Promise.reject(new Error('A run is already in progress'));
        }
        if (this.closed) {
            return Promise.reject(new Error('The CLI session is closed'));
        }
        if (!this.controller) {
            return Promise.reject(this.missingControllerError());
        }
        const dialog = options.dialog;
        if (dialog && !this.controller.dialogSet.find(dialog + ':botkit-wrapper')) {
            return Promise.reject(new Error(`Unknown dialog "${ dialog }". Did you call controller.addDialog()?`));
        }

        return new Promise<CliRunResult>((resolve) => {
            const run: CliActiveRun = {
                dialog: dialog,
                closeOnComplete: options.closeOnComplete === undefined ? !!dialog : options.closeOnComplete,
                resolve: resolve
            };
            this.activeRun = run;

            if (dialog) {
                this.watchDialog(dialog);
                this.answers = this.copyAnswers();
                if (this.started && this.canPrompt() && !this.queue.busy && this.queue.size === 0) {
                    // the prompt is showing: the dialog's first question replaces it
                    readline.clearLine(this.options.output, 0);
                    readline.cursorTo(this.options.output, 0);
                }
                // queued before start(), so that start() does not draw a prompt in front of the first question
                this.enqueue({
                    activity: {
                        type: ActivityTypes.Event,
                        name: 'cli_run',
                        channelData: { botkitEventType: 'cli_run' },
                        value: { dialog: dialog, vars: options.vars || {} }
                    },
                    source: 'internal',
                    run: run
                });
            }
            if (!this.started) {
                this.start({ greeting: !dialog && this.options.greeting });
            }
        });
    }

    /**
     * Wait until every queued line and turn, including answers that turns queue, has been processed.
     * Lines written to the input stream are queued once the stream delivers them, which can take a tick.
     * Do not await `idle()` inside a bot handler or a custom command (see [submit()](#submit)).
     *
     * ```javascript
     * input.write('hello\n');
     * await adapter.idle();
     * ```
     *
     * @returns A promise that resolves when the input queue is empty and no turn is running.
     */
    public idle(): Promise<void> {
        return this.queue.idle();
    }

    /**
     * End the session from code, as `/quit` does: stop reading input, drop queued lines (their `submit()` promises reject),
     * resolve an active [run()](#run) with status `quit`, and, unless `shutdownOnClose` is false, call `controller.shutdown()`
     * so that plugins and timers stop and the process can exit. The console is restored once the session and the shutdown are over.
     * The session also ends, without calling `controller.shutdown()` again, when Botkit shuts down.
     *
     * ```javascript
     * controller.hears('bye', 'message', async (bot, message) => {
     *     await bot.reply(message, 'Goodbye!');
     *     bot.cli.close();
     * });
     * ```
     */
    public close(): void {
        this.finish('quit');
    }

    /**
     * Build a conversation reference for the terminal session, for use with `bot.changeContext()`.
     * [CliBotWorker.startConversationWithUser()](#startConversationWithUser) uses it.
     *
     * ```javascript
     * const bot = await controller.spawn();
     * await bot.changeContext(adapter.getReference());
     * await bot.say('Background job finished.');
     * ```
     *
     * @param user The user id to address. Defaults to the current user.
     * @returns A reference with `channelId: 'cli'`, the current conversation, the user and the bot.
     */
    public getReference(user?: string): Partial<ConversationReference> {
        const id = user || this.user;
        return {
            channelId: 'cli',
            conversation: { id: this.conversationId } as ConversationAccount,
            user: { id: id, name: id },
            bot: { id: 'bot', name: this.options.botName }
        };
    }

    /**
     * Standard BotBuilder adapter method to send messages from the bot. Messages are rendered and written to the output;
     * `typing` and `trace` activities are not shown, and `delay` activities pause when `honorDelays` is set.
     * [BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#sendactivities).
     * @param context A TurnContext representing the current incoming message and environment.
     * @param activities An array of outgoing activities to be written to the terminal.
     * @returns One `{ id: 'cli-out-<n>' }` for each activity.
     */
    public async sendActivities(context: TurnContext, activities: Partial<Activity>[]): Promise<ResourceResponse[]> {
        const responses: ResourceResponse[] = [];
        for (let a = 0; a < activities.length; a++) {
            const activity = activities[a];
            responses.push({ id: `cli-out-${ ++this.outgoingCount }` });
            debug('OUTGOING > ', activity);

            if (activity.type === 'delay') {
                const ms = Math.min(Number(activity.value) || 0, this.options.maxDelay);
                if (this.options.honorDelays && ms > 0) {
                    await sleep(ms);
                }
                continue;
            }
            if (activity.type !== ActivityTypes.Typing) {
                this.lastSent = activity;
            }
            this.display(context, activity);
        }
        return responses;
    }

    /**
     * Standard BotBuilder adapter method to update a previous message. The CLI prints the new text as `bot> (edited) <text>`.
     * @param context A TurnContext representing the current incoming message and environment.
     * @param activity The updated activity.
     */
    public async updateActivity(context: TurnContext, activity: Partial<Activity>): Promise<void> {
        if (this.options.format === 'json') {
            this.printForContext(context, [JSON.stringify({
                type: 'messageUpdate',
                id: activity.id,
                text: activity.text === undefined || activity.text === null ? undefined : this.decode(activity.text),
                conversation: activity.conversation ? activity.conversation.id : undefined
            })]);
        } else {
            this.printForContext(context, [this.paint(BOLD_CYAN, this.botPrefix()) + '(edited) ' + this.decode(activity.text || '')]);
        }
    }

    /**
     * Standard BotBuilder adapter method to delete a previous message. The CLI prints `(deleted message <id>)`.
     * @param context A TurnContext representing the current incoming message and environment.
     * @param reference A reference to the deleted activity.
     */
    public async deleteActivity(context: TurnContext, reference: Partial<ConversationReference>): Promise<void> {
        if (this.options.format === 'json') {
            this.printForContext(context, [JSON.stringify({
                type: 'messageDelete',
                id: reference.activityId,
                conversation: reference.conversation ? reference.conversation.id : undefined
            })]);
        } else {
            this.printForContext(context, [this.indent() + this.paint(DIM, `(deleted message ${ reference.activityId })`)]);
        }
    }

    /**
     * Standard BotBuilder adapter method for continuing an existing conversation based on a conversation reference.
     * The turn runs immediately and is not queued behind typed input, so a scheduler can fire jobs while a turn is running.
     * Its messages are printed as they are sent.
     * [BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#continueconversation)
     * @param reference A conversation reference to be applied to future messages.
     * @param logic A bot logic function that will perform continuing action in the form `async(context) => { ... }`
     */
    public async continueConversation(reference: Partial<ConversationReference>, logic: (context: TurnContext) => Promise<void>): Promise<void> {
        const request = TurnContext.applyConversationReference(
            { type: 'event', name: 'continueConversation' },
            reference,
            true
        );
        const context = new TurnContext(this, request);
        // A queued turn running at the same time may not have saved its state yet, so only a turn on its own can tell that the run's dialog is gone.
        // The logic need not save state, so read what was saved with a new context.
        const alone = !this.queue.busy;
        try {
            await this.runMiddleware(context, logic);
            if (alone && !this.queue.busy) {
                await this.checkRunDialog(new TurnContext(this, context.activity)).catch((err) => debug('Could not check the dialog of the run:', err));
            }
        } finally {
            this.settleCompletedRun();
        }
    }

    /**
     * The CLI adapter does not accept HTTP requests: this answers any webhook request with status 405 and a JSON error,
     * so a Botkit webserver never throws.
     * @param req A request object from Restify or Express
     * @param res A response object from Restify or Express
     * @param logic A bot logic function (not used)
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async processActivity(req: any, res: any, logic: any): Promise<void> {
        res.statusCode = 405;
        if (typeof res.setHeader === 'function') {
            res.setHeader('Content-Type', 'application/json');
        }
        res.end(JSON.stringify({ error: 'The CLI adapter does not accept HTTP requests' }));
    }

    // ---------------------------------------------------------------------------------------------
    // Queue and turns
    // ---------------------------------------------------------------------------------------------

    private enqueue(item: CliQueueItem): void {
        if (this.closed) {
            debug('Input ignored: the session is closed');
            return;
        }
        this.queue.push(item);
    }

    private async processItem(item: CliQueueItem): Promise<void> {
        if (item.source === 'answer') {
            // Automatic answers can follow each other without ever waiting for I/O: let timers, signals and input run in between.
            await new Promise((resolve) => setImmediate(resolve));
        }
        if (this.closed) {
            if (item.reject) {
                item.reject(new Error('The CLI session is closed'));
            }
            return;
        }
        if (!item.isDefault) {
            // a real answer (or any other input) makes progress, so defaults may be used again
            this.defaultsUsed.clear();
        }
        const sink: string[] = [];
        try {
            if (item.activity) {
                await this.turn(item.activity, sink, item.run);
            } else {
                await this.handleLine(item, sink);
            }
            if (item.resolve) {
                item.resolve(sink);
            }
        } catch (err) {
            this.onItemError(err, item);
            if (item.reject) {
                item.reject(err);
            }
        }
        this.settleCompletedRun();
    }

    private onItemError(err: any, item: CliQueueItem): void {
        const fatal = this.options.nonInteractive || !!(this.activeRun && this.activeRun.dialog);
        if (item.source !== 'submit' || fatal) {
            this.printError(err);
        }
        if (fatal) {
            this.finish('failed', { exitCode: 1, error: err instanceof Error ? err : new Error(errorMessage(err)) });
        }
    }

    /**
     * Run one activity through the adapter middleware and Botkit, then update the remembered menu and queue automatic answers.
     */
    private async turn(partial: Partial<Activity>, sink: string[], run?: CliActiveRun): Promise<void> {
        const controller = this.requireController();
        const activity = this.buildActivity(partial);
        const key = `${ activity.conversation.id }|${ activity.from.id }`;
        if (run && run === this.activeRun) {
            run.address = key;
        }

        const context = new TurnContext(this, activity);
        const collector: CliTurnCollector = { lines: sink, done: false };
        context.turnState.set(TURN_STATE_KEY, collector);
        const startSeq = this.promptSeq;
        try {
            await withTimeout(this.runMiddleware(context, controller.handleTurn.bind(controller)), this.options.turnTimeout, this.timers);
        } finally {
            collector.done = true;
        }
        if (collector.lastText) {
            this.lastAsked = { key: key, text: collector.lastText };
        }

        let question: BotkitPendingQuestion | null;
        let loaded = false;
        const getQuestion = async (): Promise<BotkitPendingQuestion | null> => {
            if (!loaded) {
                question = await this.getPendingQuestion(context);
                loaded = true;
            }
            return question;
        };

        // a menu sent proactively while this turn ran (by a timer or a scheduler) is on screen after anything the turn printed before it
        const current = this.prompts.get(key);
        const proactive = !!current && current.seq > startSeq;
        if (collector.prompt && !(proactive && current.seq > collector.prompt.seq)) {
            this.prompts.set(key, { ...collector.prompt, question: questionId(await getQuestion()) });
        } else if (current && !proactive) {
            const pending = await getQuestion();
            if (!pending || (current.question !== undefined && current.question !== questionId(pending))) {
                this.prompts.delete(key);
            }
        }

        await this.checkRunDialog(context);

        const unattended = this.options.nonInteractive || Object.keys(this.options.answers).length > 0;
        if (unattended && !this.closed && !(this.activeRun && this.activeRun.outcome)) {
            this.autoAnswer(key, await getQuestion(), collector.lastText);
        }
    }

    /**
     * Queue an answer for the pending question from `answers` or its default, or fail in non-interactive mode.
     */
    private autoAnswer(key: string, question: BotkitPendingQuestion | null, lastText: string): void {
        if (!question) {
            return;
        }
        const prompt = this.prompts.get(key);
        const hasDefault = !!prompt && prompt.default !== undefined;
        const text = this.options.format === 'text';
        const answer = this.takeAnswer(question.key);
        const asked = `${ key }#${ questionId(question) }`;
        const useDefault = (): void => {
            this.defaultsUsed.add(asked);
            this.queue.unshift({ line: prompt.default, source: 'answer', isDefault: true, echo: text ? `${ this.options.prompt }${ prompt.default } (default)` : undefined });
        };

        if (answer !== undefined && answer.trim() !== '') {
            this.queue.unshift({ line: answer, source: 'answer', echo: text ? `${ this.options.prompt }${ answer } (from answers)` : undefined });
            return;
        }
        if (answer !== undefined && hasDefault) {
            // an empty answer asks for the default
            useDefault();
            return;
        }
        if (!this.options.nonInteractive || this.queue.size > 0 || this.inputMayFollow()) {
            // Wait for a person, for input that is already queued, or for piped input that has not arrived yet.
            // The question is looked at again after the next turn, or when the input ends.
            return;
        }
        // Using the same default again, with only defaults in between, would repeat what the dialog has already rejected.
        const rejected = this.defaultsUsed.has(asked);
        if (hasDefault && !rejected) {
            useDefault();
            return;
        }
        const label = question.key || '(unnamed question)';
        const shown = (prompt && prompt.text) || lastText;
        const note = rejected && hasDefault ? ` (the default, ${ prompt.default }, was not accepted)` : '';
        this.printError(`Missing answer for "${ label }"${ note }` + (shown ? `: ${ shown }` : ''));
        this.finish('failed', { exitCode: 2, vars: question.vars });
    }

    /**
     * True while more lines may still arrive from input that is not a person at a terminal, such as a pipe or a file.
     */
    private inputMayFollow(): boolean {
        return !!this.rl && !this.inputEnded && !(this.options.input as any).isTTY;
    }

    private takeAnswer(key: string): string | undefined {
        if (key === undefined || key === null || !hasOwn(this.answers, key)) {
            return undefined;
        }
        const entry: any = this.answers[key];
        if (Array.isArray(entry)) {
            while (entry.length) {
                const value = entry.shift();
                if (value !== undefined && value !== null) {
                    return typeof value === 'object' ? JSON.stringify(value) : String(value);
                }
            }
            return undefined;
        }
        delete this.answers[key];
        if (entry === undefined || entry === null) {
            return undefined;
        }
        return typeof entry === 'object' ? JSON.stringify(entry) : String(entry);
    }

    private copyAnswers(): { [key: string]: string | string[] } {
        const copy = {};
        Object.keys(this.options.answers).forEach((key) => {
            const value = this.options.answers[key];
            copy[key] = Array.isArray(value) ? value.slice() : value;
        });
        return copy;
    }

    /**
     * Map a line to a command, a default, a choice or a plain message, then run it.
     */
    private async handleLine(item: CliQueueItem, sink: string[]): Promise<void> {
        const line = item.line;
        const typed = item.source !== 'answer';

        if (typed && line.startsWith('\\')) {
            this.echo(item, line);
            return this.turn({ type: ActivityTypes.Message, text: line.slice(1) }, sink);
        }

        if (typed) {
            const command = this.parseCommand(line);
            if (command) {
                this.echo(item, line);
                return this.runCommand(command.name, command.args, sink);
            }
        }

        const prompt = this.prompts.get(this.promptKey());
        const trimmed = line.trim();
        if (trimmed === '') {
            if (!prompt || prompt.default === undefined) {
                debug('Empty line ignored: no default answer');
                return;
            }
            if (item.echo !== undefined) {
                this.echo(item, line);
            } else if (this.options.format === 'text') {
                const shown = this.decode(prompt.default);
                if (this.options.terminal) {
                    this.print([this.indent() + this.paint(DIM, `(using default: ${ shown })`)]);
                } else {
                    this.print([`${ this.options.prompt }${ shown } (default)`]);
                }
            }
            const index = prompt.choices.findIndex((choice) => choice.value === prompt.default);
            return this.turn(index >= 0 ? this.choiceActivity(prompt.choices[index], index) : { type: ActivityTypes.Message, text: prompt.default }, sink);
        }

        this.echo(item, line);
        const index = this.matchChoice(trimmed, prompt, !typed);
        if (index >= 0) {
            return this.turn(this.choiceActivity(prompt.choices[index], index), sink);
        }
        return this.turn({ type: ActivityTypes.Message, text: line }, sink);
    }

    /**
     * Find the choice a line selects: by value (automatic answers only), by title, ignoring case, or by number.
     * The title comes before the number, so that typing a title shown in the menu, such as `2` in `[1] 2  [2] 4`, picks that choice.
     */
    private matchChoice(text: string, prompt: CliPrompt, byValue: boolean): number {
        if (!prompt || !prompt.choices.length) {
            return -1;
        }
        const choices = prompt.choices;
        if (byValue) {
            const index = choices.findIndex((choice) => choice.value === text);
            if (index >= 0) {
                return index;
            }
        }
        const lower = text.toLowerCase();
        const titled = choices.findIndex((choice) => choice.title.toLowerCase() === lower);
        if (titled >= 0) {
            return titled;
        }
        if (/^[0-9]+$/.test(text)) {
            const n = parseInt(text, 10);
            if (n >= 1 && n <= choices.length) {
                return n - 1;
            }
        }
        return -1;
    }

    private choiceActivity(choice: CliChoice, index: number): Partial<Activity> {
        return {
            type: ActivityTypes.Message,
            text: choice.value,
            value: choice.value,
            channelData: { cli_choice: { index: index, title: choice.title, value: choice.value } }
        };
    }

    private buildActivity(partial: Partial<Activity>): Activity {
        return {
            ...partial,
            id: `cli-in-${ ++this.incomingCount }`,
            timestamp: new Date(),
            channelId: 'cli',
            conversation: { id: this.conversationId } as ConversationAccount,
            from: { id: this.user, name: this.user },
            recipient: { id: 'bot', name: this.options.botName }
        } as Activity;
    }

    private probeContext(): TurnContext {
        return new TurnContext(this, {
            type: ActivityTypes.Message,
            channelId: 'cli',
            conversation: { id: this.conversationId } as ConversationAccount,
            from: { id: this.user, name: this.user },
            recipient: { id: 'bot', name: this.options.botName }
        });
    }

    private async getPendingQuestion(context: TurnContext): Promise<BotkitPendingQuestion | null> {
        const controller: any = this.requireController();
        if (typeof controller.getPendingQuestion !== 'function') {
            return null;
        }
        return controller.getPendingQuestion(context);
    }

    private requireController(): Botkit {
        if (!this.controller) {
            throw this.missingControllerError();
        }
        return this.controller;
    }

    private missingControllerError(): Error {
        return new Error('The CliAdapter works with Botkit only: pass it to new Botkit({ adapter }) first');
    }

    private promptKey(): string {
        return `${ this.conversationId }|${ this.user }`;
    }

    // ---------------------------------------------------------------------------------------------
    // Runs and session end
    // ---------------------------------------------------------------------------------------------

    private watchDialog(dialog: string): void {
        if (this.watchedDialogs.includes(dialog)) {
            return;
        }
        this.watchedDialogs.push(dialog);
        this.controller.afterDialog(dialog, async (bot: BotWorker, results: any) => {
            const run = this.activeRun;
            if (!run || run.dialog !== dialog || run.outcome || !run.address) {
                return;
            }
            const context: TurnContext = bot.getConfig('context');
            const activity = context && context.activity;
            if (!activity || `${ activity.conversation?.id }|${ activity.from?.id }` !== run.address) {
                return;
            }
            let status: CliRunStatus = 'completed';
            if (results && results._status === 'canceled') {
                status = 'canceled';
            } else if (results && results._status === 'timeout') {
                status = 'timeout';
            }
            run.outcome = { status: status, vars: results };
            // never return false here: it would stop other afterDialog handlers
        });
    }

    /**
     * After a turn for the run's user and conversation: if the run's dialog left the stack without ending
     * (`bot.cancelAllDialogs()`, or `replaceDialog()` with another dialog), afterDialog never fires, so record the run as canceled.
     */
    private async checkRunDialog(context: TurnContext): Promise<void> {
        const run = this.activeRun;
        const activity = context.activity;
        if (!run || !run.dialog || run.outcome || !run.address || `${ activity.conversation?.id }|${ activity.from?.id }` !== run.address) {
            return;
        }
        const dialogContext = await this.requireController().dialogSet.createContext(context);
        const wrapper = `${ run.dialog }:botkit-wrapper`;
        const active = dialogContext.stack.some((frame) => frame.id === run.dialog || frame.id === wrapper);
        if (!active && run === this.activeRun && !run.outcome) {
            debug(`Dialog "${ run.dialog }" left the stack without ending: the run is canceled`);
            run.outcome = { status: 'canceled', vars: undefined };
        }
    }

    private settleCompletedRun(): void {
        const run = this.activeRun;
        if (!run || !run.outcome) {
            return;
        }
        if (run.closeOnComplete) {
            this.finish(run.outcome.status, { vars: run.outcome.vars });
        } else {
            this.settleRun(run.outcome.status, { vars: run.outcome.vars });
        }
    }

    private settleRun(status: CliRunStatus, extra: { exitCode?: number; error?: Error; vars?: any } = {}): void {
        const run = this.activeRun;
        if (!run) {
            return;
        }
        this.activeRun = null;

        let vars = extra.vars;
        if (run.outcome && (status === 'eof' || status === 'quit')) {
            status = run.outcome.status;
            vars = run.outcome.vars;
        }

        let exitCode = extra.exitCode;
        if (exitCode === undefined) {
            switch (status) {
            case 'completed':
                exitCode = 0;
                break;
            case 'interrupted':
                exitCode = 130;
                break;
            case 'eof':
            case 'quit':
                exitCode = run.dialog ? 1 : 0;
                break;
            default:
                exitCode = 1;
            }
        }

        const result: CliRunResult = { status: status, exitCode: exitCode };
        if (vars !== undefined) {
            result.vars = vars;
        }
        if (extra.error) {
            result.error = extra.error;
        }
        run.resolve(result);
    }

    private async onInputClosed(): Promise<void> {
        this.inputEnded = true;
        if (this.closed) {
            return;
        }
        if (this.options.terminal && this.options.format === 'text') {
            // Ctrl+D leaves the cursor after the prompt
            this.write('\n');
        }
        await this.queue.idle();
        if (this.options.nonInteractive && this.controller && !this.closed) {
            // every piped line has been used: a question still waiting gets its default, or the run fails
            const key = this.promptKey();
            const question = await this.getPendingQuestion(this.probeContext());
            if (!this.closed && !(this.activeRun && this.activeRun.outcome)) {
                this.autoAnswer(key, question, this.lastAsked && this.lastAsked.key === key ? this.lastAsked.text : undefined);
                await this.queue.idle();
            }
        }
        this.finish('eof');
    }

    /**
     * Tab completion for slash-commands in terminal mode.
     */
    private complete(line: string): [string[], string] {
        if (!line.startsWith('/') || /\s/.test(line)) {
            return [[], line];
        }
        const names = BUILTIN_COMMANDS.concat(Object.keys(this.options.commands)).map((name) => `/${ name }`);
        return [names.filter((name) => name.startsWith(line)), line];
    }

    /**
     * End the session: resolve the active run, close, and shut Botkit down once if shutdownOnClose is set.
     * The console stays redirected until the shutdown has finished, so shutdown handlers cannot write into the output either.
     */
    private finish(status: CliRunStatus, extra: { exitCode?: number; error?: Error; vars?: any } = {}): void {
        if (this.closed) {
            return;
        }
        this.settleRun(status, extra);
        const shutdown = this.options.shutdownOnClose && !!this.controller && !this.shutdownRequested;
        this.closeSession(shutdown);
        if (shutdown) {
            this.shutdownRequested = true;
            this.controller.shutdown()
                .catch((err) => this.printError(err))
                .then(() => this.releaseConsole());
        }
    }

    /**
     * Stop reading input, drop queued lines, let pending timers go, and resolve an active run with 'quit'.
     * Never calls controller.shutdown(): the shutdown handler calls this.
     * @param keepConsole Leave the console redirected, because a shutdown is under way that restores it when it is done.
     */
    private closeSession(keepConsole: boolean): void {
        if (this.closed) {
            return;
        }
        this.closed = true;

        const dropped = this.queue.clear();
        dropped.forEach((item) => {
            if (item.reject) {
                item.reject(new Error('The CLI session is closed'));
            }
        });
        if (this.rl) {
            this.rl.close();
        }
        // a turn that never settles must not keep the process alive once the session is over
        this.timers.forEach((timer) => {
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        });
        this.unsubscribers.forEach((unsubscribe) => unsubscribe());
        this.unsubscribers = [];
        if (!keepConsole) {
            this.releaseConsole();
        }
        this.settleRun('quit');
    }

    // ---------------------------------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------------------------------

    private parseCommand(line: string): { name: string; args: string } | null {
        const match = COMMAND_LINE.exec(line.trim());
        if (!match) {
            return null;
        }
        const name = match[1];
        if (!hasOwn(this.options.commands, name) && !BUILTIN_COMMANDS.includes(name.toLowerCase())) {
            return null;
        }
        return { name: name, args: (match[2] || '').trim() };
    }

    private async runCommand(name: string, args: string, sink: string[]): Promise<void> {
        if (hasOwn(this.options.commands, name)) {
            const command = this.options.commands[name];
            const run = typeof command === 'function' ? command : command.run;
            // Commands run in the queue like turns, so they get the same time limit:
            // a command that awaits submit(), run() or idle() would otherwise block the session for good.
            const result = await withTimeout(Promise.resolve().then(() => run(args, this)), this.options.turnTimeout, this.timers, `Command /${ name }`);
            let lines: string[] = [];
            if (typeof result === 'string') {
                lines = result.split(/\r?\n/);
            } else if (Array.isArray(result)) {
                lines = result.map((line) => String(line));
            }
            this.printCommand(name, lines, sink);
            return;
        }

        const builtin = name.toLowerCase();
        switch (builtin) {
        case 'help':
            this.printCommand(builtin, this.helpLines(), sink);
            return;
        case 'quit':
        case 'exit':
            this.finish('quit');
            return;
        case 'event':
            return this.eventCommand(args, sink);
        case 'as':
            if (!args) {
                this.printError('usage: /as <user>');
                return;
            }
            this.user = args;
            this.printCommand(builtin, [`(you are now ${ args })`], sink, true);
            return;
        case 'new':
            this.conversationId = args || newConversationId();
            this.printCommand(builtin, [`(new conversation ${ this.conversationId })`], sink, true);
            return;
        case 'state':
            return this.stateCommand(sink);
        case 'raw':
            this.printCommand(builtin, [this.lastSent ? safeJson(this.lastSent) : '(nothing sent yet)'], sink);
            return;
        case 'json':
            return this.jsonCommand(args, sink);
        }
    }

    private helpLines(): string[] {
        const entries: [string, string][] = [
            ['/help', 'Show this list'],
            ['/quit, /exit', 'End the session'],
            ['/event <name> [json]', 'Send an event to the bot, with an optional JSON payload'],
            ['/as <user>', 'Continue as another user'],
            ['/new [id]', 'Start a new conversation'],
            ['/state', 'Show the question the bot is waiting on'],
            ['/raw', 'Show the last activity the bot sent, as JSON'],
            ['/json <activity>', 'Send an activity written as JSON']
        ];
        Object.keys(this.options.commands).forEach((name) => {
            const command = this.options.commands[name];
            const description = typeof command === 'function' ? '' : (command.description || '');
            entries.push([`/${ name }`, description]);
        });
        const width = Math.max(...entries.map((entry) => entry[0].length)) + 2;
        return ['Commands:']
            .concat(entries.map((entry) => `  ${ entry[0].padEnd(width) }${ entry[1] }`.replace(/\s+$/, '')))
            .concat([
                'Type a number or a choice title to pick from a menu, or press Enter for the default.',
                'Start a line with \\ to send it exactly as typed.'
            ]);
    }

    private async eventCommand(args: string, sink: string[]): Promise<void> {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
        if (!match) {
            this.printError('usage: /event <name> [json]');
            return;
        }
        const name = match[1];
        const json = match[2];
        let value: any;
        if (json !== undefined && json.trim() !== '') {
            try {
                value = JSON.parse(json);
            } catch (err) {
                this.printError(`invalid JSON: ${ errorMessage(err) }`);
                return;
            }
        }

        if (await this.getPendingQuestion(this.probeContext())) {
            this.printCommand('event', [`(note: a question is pending; this event will be consumed as its answer unless you handle "${ name }" with controller.interrupts())`], sink, true);
        }

        const activity: Partial<Activity> = {
            type: ActivityTypes.Event,
            name: name,
            channelData: isPlainObject(value) ? { ...value, botkitEventType: name } : { botkitEventType: name }
        };
        if (value !== undefined) {
            activity.value = value;
        }
        return this.turn(activity, sink);
    }

    private async stateCommand(sink: string[]): Promise<void> {
        const question = await this.getPendingQuestion(this.probeContext());
        if (!question) {
            this.printCommand('state', ['no dialog is waiting for input'], sink);
            return;
        }
        const vars = { ...question.vars };
        delete vars.user;
        delete vars.channel;
        const waitingFor = question.key ? `for "${ question.key }"` : 'for an answer (no key)';
        this.printCommand('state', [
            `waiting in dialog "${ question.dialog }" (thread ${ question.thread }) ${ waitingFor }`,
            `vars: ${ safeJson(vars) }`
        ], sink);
    }

    private async jsonCommand(args: string, sink: string[]): Promise<void> {
        if (!args) {
            this.printError('usage: /json <activity-json>');
            return;
        }
        let parsed: any;
        try {
            parsed = JSON.parse(args);
        } catch (err) {
            this.printError(`invalid JSON: ${ errorMessage(err) }`);
            return;
        }
        if (!isPlainObject(parsed)) {
            this.printError('/json expects a JSON object, such as {"text":"hello"}');
            return;
        }
        return this.turn({ type: ActivityTypes.Message, ...parsed }, sink);
    }

    // ---------------------------------------------------------------------------------------------
    // Output
    // ---------------------------------------------------------------------------------------------

    private renderOptions(): RenderOptions {
        return {
            botName: this.options.botName,
            currentUser: this.user,
            color: this.options.color,
            verbose: this.options.verbose,
            unescapeHtml: this.options.unescapeHtml
        };
    }

    /**
     * Render an outgoing activity, remember its menu, and write it to the turn collector or straight to the output.
     */
    private display(context: TurnContext, activity: Partial<Activity>): void {
        const options = this.renderOptions();
        const rendered = renderActivity(activity, options);
        let lines = rendered.lines;
        if (this.options.format === 'json') {
            const json = renderJson(activity, options);
            lines = json === null ? [] : [json];
        }

        const isMessage = (activity.type || ActivityTypes.Message) === ActivityTypes.Message;
        const text = isMessage && activity.text ? this.decode(activity.text) : undefined;
        const prompt: CliPrompt = (isMessage && (rendered.choices.length || rendered.defaultValue !== undefined))
            ? { choices: rendered.choices, default: rendered.defaultValue, text: text, seq: ++this.promptSeq }
            : undefined;

        const collector: CliTurnCollector = context.turnState.get(TURN_STATE_KEY);
        if (collector && !collector.done) {
            if (prompt) {
                collector.prompt = prompt;
            }
            if (text) {
                collector.lastText = text;
            }
            this.print(lines, collector.lines);
        } else {
            if (prompt && activity.conversation && activity.recipient) {
                this.prompts.set(`${ activity.conversation.id }|${ activity.recipient.id }`, prompt);
            }
            this.printProactive(lines);
        }
    }

    /**
     * Write lines produced by update/delete to the current turn, or straight to the output.
     */
    private printForContext(context: TurnContext, lines: string[]): void {
        const collector: CliTurnCollector = context.turnState.get(TURN_STATE_KEY);
        if (collector && !collector.done) {
            this.print(lines, collector.lines);
        } else {
            this.printProactive(lines);
        }
    }

    private printProactive(lines: string[]): void {
        if (!lines.length) {
            return;
        }
        const redraw = this.canPrompt();
        if (redraw) {
            readline.clearLine(this.options.output, 0);
            readline.cursorTo(this.options.output, 0);
        }
        this.print(lines);
        if (redraw && !this.queue.busy) {
            this.rl.prompt(true);
        }
    }

    private printCommand(name: string, lines: string[], sink: string[], note = false): void {
        if (!lines.length) {
            return;
        }
        if (this.options.format === 'json') {
            this.print([JSON.stringify({ type: 'cli', command: name, lines: lines })], sink);
        } else {
            this.print(lines.map((line) => this.indent() + (note ? this.paint(DIM, line) : line)), sink);
        }
    }

    private echo(item: CliQueueItem, line: string): void {
        if (this.options.format !== 'text') {
            return;
        }
        if (item.echo !== undefined) {
            this.print([item.echo]);
        } else if (!this.options.terminal) {
            this.print([`${ this.options.prompt }${ line }`]);
        }
    }

    private print(lines: string[], sink?: string[]): void {
        lines.forEach((line) => {
            this.write(line + '\n');
            if (sink) {
                sink.push(stripAnsi(line));
            }
        });
    }

    private printError(err: any): void {
        let text = 'error: ' + errorMessage(err);
        if (this.options.verbose && err && err.stack) {
            text = text + '\n' + err.stack;
        }
        if (this.errorOutputBroken) {
            debug(text);
            return;
        }
        try {
            this.options.errorOutput.write((this.errorColor ? RED + text + RESET : text) + '\n');
        } catch (writeError) {
            debug('Could not write to errorOutput', writeError);
        }
    }

    private write(text: string): void {
        if (this.outputBroken) {
            return;
        }
        this.options.output.write(text);
    }

    private promptIfIdle(): void {
        if (this.canPrompt() && !this.queue.busy && this.queue.size === 0) {
            this.rl.prompt();
        }
    }

    /**
     * True while a person can type into the prompt: terminal text mode, until the session closes or the input ends (Ctrl+D).
     */
    private canPrompt(): boolean {
        return !!this.rl && !this.closed && !this.inputEnded && this.options.terminal && this.options.format === 'text';
    }

    private botPrefix(): string {
        return `${ this.options.botName }> `;
    }

    private indent(): string {
        return ' '.repeat(this.botPrefix().length);
    }

    private paint(code: string, text: string): string {
        return this.options.color ? code + text + RESET : text;
    }

    private decode(text: any): string {
        const value = String(text);
        return this.options.unescapeHtml ? unescapeHtml(value) : value;
    }

    private redirectConsole(): void {
        const target = this.options.errorOutput;
        const original = { log: console.log, info: console.info, debug: console.debug, dir: console.dir };
        const send = (text: string): void => {
            if (!this.errorOutputBroken) {
                target.write(text + '\n');
            }
        };
        const write = (...args: any[]): void => {
            send(args.length ? util.format(args[0], ...args.slice(1)) : '');
        };
        const dir = (obj: any, options?: util.InspectOptions): void => {
            send(util.inspect(obj, options));
        };
        console.log = write;
        console.info = write;
        console.debug = write;
        console.dir = dir;
        this.restoreConsole = (): void => {
            // only restore what is still ours, in case something else replaced it since
            if (console.log === write) {
                console.log = original.log;
            }
            if (console.info === write) {
                console.info = original.info;
            }
            if (console.debug === write) {
                console.debug = original.debug;
            }
            if (console.dir === dir) {
                console.dir = original.dir;
            }
        };
    }

    private releaseConsole(): void {
        if (this.restoreConsole) {
            this.restoreConsole();
            this.restoreConsole = null;
        }
    }

    /**
     * When the console is redirected, add a shutdown handler that restores it. Added when the session starts,
     * after the app has registered its own shutdown handlers, so that it runs after them and they cannot write into the output.
     */
    private restoreConsoleOnShutdown(): void {
        if (this.restoreConsole && this.controller && !this.restoreOnShutdown && !this.closed) {
            this.restoreOnShutdown = true;
            this.controller.on('shutdown', async () => {
                this.releaseConsole();
            });
        }
    }
}
