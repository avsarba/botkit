/**
 * @module botkit-plugin-scheduler
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Activity, BotAdapter, ConversationReference, ResourceResponse, TurnContext } from 'botbuilder';
import * as Debug from 'debug';
import { BotkitScheduler, ScheduledJob } from './scheduler';
const debug = Debug('botkit:scheduler');

/**
 * The turnState key that holds a copy of the job in a clock-channel turn.
 */
const JOB_KEY = 'botkit-scheduler.job';

/**
 * The adapter behind the scheduler's built-in `scheduler` channel, which runs jobs that are not bound to a conversation ("clock jobs").
 *
 * Each [BotkitScheduler](#BotkitScheduler) creates one, available as `scheduler.clockAdapter`. It is never the controller's primary adapter:
 * Botkit spawns the `bot` for a clock-job turn from the turn's own adapter, so handlers use the normal `bot.say()`, `bot.beginDialog()` and so on.
 *
 * In a clock-job turn the activity has channelId `scheduler`, conversation id `scheduler:<job id>` and user id `scheduler`,
 * and `context.turnState.get('botkit-scheduler.job')` holds a copy of the job.
 * Anything the bot sends on this channel is handed to the scheduler's `output` option.
 *
 * ```javascript
 * const scheduler = new BotkitScheduler({
 *     output: async (activity, job) => {
 *         console.log(`[${ job ? job.id : 'scheduler' }] ${ activity.text }`);
 *     }
 * });
 * controller.usePlugin(scheduler);
 *
 * await scheduler.every('heartbeat', '1m', { event: 'heartbeat' });
 * controller.on('heartbeat', async (bot, message) => {
 *     await bot.say('still here'); // printed by the output function
 * });
 * ```
 */
export class ClockAdapter extends BotAdapter {
    /**
     * Name of this adapter.
     */
    public name = 'Scheduler Clock Adapter';

    private scheduler: BotkitScheduler;
    private sent = 0;

    /**
     * Create the clock adapter for a scheduler. BotkitScheduler does this itself; there is no need to call it.
     *
     * ```javascript
     * const clock = new ClockAdapter(scheduler);
     * ```
     *
     * @param scheduler The scheduler whose `output` option receives outgoing activities.
     */
    public constructor(scheduler: BotkitScheduler) {
        super();
        this.scheduler = scheduler;
    }

    /**
     * Run a turn on the clock channel through this adapter's middleware.
     * The scheduler calls this for every clock-job run; `logic` is normally `controller.handleTurn`.
     *
     * ```javascript
     * await scheduler.clockAdapter.run({
     *     type: 'event',
     *     name: 'heartbeat',
     *     channelId: 'scheduler',
     *     conversation: { id: 'scheduler:heartbeat' },
     *     from: { id: 'scheduler' },
     *     recipient: { id: 'bot' },
     *     channelData: { botkitEventType: 'heartbeat' }
     * }, controller.handleTurn.bind(controller));
     * ```
     *
     * @param activity The incoming activity. It must include `channelId`, `conversation.id` and `from.id`.
     * @param logic The turn handler, in the form `async(context) => { ... }`.
     * @param job The job this turn runs, stored in `context.turnState` as `botkit-scheduler.job` and passed to the output function.
     */
    public async run(activity: Partial<Activity>, logic: (context: TurnContext) => Promise<any>, job?: ScheduledJob): Promise<void> {
        const context = new TurnContext(this, activity);
        if (job) {
            context.turnState.set(JOB_KEY, job);
        }
        await this.runMiddleware(context, logic);
    }

    /**
     * Standard BotBuilder adapter method that sends outgoing activities. Each activity is passed to the scheduler's `output` function,
     * together with the job the turn belongs to (null when it cannot be found).
     * [BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#sendactivities).
     *
     * @param context A TurnContext representing the current incoming message and environment.
     * @param activities An array of outgoing activities.
     * @returns One `{ id }` per activity, in the form `clock-<n>`.
     */
    public async sendActivities(context: TurnContext, activities: Partial<Activity>[]): Promise<ResourceResponse[]> {
        const output = this.scheduler.getConfig('output');
        const job = await this.jobFor(context);
        const responses: ResourceResponse[] = [];
        for (const activity of activities) {
            debug('OUTGOING > ', activity);
            await output(activity, job);
            this.sent++;
            responses.push({ id: `clock-${ this.sent }` });
        }
        return responses;
    }

    /**
     * The clock channel does not support updateActivity.
     * @ignore
     */
    // eslint-disable-next-line
    public async updateActivity(context: TurnContext, activity: Partial<Activity>): Promise<void> {
        debug('Scheduler clock channel does not support updateActivity.');
    }

    /**
     * The clock channel does not support deleteActivity.
     * @ignore
     */
    // eslint-disable-next-line
    public async deleteActivity(context: TurnContext, reference: Partial<ConversationReference>): Promise<void> {
        debug('Scheduler clock channel does not support deleteActivity.');
    }

    /**
     * Standard BotBuilder adapter method for continuing an existing conversation based on a conversation reference.
     * Errors from the middleware or the logic are passed on to the caller.
     * [BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#continueconversation)
     *
     * @param reference A conversation reference on the `scheduler` channel.
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
     * Find the job behind a context: the copy stored by run(), or else the job named by a `scheduler:<id>` conversation id
     * (for a bot moved onto the clock channel with changeContext).
     */
    private async jobFor(context: TurnContext): Promise<ScheduledJob | null> {
        const stored = context.turnState.get(JOB_KEY);
        if (stored) {
            return stored;
        }
        const conversation = context.activity && context.activity.conversation ? context.activity.conversation.id : undefined;
        if (typeof conversation === 'string' && conversation.indexOf('scheduler:') === 0) {
            try {
                return (await this.scheduler.get(conversation.substr('scheduler:'.length))) || null;
            } catch (err) {
                debug('Could not look up the job for conversation', conversation, err);
            }
        }
        return null;
    }
}
