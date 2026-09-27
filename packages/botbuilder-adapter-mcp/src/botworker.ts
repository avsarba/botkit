/**
 * @module botbuilder-adapter-mcp
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { BotWorker } from 'botkit';
import * as Debug from 'debug';
import { McpAdapter } from './mcp_adapter';
import { MCP_REQUEST_STATE, McpLogLevel, McpRequestState } from './protocol';
import { isPlainObject } from './util';
const debug = Debug('botkit:mcp');

/**
 * This is a specialized version of [Botkit's core BotWorker class](core.md#BotWorker) that includes additional methods for AI agents connected over MCP.
 * It includes all functionality from the base class, as well as the extension methods below.
 *
 * When using the McpAdapter with Botkit, all `bot` objects passed to handler functions will include these extensions.
 */
export class McpBotWorker extends BotWorker {
    /**
     * Set the structured result of a declared tool call. The agent receives it as `structuredContent` (protocol 2025-06-18 and later)
     * and as a JSON text item. The value is copied when this is called, so later changes to it are not sent.
     * Call it once per tool call; a later call replaces the earlier result. Outside a tool call it does nothing.
     *
     * ```javascript
     * adapter.tool('menu', { description: 'List the pizzas on the menu', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } });
     *
     * controller.on('tool:menu', async (bot, message) => {
     *     const items = await menu.search(message.value.filter);
     *     bot.toolResult({ items: items });
     * });
     * ```
     *
     * @param result A plain object that can be serialized as JSON.
     */
    public toolResult(result: { [key: string]: any }): void {
        const request = this.getRequest();
        if (!request) {
            debug('bot.toolResult() was called outside a tool call and does nothing');
            return;
        }
        const notAnObject = 'bot.toolResult() expects a plain object, such as { items: [...] }';
        if (!isPlainObject(result)) {
            throw new TypeError(notAnObject);
        }
        let copy: any;
        try {
            copy = JSON.parse(JSON.stringify(result));
        } catch (err) {
            throw new TypeError('bot.toolResult() expects a value that can be serialized as JSON: ' + err.message);
        }
        // an object with toJSON(), such as a Date, may serialize to something else
        if (!isPlainObject(copy)) {
            throw new TypeError(notAnObject);
        }
        if (request.chat) {
            debug('bot.toolResult() is ignored during a chat turn: the chat tool always returns replies');
            return;
        }
        request.structured = copy;
    }

    /**
     * Mark the current tool call as failed. The agent receives a result with `isError: true` and the message as text.
     * The handler keeps running; return after calling this if there is nothing more to do. Outside a tool call it does nothing.
     *
     * ```javascript
     * controller.on('tool:refund', async (bot, message) => {
     *     const order = await orders.find(message.value.order_id);
     *     if (!order) {
     *         return bot.toolError(`There is no order ${ message.value.order_id }.`);
     *     }
     *     bot.toolResult(await orders.refund(order));
     * });
     * ```
     *
     * @param message An explanation for the agent.
     */
    public toolError(message?: string): void {
        const request = this.getRequest();
        if (!request) {
            debug('bot.toolError() was called outside a tool call and does nothing');
            return;
        }
        request.isError = true;
        if (message !== undefined && message !== null && message !== '') {
            request.errors.push(String(message));
        }
    }

    /**
     * Send a log message to the client as an MCP `notifications/message` notification, if `level` is at or above the level
     * the client set with `logging/setLevel` (default `info`). This also works outside tool calls, for example from a scheduled job.
     *
     * ```javascript
     * controller.on('tool:deploy', async (bot, message) => {
     *     bot.log('notice', { service: message.value.service, step: 'build started' }, 'deploy');
     *     // ...
     * });
     * ```
     *
     * @param level One of `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert` or `emergency`.
     * @param data Anything that can be serialized as JSON: a string, or an object with details.
     * @param logger The name of the logger. Defaults to `botkit`.
     */
    public log(level: McpLogLevel, data: any, logger = 'botkit'): void {
        this.mcpAdapter.log(level, data, logger);
    }

    /**
     * Report progress on a long tool call with an MCP `notifications/progress` notification.
     * It is sent only when the client asked for progress by sending a progress token with the call; otherwise it does nothing.
     * `progress` must grow with each call.
     *
     * ```javascript
     * controller.on('tool:migrate', async (bot, message) => {
     *     for (let batch = 1; batch <= 10; batch++) {
     *         await migrateBatch(batch);
     *         bot.progress(batch, 10, `Migrated batch ${ batch } of 10`);
     *     }
     *     bot.toolResult({ migrated: 10 });
     * });
     * ```
     *
     * @param progress The work done so far.
     * @param total The total amount of work, if known.
     * @param message A short description of the current step.
     */
    public progress(progress: number, total?: number, message?: string): void {
        const request = this.getRequest();
        if (!request || request.progressToken === undefined) {
            debug('bot.progress() does nothing: the call has no progress token');
            return;
        }
        const params: { [key: string]: any } = { progressToken: request.progressToken, progress: progress };
        if (total !== undefined && total !== null) {
            params.total = total;
        }
        if (message !== undefined && message !== null) {
            params.message = message;
        }
        this.mcpAdapter.notify('notifications/progress', params);
    }

    /**
     * Point this bot at a chat session, so that `bot.say()` sends proactive messages to it, for example from a timer or a scheduled job.
     * Proactive messages wait in the session's outbox until the agent's next call to the chat tool, and are also sent to the client
     * as `notifications/message` log notifications. `bot.beginDialog()` also works after this call.
     *
     * ```javascript
     * const bot = await controller.spawn({}, adapter);
     * await bot.startConversationWithUser('default');
     * await bot.say('The nightly report is ready.');
     * ```
     *
     * @param session The chat session, as passed in the chat tool's `session` argument. Defaults to `default`.
     * @returns This bot, with its context changed.
     */
    public async startConversationWithUser(session?: string): Promise<any> {
        return this.changeContext(this.mcpAdapter.getReference(session));
    }

    /**
     * The adapter this bot talks through.
     */
    private get mcpAdapter(): McpAdapter {
        return this.getConfig('adapter') as McpAdapter;
    }

    /**
     * The state of the tool call this bot is handling, or undefined outside a tool call or once the call has finished.
     */
    private getRequest(): McpRequestState | undefined {
        try {
            const context = this.getConfig('context');
            const request: McpRequestState = context && context.turnState ? context.turnState.get(MCP_REQUEST_STATE) : undefined;
            return request && !request.done ? request : undefined;
        } catch (err) {
            // the context of a finished turn is a revoked proxy
            return undefined;
        }
    }
}
