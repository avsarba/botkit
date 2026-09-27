/**
 * @module botbuilder-adapter-mcp
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Activity, ActivityTypes, BotAdapter, ChannelAccount, ConversationAccount, ConversationReference, ResourceResponse, TurnContext } from 'botbuilder';
import { Botkit, BotkitPendingQuestion } from 'botkit';
import { BotkitConversationState } from 'botkit/lib/conversationState';
import * as Debug from 'debug';
import * as util from 'util';
import { McpBotWorker } from './botworker';
import { JsonRpcConnection } from './jsonrpc';
import {
    JSONRPC_ERRORS,
    LATEST_PROTOCOL_VERSION,
    MCP_LOG_LEVELS,
    MCP_REQUEST_STATE,
    McpCallMeta,
    McpCallToolResult,
    McpChoice,
    McpLogLevel,
    McpReply,
    McpRequestState,
    McpToolDefinition,
    SUPPORTED_PROTOCOL_VERSIONS,
    rpcError
} from './protocol';
import { normalizeReply, renderRepliesText } from './render';
import { validateArguments } from './schema';
import { isPlainObject } from './util';
const debug = Debug('botkit:mcp');

const PACKAGE_VERSION: string = require('../package.json').version; // eslint-disable-line @typescript-eslint/no-var-requires

/**
 * The channelId of every activity this adapter creates.
 */
const CHANNEL_ID = 'mcp';

/**
 * Chat sessions use the conversation id `session:<session>`.
 */
const SESSION_PREFIX = 'session:';

/**
 * Valid tool names, as recommended by the MCP specification.
 */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Valid chat session names.
 */
const SESSION_NAME = /^[A-Za-z0-9_.:@-]{1,128}$/;

/**
 * The first protocol version with tool titles, output schemas and structured content.
 */
const STRUCTURED_OUTPUT_VERSION = '2025-06-18';

/**
 * The default client id, used until the client sends a name in `initialize`.
 */
const DEFAULT_CLIENT_ID = 'mcp-client';

/**
 * The name of the Error a chat call fails with while an earlier turn of its session that timed out is still running.
 */
const SESSION_BUSY_ERROR = 'SessionBusyError';

/**
 * What a chat session last offered the agent: the question that was waiting (`dialog|thread|index`, or null when none was)
 * and the choices that go with it. A session with neither has no entry.
 */
interface RememberedChoices {
    choices: McpChoice[];
    question: string | null;
}

/**
 * The adapter options after defaults are applied.
 */
interface ResolvedOptions {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    serverInfo: { name: string; version: string; title?: string };
    instructions?: string;
    chatTool: { name: string; title?: string; description?: string } | null;
    turnTimeout: number;
    redirectConsole: boolean;
    autoStart: boolean;
    shutdownOnClose: boolean;
    maxOutbox: number;
    unescapeHtml: boolean;
}

// -------------------------------------------------------------------------------------------------
// Console redirection. Shared by every adapter in the process, so it is reference-counted.
// -------------------------------------------------------------------------------------------------

type ConsoleMethod = 'log' | 'info' | 'debug' | 'dir';
const REDIRECTED_METHODS: ConsoleMethod[] = ['log', 'info', 'debug', 'dir'];
let consoleRedirects = 0;
let originalConsole: { [method: string]: any } = null;
let replacementConsole: { [method: string]: any } = null;

/**
 * Send console.log, info, debug and dir to stderr, so that only protocol messages reach stdout.
 */
function redirectConsole(): void {
    consoleRedirects++;
    if (consoleRedirects > 1) {
        return;
    }
    const write = (...args: any[]): void => {
        process.stderr.write((args.length ? util.format(args[0], ...args.slice(1)) : '') + '\n');
    };
    const dir = (obj: any, options?: util.InspectOptions): void => {
        process.stderr.write(util.inspect(obj, options) + '\n');
    };
    originalConsole = {};
    replacementConsole = { log: write, info: write, debug: write, dir: dir };
    REDIRECTED_METHODS.forEach((method) => {
        originalConsole[method] = console[method];
        console[method] = replacementConsole[method];
    });
}

/**
 * Undo one redirectConsole(). The last one restores the original methods, unless something else replaced them since.
 */
function restoreConsole(): void {
    if (consoleRedirects === 0) {
        return;
    }
    consoleRedirects--;
    if (consoleRedirects > 0) {
        return;
    }
    REDIRECTED_METHODS.forEach((method) => {
        if (console[method] === replacementConsole[method]) {
            console[method] = originalConsole[method];
        }
    });
    originalConsole = null;
    replacementConsole = null;
}

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

/**
 * Race a promise against a timer. On timeout, reject with an Error named `TurnTimeoutError`.
 * The timer never keeps the process alive and is cleared as soon as the promise settles. 0 disables the limit.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!(ms > 0) || ms === Infinity) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error(`Turn timed out after ${ ms }ms`);
            err.name = 'TurnTimeoutError';
            reject(err);
        }, ms);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Turn any thrown value into an Error.
 */
function toError(err: any): Error {
    return err instanceof Error ? err : new Error(String(err));
}

/**
 * A text content item.
 */
function text(value: string): { type: 'text'; text: string } {
    return { type: 'text', text: value };
}

/**
 * A JSON-RPC error response.
 */
function errorResponse(id: any, code: number, message: string, data?: any): any {
    const error: { [key: string]: any } = { code: code, message: message };
    if (data !== undefined) {
        error.data = data;
    }
    return { jsonrpc: '2.0', id: id, error: error };
}

/**
 * True for an id an MCP request may carry: a string or a number. Unlike plain JSON-RPC, MCP does not allow null.
 */
function isValidId(id: any): boolean {
    return typeof id === 'string' || (typeof id === 'number' && isFinite(id));
}

/**
 * Identify a pending question within its session, or null when no question is waiting.
 */
function questionId(pending: BotkitPendingQuestion | null): string | null {
    return pending ? `${ pending.dialog }|${ pending.thread }|${ pending.index }` : null;
}

/**
 * Connect [Botkit](https://www.npmjs.com/package/botkit) to AI agents through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).
 * The bot becomes an MCP server that talks JSON-RPC over stdin and stdout, so agents such as Claude Code can start it and use it as a set of tools:
 *
 * * the **chat** tool sends a message through the full Botkit pipeline (middleware, `hears()`, `interrupts()`, `on()` and dialogs)
 *   and returns the bot's replies, the choices it offers, and whether a dialog is waiting for an answer.
 *   BotkitConversation dialogs become validated, step-by-step workflows the agent has to walk through.
 * * **declared tools**, created with [tool()](#tool), are handled by `controller.on('tool:<name>')` handlers.
 *   The arguments arrive in `message.value`, and the handler returns a structured result with `bot.toolResult()`.
 *
 * Proactive messages, such as scheduled reminders, wait in a per-session outbox until the agent's next chat call,
 * and are also sent as log notifications. This adapter works with Botkit only.
 */
