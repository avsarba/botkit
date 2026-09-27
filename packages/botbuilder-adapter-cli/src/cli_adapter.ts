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
     * Never wait for a person: when a question has no answer in `answers` (and no more input is queued), use its `channelData.default`
     * or end the session with status `failed` and exit code 2. Turn errors also end the session. Defaults to false.
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
     * The longest a turn may take, in milliseconds, before it fails with a `TurnTimeoutError`. Defaults to 30000; 0 disables the limit.
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
     * Call `controller.shutdown()` when the session ends (end of input, `/quit`, Ctrl+C, a finished run or a failure), so timers and plugins stop
     * and the process can exit. Defaults to true.
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
     * Send `console.log`, `console.info`, `console.debug` and `console.dir` to `errorOutput` until the session closes,
     * so they cannot corrupt the output. Defaults to true when `format` is `'json'` and the output is `process.stdout`.
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
     * How the run ended: `completed`, `canceled` or `timeout` (the dialog ended with that status), `eof` (the input ended),
     * `quit` (`/quit`, `/exit` or `close()`), `interrupted` (Ctrl+C) or `failed` (an error, or a missing answer in non-interactive mode).
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
    private outputBroken = false;
    private shutdownRequested = false;
    private activeRun: CliActiveRun = null;
    private watchedDialogs: string[] = [];
    private answers: { [key: string]: string | string[] } = {};
    private prompts = new Map<string, CliPrompt>();
    private lastSent: Partial<Activity>;
    private incomingCount = 0;
    private outgoingCount = 0;
    private restoreConsole: () => void;

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

        this.options = {
            input: input,
            output: output,
            errorOutput: options.errorOutput || process.stderr,
            user: options.user || process.env.USER || process.env.USERNAME || 'user',
            conversation: options.conversation || newConversationId(),
            prompt: pick(options.prompt, 'you> '),
            botName: pick(options.botName, 'bot'),
            format: format,
            color: pick(options.color, !!(output as any).isTTY && !process.env.NO_COLOR),
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

        this.user = this.options.user;
        this.conversationId = this.options.conversation;
        this.answers = this.copyAnswers();
        this.queue = new TurnQueue<CliQueueItem>((item) => this.processItem(item), () => this.promptIfIdle());

        output.on('error', (err: any) => {
            if (err && err.code === 'EPIPE') {
                debug('Output closed (EPIPE), ending the session');
                this.outputBroken = true;
                this.finish('eof');
            } else {
                this.printError(`output stream: ${ errorMessage(err) }`);
            }
        });

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
            this.close();
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
     * Do not await `submit()` inside a bot handler or a custom command: it waits for the queue, which is waiting for that handler.
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
     * It also resolves if the session ends first (`eof`, `quit`, `interrupted` or `failed`).
     * The `answers` are reset at the start of each run with a dialog.
     *
     * Without a `dialog`, the promise resolves when the session ends. Starts the session if needed; the greeting is sent only without a dialog.
     * If your code awaits I/O before calling `run()`, create the adapter with `autoStart: false`, or the session may start (and greet) first.
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
            }
            if (!this.started) {
                this.start({ greeting: !dialog && this.options.greeting });
            }
            if (dialog) {
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
        });
    }

    /**
     * Wait until every queued line and turn, including answers that turns queue, has been processed.
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
     * End the session: stop reading input, drop queued lines (their `submit()` promises reject), restore the console,
     * and resolve an active [run()](#run) with status `quit`. It does not call `controller.shutdown()`; Botkit calls this method on shutdown.
     *
     * ```javascript
     * controller.hears('bye', 'message', async (bot, message) => {
     *     await bot.reply(message, 'Goodbye!');
     *     bot.cli.close();
     * });
     * ```
     */
    public close(): void {
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
        if (this.restoreConsole) {
            this.restoreConsole();
            this.restoreConsole = null;
        }
        this.settleRun('quit');
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
        try {
            await this.runMiddleware(context, logic);
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
        if (this.closed) {
            if (item.reject) {
                item.reject(new Error('The CLI session is closed'));
            }
            return;
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
        try {
            await withTimeout(this.runMiddleware(context, controller.handleTurn.bind(controller)), this.options.turnTimeout);
        } finally {
            collector.done = true;
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

        if (collector.prompt) {
            this.prompts.set(key, { ...collector.prompt, question: questionId(await getQuestion()) });
        } else if (this.prompts.has(key)) {
            const current = this.prompts.get(key);
            const pending = await getQuestion();
            if (!pending || (current.question !== undefined && current.question !== questionId(pending))) {
                this.prompts.delete(key);
            }
        }

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
        const useDefault = (): void => {
            this.queue.unshift({ line: prompt.default, source: 'answer', echo: text ? `${ this.options.prompt }${ prompt.default } (default)` : undefined });
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
        if (!this.options.nonInteractive || this.queue.size > 0) {
            // wait for a person, or for input that is already queued
            return;
        }
        if (hasDefault) {
            useDefault();
            return;
        }
        const label = question.key || '(unnamed question)';
        const asked = (prompt && prompt.text) || lastText;
        this.printError(`Missing answer for "${ label }"` + (asked ? `: ${ asked }` : ''));
        this.finish('failed', { exitCode: 2, vars: question.vars });
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
     * Find the choice a line selects: by value (automatic answers only), by number, or by title, ignoring case.
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
        if (/^[0-9]+$/.test(text)) {
            const n = parseInt(text, 10);
            if (n >= 1 && n <= choices.length) {
                return n - 1;
            }
        }
        const lower = text.toLowerCase();
        return choices.findIndex((choice) => choice.title.toLowerCase() === lower);
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
        if (this.closed) {
            return;
        }
        if (this.options.terminal && this.options.format === 'text') {
            // Ctrl+D leaves the cursor after the prompt
            this.write('\n');
        }
        await this.queue.idle();
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
     */
    private finish(status: CliRunStatus, extra: { exitCode?: number; error?: Error; vars?: any } = {}): void {
        if (this.closed) {
            return;
        }
        this.settleRun(status, extra);
        this.close();
        if (this.options.shutdownOnClose && this.controller && !this.shutdownRequested) {
            this.shutdownRequested = true;
            this.controller.shutdown().catch((err) => this.printError(err));
        }
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
            const result = await run(args, this);
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
            ? { choices: rendered.choices, default: rendered.defaultValue, text: text }
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
        const redraw = this.rl && !this.closed && this.options.terminal && this.options.format === 'text';
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
        try {
            this.options.errorOutput.write(this.paint(RED, text) + '\n');
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
        if (this.rl && !this.closed && this.options.terminal && this.options.format === 'text' && !this.queue.busy && this.queue.size === 0) {
            this.rl.prompt();
        }
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
        const write = (...args: any[]): void => {
            target.write((args.length ? util.format(args[0], ...args.slice(1)) : '') + '\n');
        };
        const dir = (obj: any, options?: util.InspectOptions): void => {
            target.write(util.inspect(obj, options) + '\n');
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
}
