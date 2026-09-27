/**
 * @module botbuilder-adapter-cli
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { BotWorker } from 'botkit';
import { CliAdapter } from './cli_adapter';

/**
 * This is a specialized version of [Botkit's core BotWorker class](core.md#BotWorker) that includes additional methods for the command line.
 * It includes all functionality from the base class, as well as the extension methods below.
 *
 * When using the CliAdapter with Botkit, all `bot` objects passed to handler functions will include these extensions.
 */
export class CliBotWorker extends BotWorker {
    /**
     * The CliAdapter this bot talks through. Use it to read the current user and conversation, or to submit input from code.
     *
     * ```javascript
     * controller.hears('whoami', 'message', async (bot, message) => {
     *     await bot.reply(message, `You are ${ bot.cli.user } in ${ bot.cli.conversationId }`);
     * });
     * ```
     */
    public get cli(): CliAdapter {
        return this.getConfig('adapter') as CliAdapter;
    }

    /**
     * Show a progress bar in the terminal, such as `[###-------] 30% Migrating`.
     * This sends an event activity `{ type: 'event', name: 'progress', value: { done, total, label } }`,
     * which the text format renders as a progress bar and the JSON format passes through as an event.
     *
     * ```javascript
     * controller.hears('migrate', 'message', async (bot, message) => {
     *     for (let done = 0; done <= 10; done++) {
     *         await bot.progress(done, 10, 'Migrating');
     *         await migrateBatch(done);
     *     }
     *     await bot.reply(message, 'Migration complete.');
     * });
     * ```
     *
     * @param done The amount of work finished.
     * @param total The total amount of work.
     * @param label An optional label shown after the percentage.
     * @returns The result of `bot.say()`.
     */
    public async progress(done: number, total: number, label?: string): Promise<any> {
        const activity: any = { type: 'event', name: 'progress', value: { done: done, total: total, label: label } };
        return this.say(activity);
    }

    /**
     * Point this bot at the terminal session, so that `bot.say()` prints into it from outside a turn,
     * for example from a timer or a scheduled job. Messages to a user other than the current one are shown as `bot (to <user>)> ...`.
     *
     * ```javascript
     * const bot = await controller.spawn();
     * await bot.startConversationWithUser();
     * await bot.say('The build finished.');
     * ```
     *
     * @param user The id of the user to address. Defaults to the current user of the session.
     * @returns This bot, with its context changed.
     */
    public async startConversationWithUser(user?: string): Promise<any> {
        return this.changeContext(this.cli.getReference(user));
    }
}