export class McpAdapter extends BotAdapter {
    /**
     * Name used to register this adapter with Botkit.
     * @ignore
     */
    public name = 'MCP Adapter';

    /**
     * The class of the `bot` passed to handlers.
     * @ignore
     */
    public botkit_worker = McpBotWorker;

    private options: ResolvedOptions;
    private controller: Botkit = null;
    private connection: JsonRpcConnection = null;
    private closed = false;
    private consoleRedirected = false;
    private negotiatedVersion: string = null;
    private client: { name: string; version?: string; [key: string]: any } = null;
    private currentClientId = DEFAULT_CLIENT_ID;
    private clientInitialized = false;
    private minLogLevel: McpLogLevel = 'info';
    private tools = new Map<string, McpToolDefinition>();
    private queues = new Map<string, Promise<void>>();
    private runningTurns = new Map<string, Promise<void>>();
    private busyToolSlots = new Set<number>();
    private lastChoices = new Map<string, RememberedChoices>();
    private outboxes = new Map<string, McpReply[]>();
    private inflight = new Set<string | number>();
    private cancelled = new Set<string | number>();
    private inboundCount = 0;
    private outboundCount = 0;
    private toolState: BotkitConversationState = null;

    /**
     * Create an adapter that serves a Botkit bot over MCP. By default it reads requests from stdin and writes responses to stdout,
     * starts listening as soon as Botkit is ready, and shuts Botkit down when stdin closes.
     *
     * ```javascript
     * const { Botkit } = require('botkit');
     * const { McpAdapter } = require('botbuilder-adapter-mcp');
     *
     * const adapter = new McpAdapter({
     *     serverInfo: { name: 'pizza-bot', version: '1.0.0' }
     * });
     *
     * const controller = new Botkit({
     *     adapter: adapter,
     *     disable_webserver: true,
     *     disable_console: true
     * });
     *
     * controller.hears('hello', 'message', async (bot, message) => {
     *     await bot.reply(message, 'Hi! Want to order a pizza?');
     * });
     * ```
     *
     * Because stdout carries the protocol, the constructor sends `console.log`, `console.info`, `console.debug` and `console.dir`
     * to stderr until the adapter is closed (see the `redirectConsole` option).
     *
     * @param options An optional [McpAdapterOptions](#McpAdapterOptions) object.
     */
    public constructor(options: McpAdapterOptions = {}) {
        super();

        const pick = <T>(value: T, fallback: T): T => (value === undefined || value === null) ? fallback : value;
        const output = options.output || process.stdout;

        const serverInfo = { ...(options.serverInfo || {}) } as ResolvedOptions['serverInfo'];
        if (!serverInfo.name) {
            serverInfo.name = 'botkit-mcp';
        }
        if (!serverInfo.version) {
            serverInfo.version = PACKAGE_VERSION;
        }

        let chatTool: ResolvedOptions['chatTool'] = null;
        if (options.chatTool !== false) {
            const config = isPlainObject(options.chatTool) ? options.chatTool as { name?: string; title?: string; description?: string } : {};
            const name = config.name === undefined ? 'chat' : config.name;
            if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
                throw new Error(`Invalid chat tool name ${ JSON.stringify(name) }: use 1 to 128 letters, digits, "_", "-" or "."`);
            }
            chatTool = { name: name, title: config.title, description: config.description };
        }

        const turnTimeout = pick(options.turnTimeout, 15000);
        if (typeof turnTimeout !== 'number' || isNaN(turnTimeout) || turnTimeout < 0) {
            throw new Error('McpAdapter turnTimeout must be a number of milliseconds, or 0 for no limit');
        }
        const maxOutbox = pick(options.maxOutbox, 50);
        if (typeof maxOutbox !== 'number' || !Number.isInteger(maxOutbox) || maxOutbox < 0) {
            throw new Error('McpAdapter maxOutbox must be a whole number, 0 or more');
        }

        this.options = {
            input: options.input || process.stdin,
            output: output,
            serverInfo: serverInfo,
            instructions: options.instructions,
            chatTool: chatTool,
            turnTimeout: turnTimeout,
            redirectConsole: pick(options.redirectConsole, output === process.stdout),
            autoStart: pick(options.autoStart, true),
            shutdownOnClose: pick(options.shutdownOnClose, true),
            maxOutbox: maxOutbox,
            unescapeHtml: pick(options.unescapeHtml, true)
        };

        // Redirect now: the adapter is created before Botkit, which logs 'Enabling plugin' with console.log.
        if (this.options.redirectConsole) {
            redirectConsole();
            this.consoleRedirected = true;
        }
    }

    /**
     * The protocol version agreed with the client during `initialize`, or null before that.
     */
    public get protocolVersion(): string | null {
        return this.negotiatedVersion;
    }

    /**
     * The `clientInfo` the client sent with `initialize`, such as `{ name: 'claude-code', version: '2.0.0' }`, or null before that.
     */
    public get clientInfo(): { name: string; version?: string; [key: string]: any } | null {
        return this.client;
    }

    /**
     * The user id of the client in Botkit (`message.user`): its `clientInfo.name` with characters other than letters, digits, `_`, `.` and `-`
     * replaced by `-`, at most 64 characters, or `mcp-client` if it sent no name, or before it sent `initialize`.
     * Botkit stores the dialog state of chat sessions under this id, so a client cannot answer a question asked by a proactive dialog
     * that started under another id, such as one started before `initialize`.
     */
    public get clientId(): string {
        return this.currentClientId;
    }

    /**
     * True once the client has sent `notifications/initialized`.
     */
    public get initialized(): boolean {
        return this.clientInitialized;
    }

    /**
     * Declare a tool. Agents see it in `tools/list`, and each call fires the Botkit event `tool:<name>`,
     * with the arguments in `message.value`. The handler reports back with `bot.say()` (text for the agent),
     * [bot.toolResult()](#toolResult) (a structured result) and [bot.toolError()](#toolError).
     *
     * Each call runs in its own conversation, so tool calls never disturb chat sessions or each other, and they are not queued.
     * Tool handlers should not start dialogs: use the chat tool for conversations.
     * Declare tools before the client connects; the server does not announce changes to the list.
     *
     * ```javascript
     * adapter.tool('menu', {
     *     title: 'Pizza menu',
     *     description: 'List the pizzas on the menu, optionally filtered by a word such as "veg".',
     *     inputSchema: {
     *         type: 'object',
     *         properties: { filter: { type: 'string', description: 'A word to filter by' } }
     *     },
     *     annotations: { readOnlyHint: true, openWorldHint: false }
     * });
     *
     * controller.on('tool:menu', async (bot, message) => {
     *     const pizzas = menu.filter((pizza) => !message.value.filter || pizza.tags.includes(message.value.filter));
     *     bot.toolResult({ pizzas: pizzas });
     * });
     * ```
     *
     * @param name The tool name: 1 to 128 letters, digits, `_`, `-` or `.`. It must not be the chat tool's name.
     * @param definition An [McpToolDefinition](#McpToolDefinition) with the description, schemas and annotations.
     * @returns The adapter, so calls can be chained.
     */
    public tool(name: string, definition: McpToolDefinition = {}): this {
        if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
            throw new Error(`Invalid MCP tool name ${ JSON.stringify(name) }: use 1 to 128 letters, digits, "_", "-" or "."`);
        }
        if (this.options.chatTool && name === this.options.chatTool.name) {
            throw new Error(`The MCP tool name "${ name }" is used by the chat tool. Choose another name, or rename the chat tool with the chatTool option.`);
        }
        if (this.tools.has(name)) {
            throw new Error(`The MCP tool "${ name }" is already declared`);
        }
        if (!isPlainObject(definition)) {
            throw new Error(`The definition of MCP tool "${ name }" must be an object`);
        }
        ['inputSchema', 'outputSchema'].forEach((field) => {
            const schema = definition[field];
            if (schema !== undefined && !(isPlainObject(schema) && schema.type === 'object')) {
                throw new Error(`The ${ field } of MCP tool "${ name }" must be a JSON Schema with type: 'object'`);
            }
        });
        this.tools.set(name, { ...definition, inputSchema: definition.inputSchema || { type: 'object', properties: {} } });
        return this;
    }

    /**
     * Botkit-only: called automatically by Botkit when the adapter is passed to `new Botkit({ adapter })` or `controller.usePlugin(adapter)`.
     * Makes the adapter available as `controller.plugins.mcp`, stops it on `controller.shutdown()`,
     * and, unless `autoStart` is false, calls [listen()](#listen) once Botkit is ready.
     * @param botkit The Botkit controller.
     */
    public init(botkit: Botkit): void {
        this.controller = botkit;
        botkit.addPluginExtension('mcp', this);
        botkit.on('shutdown', async () => {
            // Leave the console on stderr: the shutdown handlers registered after this one have not run yet,
            // and the client may still be reading stdout.
            this.stop();
        });
        if (this.options.autoStart) {
            botkit.ready(() => {
                // wait for the rest of the bot's code to register its handlers and tools
                setImmediate(() => {
                    if (!this.closed && !this.connection) {
                        this.listen();
                    }
                });
            });
        }
    }

    /**
     * Start reading JSON-RPC messages from the input stream. Botkit calls this automatically unless `autoStart` is false.
     * Calling it again does nothing. When the input stream ends, the adapter finishes the requests in progress and,
     * if `shutdownOnClose` is set, calls `controller.shutdown()`.
     *
     * ```javascript
     * const adapter = new McpAdapter({ autoStart: false });
     * const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
     * controller.ready(() => {
     *     // ...load features and declare tools first
     *     adapter.listen();
     * });
     * ```
     */
    public listen(): void {
        if (this.closed) {
            throw new Error('This McpAdapter has been closed and cannot listen again');
        }
        if (this.connection) {
            return;
        }
        this.connection = new JsonRpcConnection(this.options.input, this.options.output, (message) => this.handleMessage(message));
        this.connection.onClose(() => this.onInputClosed());
        this.connection.start();
        debug('Listening for MCP requests');
    }

    /**
     * Stop serving: stop reading input, drop the responses of requests still in progress, and restore the console.
     * It does not shut Botkit down. Calling it again does nothing.
     *
     * `controller.shutdown()` stops the adapter too, but leaves the console redirected, so that the `shutdown` handlers that run
     * after the adapter's cannot write to stdout. Call `close()` afterwards to restore it. When the input ends and the adapter
     * shuts Botkit down itself (`shutdownOnClose`), it restores the console once every `shutdown` handler has finished.
     *
     * ```javascript
     * process.on('SIGTERM', async () => {
     *     await controller.shutdown(); // stops the adapter
     * });
     * ```
     */
    public close(): void {
        this.stop();
        if (this.consoleRedirected) {
            this.consoleRedirected = false;
            restoreConsole();
        }
    }

    /**
     * Handle one parsed JSON-RPC message, or a batch (an array of messages), and return the response to send.
     * The connection calls this for each line of input; call it directly to serve MCP over another transport, or in tests.
     * It never rejects: failures become JSON-RPC error responses.
     *
     * ```javascript
     * const response = await adapter.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
     * console.log(response.result.tools.map((tool) => tool.name)); // ['chat', 'menu']
     * ```
     *
     * @param message A JSON-RPC request, notification or response, or an array of them.
     * @returns The response object, an array of responses for a batch, or null when there is nothing to send (notifications and client responses).
     */
    public async handleMessage(message: any): Promise<any | null> {
        if (Array.isArray(message)) {
            if (!message.length) {
                return errorResponse(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
            }
            const responses = await Promise.all(message.map((item) => this.handleSingleMessage(item)));
            const results = responses.filter((response) => response !== null);
            return results.length ? results : null;
        }
        return this.handleSingleMessage(message);
    }

    /**
     * Call a tool directly, as the MCP method `tools/call` does: the chat tool, or a tool declared with [tool()](#tool).
     * Invalid arguments give a result with `isError: true` that tells the agent what to fix. An unknown tool throws an Error with `rpcCode` -32602.
     *
     * ```javascript
     * const result = await adapter.callTool('chat', { message: 'order', session: 'test' });
     * console.log(result.content[0].text);
     * console.log(result.structuredContent.awaitingInput);
     * ```
     *
     * @param name The tool name.
     * @param args The tool arguments. Defaults to `{}`.
     * @param meta The progress token and request id of the call, if any.
     * @returns The tool result.
     */
    public async callTool(name: string, args: { [key: string]: any } = {}, meta: McpCallMeta = {}): Promise<McpCallToolResult> {
        if (!this.controller) {
            throw new Error('The McpAdapter is not connected to Botkit: pass it to new Botkit({ adapter }) or controller.usePlugin(adapter)');
        }
        if (!isPlainObject(args)) {
            throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params: arguments must be an object');
        }
        const callMeta = meta || {};
        if (this.options.chatTool && name === this.options.chatTool.name) {
            return this.callChat(args, callMeta);
        }
        const definition = this.tools.get(name);
        if (!definition) {
            throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${ name }`);
        }
        return this.callDeclaredTool(name, definition, args, callMeta);
    }

    /**
     * Send a JSON-RPC notification to the client. Nothing is sent when the adapter is not listening.
     *
     * ```javascript
     * adapter.notify('notifications/message', { level: 'info', logger: 'deploy', data: 'Deploy finished' });
     * ```
     *
     * @param method The notification method, such as `notifications/message`.
     * @param params The notification params.
     */
    public notify(method: string, params?: any): void {
        if (!this.connection || this.closed) {
            debug('Not listening, dropping notification', method);
            return;
        }
        const message: { [key: string]: any } = { jsonrpc: '2.0', method: method };
        if (params !== undefined) {
            message.params = params;
        }
        this.connection.send(message);
    }

    /**
     * Send a log message to the client as a `notifications/message` notification, if `level` is at or above the level
     * the client set with `logging/setLevel` (default `info`). In handlers, use `bot.log()`, which calls this.
     *
     * ```javascript
     * adapter.log('warning', { job: 'nightly-report', message: 'Took longer than usual' }, 'scheduler');
     * ```
     *
     * @param level One of `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert` or `emergency`.
     * @param data Anything that can be serialized as JSON.
     * @param logger The name of the logger. Defaults to `botkit`.
     */
    public log(level: McpLogLevel, data: any, logger = 'botkit'): void {
        const rank = MCP_LOG_LEVELS.indexOf(level);
        if (rank < 0) {
            throw new Error(`Unknown MCP log level ${ JSON.stringify(level) }: use one of ${ MCP_LOG_LEVELS.join(', ') }`);
        }
        if (rank < MCP_LOG_LEVELS.indexOf(this.minLogLevel)) {
            return;
        }
        this.notify('notifications/message', { level: level, logger: logger, data: data });
    }

    /**
     * Get the conversation reference of a chat session, for proactive messages with `bot.changeContext()`.
     * `bot.startConversationWithUser(session)` does this for you.
     *
     * ```javascript
     * const bot = await controller.spawn({}, adapter);
     * await bot.changeContext(adapter.getReference('default'));
     * await bot.say('Your pizza is on its way.');
     * ```
     *
     * @param session The chat session. Defaults to `default`.
     * @returns A conversation reference for the session and the current client.
     */
    public getReference(session = 'default'): Partial<ConversationReference> {
        if (typeof session !== 'string' || !SESSION_NAME.test(session)) {
            throw new Error(`Invalid MCP session ${ JSON.stringify(session) }: use 1 to 128 letters, digits, "_", ".", ":", "@" or "-"`);
        }
        return {
            channelId: CHANNEL_ID,
            conversation: { id: SESSION_PREFIX + session } as ConversationAccount,
            user: { id: this.clientId } as ChannelAccount,
            bot: { id: 'bot', name: this.options.serverInfo.name }
        };
    }

    /**
     * Standard BotBuilder adapter method to send messages. During a tool call, messages are collected into the call's result.
     * Messages sent outside a tool call (proactive messages, or messages sent after a call timed out) go to the outbox of their
     * chat session, which the next chat call returns, and are also sent to the client as `notifications/message` log notifications.
     * [BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#sendactivities).
     * @param context A TurnContext representing the current incoming message and environment.
     * @param activities An array of outgoing activities.
     * @returns One `{ id }` per activity.
     */
    public async sendActivities(context: TurnContext, activities: Partial<Activity>[]): Promise<ResourceResponse[]> {
        const request: McpRequestState = context.turnState.get(MCP_REQUEST_STATE);
        const responses: ResourceResponse[] = [];
        activities.forEach((activity) => {
            responses.push({ id: 'mcp-out-' + (++this.outboundCount) });
            const reply = normalizeReply(activity, this.options.unescapeHtml);
            if (!reply) {
                debug('Not reporting activity of type', activity.type);
                return;
            }
            debug('OUTGOING > ', reply);
            if (request && !request.done) {
                request.replies.push(reply);
                if (reply.choices) {
                    request.choicesInTurn = reply.choices;
                }
            } else {
                this.deliverLater(activity, reply);
            }
        });
        return responses;
    }

    /**
     * The MCP adapter does not support updating messages: this does nothing.
     * @param context A TurnContext representing the current incoming message and environment.
     * @param activity The activity to update.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async updateActivity(context: TurnContext, activity: Partial<Activity>): Promise<void> {
        debug('MCP adapter does not support updateActivity.');
    }

    /**
     * The MCP adapter does not support deleting messages: this does nothing.
     * @param context A TurnContext representing the current incoming message and environment.
     * @param reference A reference to the activity to delete.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async deleteActivity(context: TurnContext, reference: Partial<ConversationReference>): Promise<void> {
        debug('MCP adapter does not support deleteActivity.');
    }

    /**
     * Standard BotBuilder adapter method for continuing an existing conversation based on a conversation reference.
     * The turn runs immediately and is not queued behind chat calls, so a scheduled job can run while a chat turn is in progress
     * (in the rare case that both change the same session's dialog state at once, the later save wins).
     * Messages it sends go to the session's outbox.
     * [BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#continueconversation)
     * @param reference A conversation reference, such as one from [getReference()](#getReference).
     * @param logic A bot logic function that will perform continuing action in the form `async(context) => { ... }`
     */
    public async continueConversation(reference: Partial<ConversationReference>, logic: (context: TurnContext) => Promise<void>): Promise<void> {
        const request = TurnContext.applyConversationReference(
            { type: 'event', name: 'continueConversation' },
            reference,
            true
        );
        const context = new TurnContext(this, request);
        await this.runMiddleware(context, logic);
    }

    /**
     * The MCP adapter does not accept HTTP requests: this answers any webhook request with status 405 and a JSON error,
     * so a Botkit webserver with this as its primary adapter never throws.
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
        res.end(JSON.stringify({ error: 'The MCP adapter speaks JSON-RPC over stdio; HTTP is not supported' }));
    }

    // ---------------------------------------------------------------------------------------------
    // JSON-RPC dispatch
    // ---------------------------------------------------------------------------------------------

    /**
     * Handle one message of a batch, or a message on its own.
     */
    private async handleSingleMessage(message: any): Promise<any | null> {
        if (!isPlainObject(message)) {
            return errorResponse(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
        }
        const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
        if (message.method === undefined && hasId && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'))) {
            // a response to a request from the server; this server never sends requests
            debug('Ignoring a response from the client', message.id);
            return null;
        }
        const id = hasId && isValidId(message.id) ? message.id : null;
        if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (hasId && !isValidId(message.id)) ||
            (message.params !== undefined && (message.params === null || typeof message.params !== 'object'))) {
            return errorResponse(id, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
        }

        const params = message.params === undefined ? {} : message.params;
        if (!hasId) {
            try {
                this.handleNotification(message.method, params);
            } catch (err) {
                debug('Error handling notification', message.method, err);
            }
            return null;
        }

        this.inflight.add(id);
        let response: any;
        try {
            const result = await this.dispatch(message.method, params, id);
            response = { jsonrpc: '2.0', id: id, result: result };
        } catch (err) {
            if (err && typeof err.rpcCode === 'number') {
                response = errorResponse(id, err.rpcCode, err.message, err.rpcData);
            } else {
                debug('Internal error handling', message.method, err);
                response = errorResponse(id, JSONRPC_ERRORS.INTERNAL_ERROR, 'Internal error: ' + toError(err).message);
            }
        } finally {
            this.inflight.delete(id);
        }
        if (this.cancelled.delete(id)) {
            debug('Request %s was cancelled, dropping its response', id);
            return null;
        }
        return response;
    }

    /**
     * Handle a notification from the client.
     */
    private handleNotification(method: string, params: any): void {
        switch (method) {
        case 'notifications/initialized':
            this.clientInitialized = true;
            break;
        case 'notifications/cancelled':
            // only remember requests that are still running, so the set cannot grow forever
            if (params && this.inflight.has(params.requestId)) {
                debug('Client cancelled request', params.requestId, params.reason || '');
                this.cancelled.add(params.requestId);
            }
            break;
        default:
            // other notifications, and requests sent without an id, are ignored
            debug('Ignoring notification', method);
        }
    }

    /**
     * Run a request and return its result. Errors with an rpcCode become JSON-RPC errors with that code.
     */
    private async dispatch(method: string, params: any, id: string | number): Promise<any> {
        if (!isPlainObject(params)) {
            throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params: params must be an object');
        }
        switch (method) {
        case 'initialize':
            return this.initialize(params);
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: this.listTools() };
        case 'tools/call': {
            if (typeof params.name !== 'string') {
                throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params: name must be a string');
            }
            const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
            if (!isPlainObject(args)) {
                throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, 'Invalid params: arguments must be an object');
            }
            const meta = params._meta;
            const token = meta && (typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number') ? meta.progressToken : undefined;
            return this.callTool(params.name, args, { progressToken: token, requestId: id });
        }
        case 'logging/setLevel':
            if (!MCP_LOG_LEVELS.includes(params.level)) {
                throw rpcError(JSONRPC_ERRORS.INVALID_PARAMS, `Invalid params: level must be one of ${ MCP_LOG_LEVELS.join(', ') }`);
            }
            this.minLogLevel = params.level;
            return {};
        default:
            throw rpcError(JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${ method }`);
        }
    }

    /**
     * Handle `initialize`: remember the client and agree on a protocol version.
     */
    private initialize(params: any): any {
        this.client = isPlainObject(params.clientInfo) ? { ...params.clientInfo } : null;
        const name = this.client && this.client.name !== undefined && this.client.name !== null ? String(this.client.name) : '';
        this.currentClientId = name.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || DEFAULT_CLIENT_ID;
        this.negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION;
        debug('Initialized by %s with protocol %s', this.currentClientId, this.negotiatedVersion);

        const serverInfo: { [key: string]: any } = { name: this.options.serverInfo.name, version: this.options.serverInfo.version };
        if (this.options.serverInfo.title !== undefined && this.atLeast(STRUCTURED_OUTPUT_VERSION)) {
            serverInfo.title = this.options.serverInfo.title;
        }
        return {
            protocolVersion: this.negotiatedVersion,
            capabilities: { tools: { listChanged: false }, logging: {} },
            serverInfo: serverInfo,
            instructions: this.options.instructions !== undefined ? this.options.instructions : this.defaultInstructions()
        };
    }

    /**
     * True when the negotiated protocol version (or the latest, before `initialize`) is `version` or newer.
     */
    private atLeast(version: string): boolean {
        return (this.negotiatedVersion || LATEST_PROTOCOL_VERSION) >= version;
    }

    // ---------------------------------------------------------------------------------------------
    // Tools
    // ---------------------------------------------------------------------------------------------

    /**
     * The instructions sent to the client when none are configured.
     */
    private defaultInstructions(): string {
        const names = Array.from(this.tools.keys());
        const chat = this.options.chatTool;
        let instructions = 'This server is a Botkit bot.';
        if (chat) {
            instructions += ` Use the "${ chat.name }" tool to talk to it: send a message, read the replies, and when awaitingInput is true answer the pending question (prefer the listed choice values). Reuse the same session to continue a conversation.`;
        }
        if (names.length) {
            instructions += ` ${ chat ? 'It also offers these tools' : 'It offers these tools' }: ${ names.join(', ') }.`;
        }
        return instructions;
    }

    /**
     * The chat tool's definition.
     */
    private chatDefinition(): McpToolDefinition {
        const chat = this.options.chatTool;
        const botName = this.options.serverInfo.title || this.options.serverInfo.name;
        return {
            title: chat.title,
            description: chat.description !== undefined ? chat.description : `Talk to the ${ botName } bot. Returns the bot's replies, any choices it offers, and whether it is waiting for an answer (awaitingInput). Keep using the same session to continue a conversation.`,
            inputSchema: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: 'What to say to the bot. When answering a question, prefer the exact value of one of the listed choices. Send an empty string to collect messages that arrived while you were away.' },
                    session: { type: 'string', description: 'Conversation id; reuse it to continue, use a new one to start fresh. Default "default".' },
                    reset: { type: 'boolean', description: 'Cancel whatever the bot is waiting for in this session first.' }
                },
                required: ['message'],
                additionalProperties: false
            },
            outputSchema: {
                type: 'object',
                properties: {
                    session: { type: 'string' },
                    replies: { type: 'array', items: { type: 'object' } },
                    proactive: { type: 'array', items: { type: 'object' } },
                    awaitingInput: { type: 'boolean' },
                    pendingQuestion: { type: ['object', 'null'] },
                    choices: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, value: { type: 'string' } }, required: ['title', 'value'] } }
                },
                required: ['session', 'replies', 'awaitingInput']
            }
        };
    }

    /**
     * The `tools/list` entry of one tool, with the fields the negotiated protocol version supports.
     */
    private describeTool(name: string, definition: McpToolDefinition): { [key: string]: any } {
        const structured = this.atLeast(STRUCTURED_OUTPUT_VERSION);
        const entry: { [key: string]: any } = { name: name };
        if (definition.title !== undefined && structured) {
            entry.title = definition.title;
        }
        if (definition.description !== undefined) {
            entry.description = definition.description;
        }
        entry.inputSchema = definition.inputSchema;
        if (definition.outputSchema !== undefined && structured) {
            entry.outputSchema = definition.outputSchema;
        }
        if (definition.annotations !== undefined) {
            entry.annotations = definition.annotations;
        }
        return entry;
    }

    /**
     * Every tool, the chat tool first, then declared tools in the order they were declared.
     */
    private listTools(): { [key: string]: any }[] {
        const tools = [];
        if (this.options.chatTool) {
            tools.push(this.describeTool(this.options.chatTool.name, this.chatDefinition()));
        }
        this.tools.forEach((definition, name) => tools.push(this.describeTool(name, definition)));
        return tools;
    }

    /**
     * The result for arguments that do not match the tool's inputSchema.
     */
    private invalidArguments(name: string, problems: string[]): McpCallToolResult {
        return { content: [text(`Invalid arguments for tool "${ name }": ${ problems.join('; ') }`)], isError: true };
    }

    /**
     * Fresh state for a tool call.
     */
    private createRequest(tool: string, chat: boolean, meta: McpCallMeta): McpRequestState {
        return {
            tool: tool,
            chat: chat,
            replies: [],
            choicesInTurn: null,
            progressToken: meta.progressToken,
            requestId: meta.requestId,
            structured: undefined,
            isError: false,
            errors: [],
            done: false
        };
    }

    /**
     * Run one turn through the adapter's middleware and Botkit, limited by turnTimeout.
     * It rejects when Botkit fails to handle the turn, even if an `onTurnError` handler set on the adapter handled the error,
     * because the conversation state of a failed turn is not saved.
     * `afterTurn` runs once the turn has really finished, even if that is after the timeout; it must not reject.
     * It is awaited unless the turn timed out.
     */
    private async runTurn(context: TurnContext, request: McpRequestState, afterTurn?: () => Promise<void>): Promise<void> {
        context.turnState.set(MCP_REQUEST_STATE, request);
        let turnError: any;
        const logic = async (turnContext: TurnContext): Promise<void> => {
            try {
                await this.controller.handleTurn(turnContext);
            } catch (err) {
                turnError = err;
                throw err;
            }
        };
        const turn = this.runMiddleware(context, logic).then(() => {
            if (turnError) {
                throw turnError;
            }
        });
        const settled = afterTurn ? turn.then(afterTurn, afterTurn) : null;
        try {
            await withTimeout(turn, this.options.turnTimeout);
        } catch (err) {
            request.done = true;
            if (settled && !(err && err.name === 'TurnTimeoutError')) {
                await settled;
            }
            throw err;
        }
        request.done = true;
        if (settled) {
            await settled;
        }
    }

    /**
     * Call the chat tool: validate, then run the call in the session's queue.
     */
    private async callChat(args: { [key: string]: any }, meta: McpCallMeta): Promise<McpCallToolResult> {
        const name = this.options.chatTool.name;
        const problems = validateArguments(this.chatDefinition().inputSchema, args);
        if (typeof args.session === 'string' && !SESSION_NAME.test(args.session)) {
            problems.push('property "session" must be 1 to 128 letters, digits, "_", ".", ":", "@" or "-"');
        }
        if (problems.length) {
            return this.invalidArguments(name, problems);
        }
        const session: string = args.session === undefined ? 'default' : args.session;
        const key = `${ this.clientId }|${ session }`;
        return this.enqueue(key, () => this.runChat(session, key, args, meta));
    }

    /**
     * Run `task` after every earlier task with the same key has finished.
     */
    private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(key) || Promise.resolve();
        const result = previous.then(task);
        const tail = result.then(() => undefined, () => undefined);
        this.queues.set(key, tail);
        tail.then(() => {
            if (this.queues.get(key) === tail) {
                this.queues.delete(key);
            }
        });
        return result;
    }

    /**
     * One chat call, run in its session's queue.
     */
    private async runChat(session: string, key: string, args: { [key: string]: any }, meta: McpCallMeta): Promise<McpCallToolResult> {
        const toolName = this.options.chatTool.name;
        const cancelled = (): boolean => meta.requestId !== undefined && this.cancelled.has(meta.requestId);
        if (cancelled()) {
            // the client cancelled this call while it waited for the one before it
            return { content: [text('Cancelled')], isError: true };
        }

        const message: string = args.message;
        let proactive: McpReply[] = [];
        let request: McpRequestState = null;
        let pending: BotkitPendingQuestion | null = null;
        let failure: Error = null;

        try {
            await this.waitForRunningTurn(session, key);
            if (cancelled()) {
                return { content: [text('Cancelled')], isError: true };
            }
            if (args.reset === true) {
                await this.resetSession(session, key);
            }
            proactive = this.takeOutbox(SESSION_PREFIX + session);
            if (message === '') {
                pending = await this.peekPendingQuestion(session);
                this.reconcileChoices(key, pending, proactive);
            } else {
                if (this.lastChoices.has(key) || proactive.some((reply) => !!reply.choices)) {
                    this.reconcileChoices(key, await this.peekPendingQuestion(session), proactive);
                }
                request = this.createRequest(toolName, true, meta);
                const context = new TurnContext(this, this.createChatActivity(session, message, key, meta));
                await this.runTurn(context, request, this.trackTurn(key));
                pending = await this.controller.getPendingQuestion(context);
            }
        } catch (err) {
            failure = toError(err);
            debug('Chat call failed', failure);
            pending = await this.peekPendingQuestion(session).catch((peekError) => {
                debug('Could not read the pending question', peekError);
                return null;
            });
        }

        if (request) {
            this.updateChoices(key, request.choicesInTurn, pending);
        }

        const replies = request ? request.replies : [];
        const remembered = this.lastChoices.get(key);
        const choices = remembered ? remembered.choices : [];
        const rendered = renderRepliesText(replies, {
            proactive: proactive,
            awaitingInput: !!pending,
            key: pending ? pending.key : undefined,
            toolName: toolName,
            session: session,
            unescapeHtml: this.options.unescapeHtml,
            empty: failure ? '' : undefined
        });
        const lines = !failure ? [] : [failure.name === SESSION_BUSY_ERROR ? failure.message : `The bot failed to handle this message: ${ failure.message }`];
        if (rendered) {
            lines.push(rendered);
        }
        const content = [text(lines.join('\n'))];
        if (request) {
            request.errors.forEach((error) => content.push(text(error)));
        }

        const result: McpCallToolResult = { content: content };
        if (this.atLeast(STRUCTURED_OUTPUT_VERSION)) {
            let pendingQuestion: { [key: string]: any } = null;
            if (pending) {
                pendingQuestion = { dialog: pending.dialog, thread: pending.thread };
                if (pending.key !== undefined) {
                    pendingQuestion.key = pending.key;
                }
            }
            result.structuredContent = {
                session: session,
                replies: replies,
                proactive: proactive,
                awaitingInput: !!pending,
                pendingQuestion: pendingQuestion,
                choices: choices
            };
        }
        if (failure || (request && request.isError)) {
            result.isError = true;
        }
        if (cancelled()) {
            // the client gave up on this call and never sees the result: keep its messages for the session's next call
            this.returnToOutbox(session, proactive, replies);
        }
        return result;
    }

    /**
     * Wait until a turn of this session that timed out has really finished, so the next call never runs beside it
     * (both would save the session's state, and the later save would undo the other's changes).
     * It waits for up to turnTimeout, then fails with an error for the agent.
     */
    private async waitForRunningTurn(session: string, key: string): Promise<void> {
        const running = this.runningTurns.get(key);
        if (!running) {
            return;
        }
        debug('Waiting for the earlier turn of session', session);
        try {
            await withTimeout(running, this.options.turnTimeout);
        } catch (err) {
            const busy = new Error(`The bot is still busy with an earlier message in session "${ session }", which timed out, so this call did nothing. Try again later.`);
            busy.name = SESSION_BUSY_ERROR;
            throw busy;
        }
    }

    /**
     * Mark a chat session as busy until its turn has really finished, even if the call times out first.
     * Returns the `afterTurn` function for runTurn() that removes the mark.
     */
    private trackTurn(key: string): () => Promise<void> {
        let finished: () => void;
        const running = new Promise<void>((resolve) => {
            finished = resolve;
        });
        this.runningTurns.set(key, running);
        return async (): Promise<void> => {
            if (this.runningTurns.get(key) === running) {
                this.runningTurns.delete(key);
            }
            finished();
        };
    }

    /**
     * Remember what a chat session offers. A session with no waiting question and no choices has no entry.
     */
    private rememberChoices(key: string, question: string | null, choices: McpChoice[]): void {
        if (question === null && !choices.length) {
            this.lastChoices.delete(key);
        } else {
            this.lastChoices.set(key, { choices: choices, question: question });
        }
    }

    /**
     * Before a call runs its turn, bring the remembered choices up to date with the question waiting now,
     * which proactive turns may have changed since the last call. `proactive` holds the messages the call delivers.
     * A question that was already waiting at the last call keeps its own choices. Otherwise the choices of the last
     * proactive message that offers any belong to the question waiting now (or to none), and older choices are dropped.
     */
    private reconcileChoices(key: string, pending: BotkitPendingQuestion | null, proactive: McpReply[]): void {
        const question = questionId(pending);
        let offered: McpChoice[] = null;
        proactive.forEach((reply) => {
            if (reply.choices) {
                offered = reply.choices;
            }
        });
        const remembered = this.lastChoices.get(key);
        const knownQuestion = remembered ? remembered.question : null;
        if (question !== knownQuestion) {
            this.rememberChoices(key, question, offered || []);
        } else if (question === null && offered) {
            this.rememberChoices(key, null, offered);
        }
    }

    /**
     * Update the choices remembered for a chat session after a turn.
     * The last choices offered in the turn win. A turn that offers none keeps the earlier ones only while the same question is still waiting,
     * so the choices of an answered question are never offered for the next one.
     */
    private updateChoices(key: string, choicesInTurn: McpChoice[] | null, pending: BotkitPendingQuestion | null): void {
        const question = questionId(pending);
        const remembered = this.lastChoices.get(key);
        if (choicesInTurn) {
            this.rememberChoices(key, question, choicesInTurn);
        } else if (question === null || !remembered || remembered.question !== question) {
            this.rememberChoices(key, question, []);
        }
    }

    /**
     * Cancel every dialog in a chat session, as the chat tool's `reset` argument asks.
     */
    private async resetSession(session: string, key: string): Promise<void> {
        const bot = await this.controller.spawn({}, this);
        await bot.changeContext(this.getReference(session));
        await bot.cancelAllDialogs();
        await this.controller.saveState(bot);
        this.lastChoices.delete(key);
        debug('Reset session', session);
    }

    /**
     * The incoming activity of a chat call. When the message is the title of a choice the bot offered, its value is sent instead.
     */
    private createChatActivity(session: string, message: string, key: string, meta: McpCallMeta): Partial<Activity> {
        let textValue = message;
        let value: string;
        const remembered = this.lastChoices.get(key);
        const choices = remembered ? remembered.choices : [];
        if (message && choices.length) {
            const wanted = message.trim().toLowerCase();
            const choice = choices.find((c) => c.value === message) || choices.find((c) => c.title.trim().toLowerCase() === wanted);
            if (choice) {
                textValue = choice.value;
                value = choice.value;
            }
        }
        const activity: Partial<Activity> = {
            type: ActivityTypes.Message,
            id: 'mcp-in-' + (++this.inboundCount),
            timestamp: new Date(),
            channelId: CHANNEL_ID,
            conversation: { id: SESSION_PREFIX + session } as ConversationAccount,
            from: { id: this.clientId, name: this.clientName() },
            recipient: { id: 'bot', name: this.options.serverInfo.name },
            text: textValue,
            channelData: { mcp: { requestId: meta.requestId, tool: this.options.chatTool.name, session: session } }
        };
        if (value !== undefined) {
            activity.value = value;
        }
        return activity;
    }

    /**
     * Read the pending question of a session from storage, without running a turn.
     */
    private async peekPendingQuestion(session: string): Promise<BotkitPendingQuestion | null> {
        const activity: Partial<Activity> = {
            type: ActivityTypes.Message,
            channelId: CHANNEL_ID,
            conversation: { id: SESSION_PREFIX + session } as ConversationAccount,
            from: { id: this.clientId, name: this.clientName() },
            recipient: { id: 'bot', name: this.options.serverInfo.name },
            text: ''
        };
        return this.controller.getPendingQuestion(new TurnContext(this, activity));
    }

    /**
     * Call a declared tool: validate the arguments, fire `tool:<name>` in a conversation of its own, and build the result.
     */
    private async callDeclaredTool(name: string, definition: McpToolDefinition, args: { [key: string]: any }, meta: McpCallMeta): Promise<McpCallToolResult> {
        const problems = validateArguments(definition.inputSchema, args);
        if (problems.length) {
            return this.invalidArguments(name, problems);
        }

        const request = this.createRequest(name, false, meta);
        const slot = this.claimToolSlot();
        const activity: Partial<Activity> = {
            type: ActivityTypes.Event,
            name: name,
            value: args,
            id: 'mcp-in-' + (++this.inboundCount),
            timestamp: new Date(),
            channelId: CHANNEL_ID,
            // a conversation of its own, so no dialog waiting for an answer in a chat session can swallow the event
            conversation: { id: `tool:${ name }:${ slot }` } as ConversationAccount,
            from: { id: this.clientId, name: this.clientName() },
            recipient: { id: 'bot', name: this.options.serverInfo.name },
            channelData: { botkitEventType: 'tool:' + name, mcp: { requestId: meta.requestId, tool: name } }
        };
        const context = new TurnContext(this, activity);

        let failure: Error = null;
        try {
            // Nothing can ever continue this conversation, so remove the state Botkit saved for it,
            // then let a later call use its id. Waits for the turn to really finish, even after a timeout.
            await this.runTurn(context, request, async () => {
                await this.forgetConversation(context);
                this.busyToolSlots.delete(slot);
            });
        } catch (err) {
            failure = toError(err);
            debug('Tool call failed', name, failure);
        }

        const content: { type: 'text'; text: string }[] = [];
        const rendered = renderRepliesText(request.replies, { unescapeHtml: this.options.unescapeHtml, empty: '' });
        if (rendered) {
            content.push(text(rendered));
        }
        if (request.structured !== undefined) {
            content.push(text(JSON.stringify(request.structured)));
        }
        request.errors.forEach((error) => content.push(text(error)));

        let isError = request.isError;
        if (failure) {
            isError = true;
            content.push(text(`Tool "${ name }" failed: ${ failure.message }`));
        }
        let structured = request.structured;
        if (structured !== undefined && definition.outputSchema !== undefined) {
            // clients check structuredContent against the outputSchema, and reject the whole result when it does not match
            const problems = validateArguments(definition.outputSchema, structured);
            if (problems.length) {
                isError = true;
                structured = undefined;
                content.push(text(`Tool "${ name }" returned a result that does not match its outputSchema: ${ problems.join('; ') }`));
            }
        }
        if (!isError && definition.outputSchema !== undefined && request.structured === undefined) {
            isError = true;
            content.push(text(`Tool "${ name }" declared an outputSchema but its handler did not call bot.toolResult()`));
        }
        if (!content.length) {
            content.push(text(isError ? `Tool "${ name }" reported an error.` : '(no output)'));
        }

        const result: McpCallToolResult = { content: content };
        if (structured !== undefined && this.atLeast(STRUCTURED_OUTPUT_VERSION)) {
            result.structuredContent = structured;
        }
        if (isError) {
            result.isError = true;
        }
        return result;
    }

    /**
     * The lowest number that no running tool call uses. Tool calls put it in their conversation id, so the ids,
     * and the storage keys Botkit creates for them, are reused instead of growing with every call.
     * (MemoryStorage, Botkit's default, keeps the key of deleted state.)
     */
    private claimToolSlot(): number {
        let slot = 1;
        while (this.busyToolSlots.has(slot)) {
            slot++;
        }
        this.busyToolSlots.add(slot);
        return slot;
    }

    /**
     * Delete the conversation state of a finished tool call from storage. Never rejects.
     */
    private async forgetConversation(context: TurnContext): Promise<void> {
        try {
            if (!this.toolState) {
                this.toolState = new BotkitConversationState(this.controller.storage);
            }
            await this.toolState.delete(context);
        } catch (err) {
            debug('Could not delete the state of a tool call', err);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Outbox and lifecycle
    // ---------------------------------------------------------------------------------------------

    /**
     * Keep a message sent outside a tool call for the session's next chat call, and tell the client about it.
     */
    private deliverLater(activity: Partial<Activity>, reply: McpReply): void {
        const conversationId = activity.conversation ? activity.conversation.id : undefined;
        const isSession = typeof conversationId === 'string' && conversationId.startsWith(SESSION_PREFIX);
        const session = isSession ? conversationId.slice(SESSION_PREFIX.length) : conversationId;
        if (isSession) {
            // any choices it offers are matched to the session's question when the next chat call delivers it
            this.addToOutbox(conversationId, [reply], false);
        } else {
            debug('Message for %s is not in a chat session and is only sent as a notification', conversationId);
        }
        this.log('info', { session: session, ...reply });
    }

    /**
     * Keep the messages of a chat call that the client cancelled, which it never sees, for the session's next call:
     * the waiting messages it collected go back to the front of the outbox, and the bot's replies are delivered like late replies.
     */
    private returnToOutbox(session: string, proactive: McpReply[], replies: McpReply[]): void {
        const conversationId = SESSION_PREFIX + session;
        this.addToOutbox(conversationId, proactive, true);
        this.addToOutbox(conversationId, replies, false);
        replies.forEach((reply) => this.log('info', { session: session, ...reply }));
    }

    /**
     * Add messages to the front or the back of a conversation's outbox, dropping the oldest beyond maxOutbox.
     */
    private addToOutbox(conversationId: string, replies: McpReply[], atFront: boolean): void {
        const current = this.outboxes.get(conversationId) || [];
        const outbox = atFront ? replies.concat(current) : current.concat(replies);
        while (outbox.length > this.options.maxOutbox) {
            outbox.shift();
        }
        if (outbox.length) {
            this.outboxes.set(conversationId, outbox);
        } else {
            this.outboxes.delete(conversationId);
        }
    }

    /**
     * Remove and return the messages waiting for a conversation.
     */
    private takeOutbox(conversationId: string): McpReply[] {
        const outbox = this.outboxes.get(conversationId) || [];
        this.outboxes.delete(conversationId);
        return outbox;
    }

    /**
     * The name of the client, for `from.name`.
     */
    private clientName(): string {
        return this.client && typeof this.client.name === 'string' && this.client.name ? this.client.name : this.clientId;
    }

    /**
     * Stop reading input and writing output. Unlike close(), this leaves the console redirected.
     */
    private stop(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.connection) {
            this.connection.close();
        }
        debug('Closed');
    }

    /**
     * The input stream ended and every request has been answered.
     */
    private onInputClosed(): void {
        debug('Input closed');
        if (this.options.shutdownOnClose && this.controller) {
            // restore the console only once every shutdown handler has run, so none of them can write to stdout
            this.controller.shutdown().catch((err) => {
                console.error('Error while shutting down the bot after the MCP client disconnected', err);
            }).then(() => this.close());
        } else {
            this.close();
        }
    }
}

/**
 * This interface defines the options that can be passed into the McpAdapter constructor function.
 */
export interface McpAdapterOptions {
    /**
     * The stream to read JSON-RPC messages from. Defaults to `process.stdin`.
     */
    input?: NodeJS.ReadableStream;

    /**
     * The stream to write JSON-RPC messages to. Defaults to `process.stdout`.
     */
    output?: NodeJS.WritableStream;

    /**
     * The name and version the server reports to clients. Defaults to `{ name: 'botkit-mcp', version: <this package's version> }`.
     * `title` is a human-readable name, sent to clients that negotiated protocol version 2025-06-18 or later.
     */
    serverInfo?: { name: string; version: string; title?: string };

    /**
     * Instructions for the agent, sent in the `initialize` result. Defaults to a short text that explains the chat tool and lists the declared tools.
     */
    instructions?: string;

    /**
     * Configure the chat tool, or set to false to offer only declared tools. Defaults to `{ name: 'chat' }` with a generated description.
     */
    chatTool?: false | { name?: string; title?: string; description?: string };

    /**
     * The longest a tool call may take, in milliseconds, before it returns an error. The turn keeps running in the background,
     * and the next chat call in its session waits for it to finish (again for up to this long) before it runs. 0 means no limit. Defaults to 15000.
     */
    turnTimeout?: number;

    /**
     * Send `console.log`, `console.info`, `console.debug` and `console.dir` to stderr until the adapter is closed, so they cannot corrupt the protocol stream.
     * `controller.shutdown()` leaves them redirected (see [close()](#close)). Defaults to true when `output` is `process.stdout`.
     */
    redirectConsole?: boolean;

    /**
     * Start listening as soon as Botkit is ready. Defaults to true. When false, call [listen()](#listen) yourself.
     */
    autoStart?: boolean;

    /**
     * Call `controller.shutdown()` when the input stream ends, so the process can exit when the client disconnects. Defaults to true.
     */
    shutdownOnClose?: boolean;

    /**
     * The most proactive messages kept per chat session until the agent's next chat call. Older messages are dropped first. Defaults to 50.
     */
    maxOutbox?: number;

    /**
     * Decode the HTML entities that mustache adds when dialog templates render `{{vars.x}}`. Defaults to true.
     */
    unescapeHtml?: boolean;
}
