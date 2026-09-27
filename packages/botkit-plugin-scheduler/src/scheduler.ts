/**
 * @module botkit-plugin-scheduler
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Activity, BotAdapter, ConversationReference, Storage, TurnContext } from 'botbuilder';
import { Botkit, BotkitMessage, BotWorker } from 'botkit';
import * as crypto from 'crypto';
import * as Debug from 'debug';
import { ClockAdapter } from './clock_adapter';
import { assertTimezone, CronExpression, nextRun, parseCron } from './cron';
import { parseDuration } from './duration';
const debug = Debug('botkit:scheduler');

/** Event names a job cannot use. */
const RESERVED_EVENTS = ['message', 'shutdown'];

/** The longest delay setTimeout accepts. */
const MAX_DELAY = 2147483647;

/** The latest instant a JavaScript Date can hold. */
const MAX_TIME = 8.64e15;

/** Stop counting skipped cron slots after this many, so a long outage cannot stall the event loop. */
const MAX_SLOT_COUNT = 10000;

/** turnState key for the bookkeeping of the run a turn belongs to. */
const RUN_KEY = 'botkit-scheduler.run';

const NOT_REGISTERED = 'BotkitScheduler is not registered: call controller.usePlugin(scheduler) first';

/**
 * A source of time for [BotkitScheduler](#BotkitScheduler). Pass a fake one in tests to control time.
 * The default uses `Date.now()`, `setTimeout()` and `clearTimeout()`.
 */
export interface SchedulerClock {
    /**
     * The current time, in milliseconds since the epoch.
     */
    now(): number;
    /**
     * Call `fn` once after `ms` milliseconds, and return a handle for `clearTimeout()`.
     */
    setTimeout(fn: () => void, ms: number): any;
    /**
     * Cancel a callback set with `setTimeout()`.
     */
    clearTimeout(handle: any): void;
}

/**
 * Options for the [BotkitScheduler](#BotkitScheduler) constructor. Every option is optional.
 */
export interface BotkitSchedulerOptions {
    /**
     * Where jobs are saved. Defaults to the controller's storage (`controller.storage`).
     */
    storage?: Storage;
    /**
     * The storage key of the document that holds every job. Defaults to `botkit-scheduler/jobs`.
     */
    storageKey?: string;
    /**
     * The time zone for cron jobs that do not name one. Defaults to `UTC`.
     */
    timezone?: string;
    /**
     * What to do at startup with jobs whose run time passed while the bot was not running.
     * `skip` drops the missed runs, `once` (the default) runs the job once, and `all` runs every missed slot, up to `maxCatchUp`.
     */
    catchUp?: 'skip' | 'once' | 'all';
    /**
     * With `catchUp: 'all'`, the most missed runs to make up per job. Defaults to 10.
     */
    maxCatchUp?: number;
    /**
     * Delete one-shot jobs, and jobs that reached `maxRuns`, once they finish. Defaults to true.
     * When false, finished jobs stay in storage with `nextRunAt: null`.
     */
    pruneCompleted?: boolean;
    /**
     * How long a job's turn may run, in milliseconds, before it is recorded as failed. Defaults to 30000. 0 turns the limit off.
     * The turn itself is not cancelled.
     */
    turnTimeout?: number;
    /**
     * The adapter to use for jobs bound to a conversation, by the `channelId` of the job's reference.
     * Channels not listed here use the adapter the scheduler last saw spawn a bot on that channel, and then the controller's adapter.
     */
    adapters?: { [channelId: string]: BotAdapter };
    /**
     * Receives every activity a bot sends on the clock channel (the `scheduler` channel of jobs that have no reference),
     * with a copy of the job it belongs to, or null when that job cannot be found. Defaults to logging with `debug('botkit:scheduler')`.
     */
    output?: (activity: Partial<Activity>, job: ScheduledJob) => void | Promise<void>;
    /**
     * The source of time. Defaults to the system clock.
     */
    clock?: SchedulerClock;
    /**
     * Start the timer automatically once Botkit is ready. Defaults to true. When false, call `scheduler.start()` or drive it with `scheduler.tick()`.
     */
    autoStart?: boolean;
    /**
     * Unref the timer, so that a pending job does not keep the Node.js process alive. Defaults to false.
     */
    unref?: boolean;
}

/**
 * Options for [scheduler.schedule()](#schedule) and `bot.schedule()`. Give exactly one of `in`, `at`, `every` or `cron`.
 */
export interface ScheduleOptions {
    /**
     * The job id. Scheduling an id that already exists updates that job. Defaults to `job-` followed by 8 random hex characters.
     */
    id?: string;
    /**
     * The Botkit event the job fires. Handle it with `controller.on(event, handler)`. It cannot be `message` or `shutdown`.
     */
    event: string;
    /**
     * Data for the handler, available as `message.value`. It is stored as JSON.
     */
    payload?: any;
    /**
     * The conversation the job runs in, usually `message.reference`. Omit it, or pass null, for a clock job.
     * It must include `channelId`, `conversation.id` and `user.id`.
     * A reference on the scheduler's own `scheduler` channel (such as `message.reference` in a clock job's handler) also makes a clock job.
     */
    reference?: Partial<ConversationReference> | null;
    /**
     * Run once, after this long: milliseconds, or a duration such as `'90s'` or `'1h30m'`.
     * It is measured from each call, so scheduling the same id again moves the run (to snooze or debounce it).
     */
    in?: number | string;
    /**
     * Run once, at this time. A time in the past runs on the next tick.
     */
    at?: Date | string | number;
    /**
     * Run repeatedly, this often: milliseconds, or a duration such as `'5m'`.
     */
    every?: number | string;
    /**
     * Run on a cron schedule, such as `'0 9 * * MON-FRI'`. See [parseCron()](#parseCron) for the syntax.
     */
    cron?: string;
    /**
     * For cron jobs: the time zone the expression is read in. Defaults to the scheduler's `timezone`. Other jobs ignore it.
     */
    timezone?: string;
    /**
     * For every jobs: the time of the first run. Later runs follow at `every` intervals from it; a start in the past
     * begins at the next slot that is not in the past. Defaults to one interval from now. Other jobs ignore it.
     */
    startAt?: Date | string | number;
    /**
     * Stop after this many runs.
     */
    maxRuns?: number;
    /**
     * What to do when a run comes due while the previous run of the same job is still going.
     * `skip` (the default) skips the new run and counts it in `skipped`; `allow` runs both.
     */
    overlap?: 'skip' | 'allow';
}

/**
 * A scheduled job, as returned by [get()](#get), [list()](#list) and [schedule()](#schedule). Times are ISO 8601 strings.
 * Returned jobs are copies: changing them does not change the schedule.
 */
export interface ScheduledJob {
    /**
     * The job id.
     */
    id: string;
    /**
     * The Botkit event the job fires.
     */
    event: string;
    /**
     * The data passed to the handler as `message.value`, or null.
     */
    payload: any;
    /**
     * `at` for one-shot jobs (created with `at` or `in`), `every` for interval jobs and `cron` for cron jobs.
     */
    kind: 'at' | 'every' | 'cron';
    /**
     * For one-shot jobs: when it runs.
     */
    at: string | null;
    /**
     * For interval jobs: the interval in milliseconds.
     */
    every: number | null;
    /**
     * For cron jobs: the cron expression.
     */
    cron: string | null;
    /**
     * For cron jobs: the time zone the expression is read in.
     */
    timezone: string | null;
    /**
     * For interval jobs: the `startAt` they were created with, or null.
     */
    startAt: string | null;
    /**
     * The conversation the job runs in, or null for a clock job.
     * Only `channelId`, `serviceUrl`, `locale`, `conversation`, `user` and `bot` are kept.
     */
    reference: Partial<ConversationReference> | null;
    /**
     * When the job runs next, or null when it will not run again.
     */
    nextRunAt: string | null;
    /**
     * When the job last started a run, or null.
     */
    lastRunAt: string | null;
    /**
     * When the job was first scheduled.
     */
    createdAt: string;
    /**
     * How many times the job has run.
     */
    runs: number;
    /**
     * The most runs allowed, or null for no limit.
     */
    maxRuns: number | null;
    /**
     * True while the job is paused.
     */
    paused: boolean;
    /**
     * `skip` or `allow`: see [ScheduleOptions](#ScheduleOptions).
     */
    overlap: 'skip' | 'allow';
    /**
     * How many runs failed: the handler threw, the turn failed or it timed out.
     */
    errors: number;
    /**
     * The message of the latest failure, or null.
     */
    lastError: string | null;
    /**
     * How many run times passed without a run: overlapping runs, and runs missed while the bot was stopped or busy.
     */
    skipped: number;
}

/**
 * The resolved options, with every default applied.
 */
interface SchedulerConfig {
    storage: Storage | undefined;
    storageKey: string;
    timezone: string;
    catchUp: 'skip' | 'once' | 'all';
    maxCatchUp: number;
    pruneCompleted: boolean;
    turnTimeout: number;
    adapters: { [channelId: string]: BotAdapter };
    output: (activity: Partial<Activity>, job: ScheduledJob) => void | Promise<void>;
    clock: SchedulerClock;
    autoStart: boolean;
    unref: boolean;
}

/**
 * Bookkeeping for one run of a job, shared with the turn through turnState.
 */
interface RunRecord {
    job: ScheduledJob;
    failed: boolean;
}

/**
 * Give Botkit a clock: run cron, interval and one-shot jobs that survive restarts.
 *
 * A job that comes due becomes an ordinary Botkit turn with the job's event as `message.type`, handled with `controller.on(event, handler)`.
 * * A job without a conversation reference (a "clock job") runs on the scheduler's own `scheduler` channel. Messages the bot sends there go to the `output` option.
 * * A job with a reference runs inside that conversation, on the adapter that owns it, so `bot.say()` reaches the user.
 *   Scheduled turns are handled before the dialog system, so a job fires even while a dialog is waiting for an answer, and the
 *   dialog still receives the user's next message.
 *
 * Jobs are kept in Botkit storage and reloaded at startup, where the `catchUp` option decides what happens to runs that were missed.
 * The scheduler is built for a single process: if several processes share the storage, each one runs every job.
 *
 * ```javascript
 * const { BotkitScheduler } = require('botkit-plugin-scheduler');
 *
 * const scheduler = new BotkitScheduler({ timezone: 'America/New_York' });
 * controller.usePlugin(scheduler);
 *
 * // a nightly job, declared at every boot without creating duplicates
 * controller.ready(async () => {
 *     await controller.plugins.scheduler.cron('nightly-report', '0 2 * * *', { event: 'nightly_report' });
 * });
 * controller.on('nightly_report', async (bot, message) => {
 *     // runs at 2am New York time
 * });
 *
 * // a reminder in the user's own conversation
 * controller.hears('remind me', 'message', async (bot, message) => {
 *     await bot.schedule({ in: '10m', event: 'reminder', payload: { text: 'Stretch!' } });
 *     await bot.reply(message, 'OK, in 10 minutes.');
 * });
 * controller.on('reminder', async (bot, message) => {
 *     await bot.say(message.value.text);
 * });
 * ```
 */
export class BotkitScheduler {
    /**
     * The plugin name, used by Botkit.
     */
    public name = 'Scheduler';

    /**
     * Botkit middleware: the spawn middleware adds `bot.schedule()` and `bot.cancelSchedule()` to every bot.
     * @ignore
     */
    public middlewares: { spawn: ((bot: BotWorker, next: () => void) => void)[] };

    /**
     * Resolves once the jobs have been loaded from storage, and rejects with the storage error if they could not be read.
     * Every job method waits for it, so there is normally no need to.
     */
    public readonly loaded: Promise<void>;

    /**
     * The adapter behind the clock channel. See [ClockAdapter](#ClockAdapter).
     */
    public readonly clockAdapter: ClockAdapter;

    private _config: SchedulerConfig;
    private controller: Botkit;
    private storage: Storage;
    // Maps keyed by ids, events and channels have no prototype, so names such as "constructor" are safe.
    private jobs: { [id: string]: ScheduledJob } = Object.create(null);
    private catchUpSlots: { [id: string]: string[] } = Object.create(null);
    private inFlight = new Map<ScheduledJob, number>();
    private routes: { [event: string]: boolean } = Object.create(null);
    private learnedAdapters: { [channelId: string]: BotAdapter } = Object.create(null);
    private timer: any = null;
    private started = false;
    private stopped = false;
    private writeChain: Promise<void> = Promise.resolve();
    private queuedWrite: Promise<void> = null;
    private resolveLoaded: () => void;
    private rejectLoaded: (err: Error) => void;

    /**
     * Create a scheduler. Register it with `controller.usePlugin(scheduler)`, after which it is also available as `controller.plugins.scheduler`.
     *
     * ```javascript
     * const scheduler = new BotkitScheduler({
     *     timezone: 'Europe/Paris',
     *     catchUp: 'skip',
     *     output: (activity, job) => console.log(activity.text)
     * });
     * controller.usePlugin(scheduler);
     * ```
     *
     * @param options See [BotkitSchedulerOptions](#BotkitSchedulerOptions).
     * @throws Error when an option is not valid.
     */
    public constructor(options: BotkitSchedulerOptions = {}) {
        const catchUp = options.catchUp === undefined ? 'once' : options.catchUp;
        if (['skip', 'once', 'all'].indexOf(catchUp) < 0) {
            throw new Error('catchUp must be "skip", "once" or "all"');
        }
        const maxCatchUp = options.maxCatchUp === undefined ? 10 : options.maxCatchUp;
        if (!Number.isInteger(maxCatchUp) || maxCatchUp < 1) {
            throw new Error('maxCatchUp must be a positive integer');
        }
        const turnTimeout = options.turnTimeout === undefined ? 30000 : options.turnTimeout;
        if (typeof turnTimeout !== 'number' || !isFinite(turnTimeout) || turnTimeout < 0 || turnTimeout > MAX_DELAY) {
            throw new Error(`turnTimeout must be a number of milliseconds from 0 (no limit) to ${ MAX_DELAY }`);
        }
        const timezone = options.timezone === undefined ? 'UTC' : options.timezone;
        assertTimezone(timezone);

        this._config = {
            storage: options.storage,
            storageKey: options.storageKey || 'botkit-scheduler/jobs',
            timezone,
            catchUp,
            maxCatchUp,
            pruneCompleted: options.pruneCompleted !== false,
            turnTimeout,
            adapters: Object.assign(Object.create(null), options.adapters),
            output: options.output || ((activity, job): void => {
                debug('Clock channel output from job', job ? job.id : null, activity);
            }),
            clock: options.clock || {
                now: (): number => Date.now(),
                setTimeout: (fn, ms): any => setTimeout(fn, ms),
                clearTimeout: (handle): void => clearTimeout(handle)
            },
            autoStart: options.autoStart !== false,
            unref: options.unref === true
        };

        this.loaded = new Promise((resolve, reject) => {
            this.resolveLoaded = resolve;
            this.rejectLoaded = reject;
        });
        // A load failure is reported by every method that waits for `loaded`; do not also raise an unhandled rejection.
        this.loaded.catch((err) => debug('Jobs failed to load', err));

        this.clockAdapter = new ClockAdapter(this);

        this.middlewares = {
            spawn: [
                (bot, next): void => {
                    this.extendBot(bot);
                    next();
                }
            ]
        };
    }

    /**
     * Botkit plugin init function, called by `controller.usePlugin(scheduler)`.
     * Registers `controller.plugins.scheduler`, loads the saved jobs, stops the timer on shutdown and, unless `autoStart` is false,
     * starts the timer once Botkit is ready.
     *
     * ```javascript
     * controller.usePlugin(scheduler);
     * ```
     *
     * @param botkit A Botkit controller.
     */
    public init(botkit: Botkit): void {
        if (this.controller) {
            if (this.controller !== botkit) {
                throw new Error('BotkitScheduler is already registered with another controller');
            }
            return;
        }
        this.controller = botkit;
        this.storage = this._config.storage || botkit.storage;
        this._config.storage = this.storage;

        botkit.addPluginExtension('scheduler', this);
        botkit.on('shutdown', async () => {
            await this.stop();
        });

        this.load().then(this.resolveLoaded, (err) => {
            console.error('botkit-plugin-scheduler: could not load scheduled jobs; the scheduler will not run.', err);
            this.rejectLoaded(err);
        });

        if (this._config.autoStart) {
            // ready() runs inline when the webserver is disabled, before the bot's own handlers are registered.
            botkit.ready(() => {
                setImmediate(() => {
                    if (!this.stopped) {
                        this.start();
                    }
                });
            });
        }
    }

    /**
     * Get a value from the scheduler's resolved configuration, with defaults applied.
     *
     * ```javascript
     * const tz = scheduler.getConfig('timezone'); // 'UTC' unless set
     * ```
     *
     * @param key The name of an option from [BotkitSchedulerOptions](#BotkitSchedulerOptions). Omit it to get every option.
     */
    public getConfig(key?: string): any {
        return key ? this._config[key] : { ...this._config };
    }

    /**
     * Create a job, or update the job with the same id.
     *
     * Give exactly one of `in`, `at`, `every` or `cron`. When the id already exists with the same timing, event and reference,
     * the job keeps its next run time and counters, and only `payload`, `maxRuns` and `overlap` change. That makes it safe to
     * declare jobs at every startup. When the timing, event or reference changed, the next run time is worked out again,
     * and the counters are kept.
     *
     * If the job cannot be saved, the promise rejects with the storage error. The job is still scheduled in memory,
     * and it is saved by the next write that succeeds.
     *
     * ```javascript
     * // a clock job every 15 minutes
     * await scheduler.schedule({ id: 'sync', every: '15m', event: 'sync_inventory' });
     *
     * // a reminder in a conversation, tomorrow at 9am
     * await scheduler.schedule({
     *     event: 'reminder',
     *     at: '2026-09-28T09:00:00-04:00',
     *     reference: message.reference,
     *     payload: { text: 'Standup in 15 minutes' }
     * });
     * ```
     *
     * @param options See [ScheduleOptions](#ScheduleOptions).
     * @returns A copy of the job.
     */
    public async schedule(options: ScheduleOptions): Promise<ScheduledJob> {
        await this.whenLoaded();
        const now = this._config.clock.now();
        const job = this.build(options, now);

        let target = this.jobs[job.id];
        if (!target) {
            target = job;
            this.jobs[job.id] = job;
        } else if (sameTiming(target, job)) {
            target.payload = job.payload;
            target.maxRuns = job.maxRuns;
            target.overlap = job.overlap;
        } else {
            const { runs, errors, lastError, skipped, createdAt, lastRunAt, paused } = target;
            Object.assign(target, job, { runs, errors, lastError, skipped, createdAt, lastRunAt, paused });
            delete this.catchUpSlots[target.id];
        }
        if (target.maxRuns !== null && target.runs >= target.maxRuns) {
            this.finish(target);
        }

        this.route(target.event);
        await this.persist();
        this.arm();
        return copy(target);
    }

    /**
     * Create or update a job that runs at a fixed interval. Shorthand for `schedule({ ...options, id, every: interval })`.
     *
     * ```javascript
     * await scheduler.every('heartbeat', '1m', { event: 'heartbeat', payload: { source: 'cron' } });
     * ```
     *
     * @param id The job id.
     * @param interval Milliseconds, or a duration such as `'30s'` or `'1h'`.
     * @param options The event and any other [ScheduleOptions](#ScheduleOptions).
     * @returns A copy of the job.
     */
    public async every(id: string, interval: number | string, options: Partial<ScheduleOptions> & { event: string }): Promise<ScheduledJob> {
        return this.schedule({ ...options, id, every: interval });
    }

    /**
     * Create or update a job that runs on a cron schedule. Shorthand for `schedule({ ...options, id, cron: expression })`.
     *
     * ```javascript
     * await scheduler.cron('weekday-standup', '45 9 * * MON-FRI', {
     *     event: 'standup',
     *     timezone: 'Europe/London',
     *     reference: savedReference
     * });
     * ```
     *
     * @param id The job id.
     * @param expression A cron expression. See [parseCron()](#parseCron).
     * @param options The event and any other [ScheduleOptions](#ScheduleOptions), such as `timezone`.
     * @returns A copy of the job.
     */
    public async cron(id: string, expression: string, options: Partial<ScheduleOptions> & { event: string }): Promise<ScheduledJob> {
        return this.schedule({ ...options, id, cron: expression });
    }

    /**
     * Create or update a job that runs once, at a given time. Shorthand for `schedule({ ...options, id, at: when })`.
     *
     * ```javascript
     * await scheduler.at('launch', new Date('2026-10-01T15:00:00Z'), { event: 'launch' });
     * ```
     *
     * @param id The job id.
     * @param when A Date, an ISO 8601 string or milliseconds since the epoch.
     * @param options The event and any other [ScheduleOptions](#ScheduleOptions).
     * @returns A copy of the job.
     */
    public async at(id: string, when: Date | string | number, options: Partial<ScheduleOptions> & { event: string }): Promise<ScheduledJob> {
        return this.schedule({ ...options, id, at: when });
    }

    /**
     * Delete a job. A run that is already going is not stopped.
     *
     * ```javascript
     * await scheduler.cancel('heartbeat');
     * ```
     *
     * @param id The job id.
     * @returns True if the job existed.
     */
    public async cancel(id: string): Promise<boolean> {
        await this.whenLoaded();
        if (!this.jobs[id]) {
            return false;
        }
        delete this.jobs[id];
        delete this.catchUpSlots[id];
        await this.persist();
        this.arm();
        return true;
    }

    /**
     * Pause a job. It keeps its next run time but does not run until it is resumed.
     *
     * ```javascript
     * await scheduler.pause('nightly-report');
     * ```
     *
     * @param id The job id.
     * @returns A copy of the job, or undefined if there is no such job.
     */
    public async pause(id: string): Promise<ScheduledJob | undefined> {
        await this.whenLoaded();
        const job = this.jobs[id];
        if (!job) {
            return undefined;
        }
        if (!job.paused) {
            job.paused = true;
            await this.persist();
            this.arm();
        }
        return copy(job);
    }

    /**
     * Resume a paused job. Runs that fell due while it was paused are not made up:
     * an interval job continues at its next slot from now, and a cron job at its next matching time.
     * A one-shot job keeps its time, so it runs on the next tick if that time has passed.
     *
     * ```javascript
     * await scheduler.resume('nightly-report');
     * ```
     *
     * @param id The job id.
     * @returns A copy of the job, or undefined if there is no such job.
     */
    public async resume(id: string): Promise<ScheduledJob | undefined> {
        await this.whenLoaded();
        const job = this.jobs[id];
        if (!job) {
            return undefined;
        }
        if (job.paused) {
            job.paused = false;
            delete this.catchUpSlots[id];
            const now = this._config.clock.now();
            if (job.nextRunAt !== null && job.kind === 'every') {
                const next = Date.parse(job.nextRunAt);
                if (next < now) {
                    job.nextRunAt = toIso(next + Math.ceil((now - next) / job.every) * job.every);
                }
            } else if (job.nextRunAt !== null && job.kind === 'cron') {
                job.nextRunAt = isoOrNull(nextRun(job.cron, now, job.timezone));
            }
            await this.persist();
            this.arm();
        }
        return copy(job);
    }

    /**
     * Run a job now, whether or not it is paused and even if a run is already going. The job's next run time does not change,
     * but the run counts toward `maxRuns`, and a one-shot job is finished by it.
     * Errors in the run are recorded on the job and emitted as `scheduler_error`, as for any other run.
     *
     * Do not await it from inside a turn of the conversation the job is bound to, on an adapter that runs one turn at a time
     * per conversation: the job's turn would wait for the current turn, which waits for the job.
     *
     * ```javascript
     * controller.hears('report now', 'message', async (bot, message) => {
     *     await controller.plugins.scheduler.runNow('nightly-report');
     *     await bot.reply(message, 'Report sent.');
     * });
     * ```
     *
     * @param id The job id.
     * @returns Resolves when the job's turn ends.
     * @throws Error('Unknown job "<id>"') when there is no such job.
     */
    public async runNow(id: string): Promise<void> {
        await this.whenLoaded();
        const job = this.jobs[id];
        if (!job) {
            throw new Error(`Unknown job "${ id }"`);
        }
        await this.fire(job, toIso(this._config.clock.now()));
    }

    /**
     * Get one job.
     *
     * ```javascript
     * const job = await scheduler.get('heartbeat');
     * console.log(job.nextRunAt, job.runs, job.lastError);
     * ```
     *
     * @param id The job id.
     * @returns A copy of the job, or undefined if there is no such job.
     */
    public async get(id: string): Promise<ScheduledJob | undefined> {
        await this.whenLoaded();
        return this.jobs[id] ? copy(this.jobs[id]) : undefined;
    }

    /**
     * List jobs, soonest first. Jobs that will not run again come last. Ties are sorted by id.
     *
     * ```javascript
     * // every reminder for the user who sent this message
     * const reminders = await scheduler.list({ event: 'reminder', user: message.user });
     * ```
     *
     * @param filter Only list jobs with this `event`, whose reference has this `conversation` id, or whose reference has this `user` id.
     * @returns Copies of the matching jobs.
     */
    public async list(filter: { event?: string; conversation?: string; user?: string } = {}): Promise<ScheduledJob[]> {
        await this.whenLoaded();
        return Object.keys(this.jobs)
            .map((id) => this.jobs[id])
            .filter((job) => {
                if (filter.event !== undefined && job.event !== filter.event) {
                    return false;
                }
                if (filter.conversation !== undefined && !(job.reference && job.reference.conversation && job.reference.conversation.id === filter.conversation)) {
                    return false;
                }
                if (filter.user !== undefined && !(job.reference && job.reference.user && job.reference.user.id === filter.user)) {
                    return false;
                }
                return true;
            })
            .sort(byNextRun)
            .map(copy);
    }

    /**
     * Run every job that is due. The timer calls this; tests and custom loops can call it directly, with or without the timer.
     *
     * Each due job's next run time is worked out and saved before it runs, so a crash cannot run the same slot twice.
     * A job that fell several slots behind runs once and counts the other slots in `skipped`
     * (except runs being made up at startup with `catchUp: 'all'`).
     *
     * ```javascript
     * const fired = await scheduler.tick();
     * console.log(`${ fired } runs finished`);
     * ```
     *
     * @param now The time used to decide which jobs are due. Defaults to the clock's current time.
     * @returns Resolves when the turns it started have ended, with the number of runs.
     */
    public async tick(now?: number): Promise<number> {
        await this.whenLoaded();
        const time = typeof now === 'number' ? now : this._config.clock.now();

        // Choose and advance the due jobs without awaiting, so concurrent ticks cannot run the same slot twice.
        const due = Object.keys(this.jobs)
            .map((id) => this.jobs[id])
            .filter((job) => !job.paused && job.nextRunAt !== null && Date.parse(job.nextRunAt) <= time)
            .sort(byNextRun);

        const plans: { job: ScheduledJob; slots: string[] }[] = [];
        for (const job of due) {
            const slots = this.catchUpSlots[job.id] || [job.nextRunAt];
            delete this.catchUpSlots[job.id];
            this.advance(job, Date.parse(slots[slots.length - 1]), time);
            if (job.overlap === 'skip' && this.inFlight.get(job)) {
                debug('Skipping job still in flight:', job.id);
                job.skipped += slots.length;
            } else {
                plans.push({ job, slots });
            }
        }

        if (due.length) {
            try {
                await this.persist();
            } catch (err) {
                console.error('botkit-plugin-scheduler: could not save scheduled jobs', err);
            }
        }
        this.arm();

        const counts = await Promise.all(plans.map((plan) => this.runSlots(plan.job, plan.slots)));
        return counts.reduce((total, count) => total + count, 0);
    }

    /**
     * Start the timer that runs jobs when they are due. Botkit calls this when it is ready, unless `autoStart` is false.
     * Calling it again after [stop()](#stop) starts the timer again.
     *
     * ```javascript
     * const scheduler = new BotkitScheduler({ autoStart: false });
     * controller.usePlugin(scheduler);
     * // ...later
     * scheduler.start();
     * ```
     */
    public start(): void {
        if (!this.controller) {
            throw new Error(NOT_REGISTERED);
        }
        this.stopped = false;
        this.loaded.then(() => {
            if (!this.stopped) {
                this.started = true;
                this.arm();
            }
        }, (err) => {
            debug('Not starting the timer: the jobs could not be loaded', err);
        });
    }

    /**
     * Stop the timer and wait for pending storage writes. Runs that are already going are not waited for.
     * Botkit calls this on `controller.shutdown()`. [tick()](#tick) and the other methods keep working after it.
     *
     * ```javascript
     * await scheduler.stop();
     * ```
     */
    public async stop(): Promise<void> {
        this.stopped = true;
        this.clearTimer();
        await this.writeChain;
    }

    /**
     * Use a specific adapter for jobs bound to conversations on a channel. This is the same as the `adapters` option.
     *
     * ```javascript
     * scheduler.useAdapter('slack', slackAdapter);
     * ```
     *
     * @param channelId A `channelId`, as found in conversation references.
     * @param adapter The adapter that owns that channel.
     */
    public useAdapter(channelId: string, adapter: BotAdapter): void {
        this._config.adapters[channelId] = adapter;
    }

    /**
     * Throw if the plugin is not registered, then wait for the jobs to load.
     */
    private async whenLoaded(): Promise<void> {
        if (!this.controller) {
            throw new Error(NOT_REGISTERED);
        }
        await this.loaded;
    }

    /**
     * Read the saved jobs and apply the catch-up policy.
     */
    private async load(): Promise<void> {
        const key = this._config.storageKey;
        const items = await this.storage.read([key]);
        const doc = items ? items[key] : undefined;
        if (doc) {
            if (doc.version !== 1 || !doc.jobs || typeof doc.jobs !== 'object') {
                throw new Error(`Storage key "${ key }" does not hold a version 1 scheduler document`);
            }
            for (const id of Object.keys(doc.jobs)) {
                try {
                    this.jobs[id] = this.restore(id, doc.jobs[id]);
                } catch (err) {
                    console.error(`botkit-plugin-scheduler: skipping invalid job "${ id }": ${ err.message }`);
                }
            }
        }

        const changed = this.applyCatchUp(this._config.clock.now());
        for (const id of Object.keys(this.jobs)) {
            this.route(this.jobs[id].event);
        }
        if (changed) {
            this.persist().catch((err) => {
                console.error('botkit-plugin-scheduler: could not save scheduled jobs', err);
            });
        }
        debug('Loaded', Object.keys(this.jobs).length, 'jobs');
    }

    /**
     * Apply the catch-up policy to jobs that fell due while the bot was not running. Returns true if a job changed.
     */
    private applyCatchUp(now: number): boolean {
        const { catchUp, maxCatchUp } = this._config;
        let changed = false;
        for (const id of Object.keys(this.jobs)) {
            const job = this.jobs[id];
            if (job.paused || job.nextRunAt === null || Date.parse(job.nextRunAt) > now) {
                continue;
            }
            const first = Date.parse(job.nextRunAt);
            if (catchUp === 'skip') {
                changed = true;
                job.skipped += job.kind === 'at' ? 1 : 1 + this.countSlots(job, first, now);
                this.advance(job, first, now, false);
                if (job.kind === 'at') {
                    this.finish(job);
                }
            } else if (catchUp === 'all') {
                // Later slots beyond maxCatchUp are counted as skipped when the job runs.
                const slots = [job.nextRunAt];
                let slot = first;
                while (slots.length < maxCatchUp && job.kind !== 'at') {
                    slot = this.slotAfter(job, slot);
                    if (slot === null || slot > now) {
                        break;
                    }
                    slots.push(toIso(slot));
                }
                this.catchUpSlots[id] = slots;
            }
        }
        return changed;
    }

    /**
     * Move a job's nextRunAt past `now`, after its slot `last` ran or was skipped.
     * When `countMissed` is true, slots between `last` and `now` are added to `skipped`.
     */
    private advance(job: ScheduledJob, last: number, now: number, countMissed = true): void {
        if (job.kind === 'at') {
            job.nextRunAt = null;
            return;
        }
        if (countMissed) {
            job.skipped += this.countSlots(job, last, now);
        }
        let next: number;
        if (job.kind === 'every') {
            next = last + (Math.floor(Math.max(now - last, 0) / job.every) + 1) * job.every;
        } else {
            const date = nextRun(job.cron, Math.max(now, last), job.timezone);
            next = date ? date.getTime() : null;
        }
        job.nextRunAt = next === null ? null : toIso(next);
    }

    /**
     * The first slot of a recurring job after `slot`, or null.
     */
    private slotAfter(job: ScheduledJob, slot: number): number | null {
        if (job.kind === 'every') {
            return slot + job.every;
        }
        const date = nextRun(job.cron, slot, job.timezone);
        return date ? date.getTime() : null;
    }

    /**
     * The number of slots of a recurring job in (after, until], where `after` is one of its slots.
     */
    private countSlots(job: ScheduledJob, after: number, until: number): number {
        if (until <= after) {
            return 0;
        }
        if (job.kind === 'every') {
            return Math.floor((until - after) / job.every);
        }
        const cron = parseCron(job.cron);
        let count = 0;
        let slot = after;
        while (count < MAX_SLOT_COUNT) {
            const date = nextRun(cron, slot, job.timezone);
            if (!date || date.getTime() > until) {
                break;
            }
            count++;
            slot = date.getTime();
        }
        return count;
    }

    /**
     * Run the chosen slots of one job in order. Returns the number of runs.
     */
    private async runSlots(job: ScheduledJob, slots: string[]): Promise<number> {
        let runs = 0;
        for (const slot of slots) {
            // Stop if the job was cancelled, replaced, paused or finished since it was chosen.
            if (this.jobs[job.id] !== job || job.paused || (job.maxRuns !== null && job.runs >= job.maxRuns)) {
                break;
            }
            await this.fire(job, slot);
            runs++;
        }
        return runs;
    }

    /**
     * Run a job once: build its turn, race it against turnTimeout, record the outcome and save.
     * Never rejects.
     */
    private async fire(job: ScheduledJob, scheduledAt: string): Promise<void> {
        this.route(job.event);
        const now = this._config.clock.now();
        const firedAt = toIso(now);

        this.inFlight.set(job, (this.inFlight.get(job) || 0) + 1);
        job.runs += 1;
        job.lastRunAt = firedAt;
        if (job.maxRuns !== null && job.runs >= job.maxRuns) {
            job.nextRunAt = null;
        }

        const record: RunRecord = { job, failed: false };
        const info = { id: job.id, event: job.event, kind: job.kind, runs: job.runs, scheduledAt, firedAt };
        debug('Running job', info);

        try {
            await this.withTimeout(this.runTurn(job, record, info, new Date(now)), this._config.turnTimeout);
        } catch (err) {
            debug('Job failed:', job.id, err);
            this.recordError(record, err);
        } finally {
            const count = this.inFlight.get(job) - 1;
            if (count > 0) {
                this.inFlight.set(job, count);
            } else {
                this.inFlight.delete(job);
            }
        }

        // A job cancelled or replaced during the run has already been saved without it.
        if (this.jobs[job.id] === job) {
            if (job.kind === 'at' || (job.maxRuns !== null && job.runs >= job.maxRuns)) {
                this.finish(job);
            }
            try {
                await this.persist();
            } catch (err) {
                console.error('botkit-plugin-scheduler: could not save scheduled jobs', err);
            }
            this.arm();
        }
    }

    /**
     * Build the turn for one run of a job and hand it to Botkit.
     */
    private async runTurn(job: ScheduledJob, record: RunRecord, info: { [key: string]: any }, timestamp: Date): Promise<void> {
        const channelData = { botkitEventType: job.event, botkitScheduler: true, job: info };
        const value = copy(job.payload);
        const logic = async (context: TurnContext): Promise<void> => {
            context.turnState.set(RUN_KEY, record);
            await this.controller.handleTurn(context);
        };

        if (!job.reference) {
            const activity: Partial<Activity> = {
                type: 'event',
                name: job.event,
                id: `${ job.id }#${ info.runs }`,
                channelId: 'scheduler',
                conversation: { id: `scheduler:${ job.id }` } as any,
                from: { id: 'scheduler' } as any,
                recipient: { id: 'bot' } as any,
                value,
                channelData,
                timestamp
            };
            await this.clockAdapter.run(activity, logic, copy(job));
            return;
        }

        const adapter = this.adapterFor(job.reference.channelId);
        let ran = false;
        try {
            await adapter.continueConversation(copy(job.reference), async (context) => {
                ran = true;
                Object.assign(context.activity, { type: 'event', name: job.event, value, channelData, timestamp });
                await logic(context);
            });
        } catch (err) {
            if (ran) {
                throw err;
            }
            // The adapter could not continue the conversation (TestAdapter, for one, does not implement it).
            // Build the context directly, as bot.changeContext() does; this skips the adapter's middleware.
            debug('continueConversation failed, running the job without adapter middleware:', err);
            const activity = TurnContext.applyConversationReference({ type: 'event', name: job.event, value, channelData, timestamp }, copy(job.reference), true);
            await logic(new TurnContext(adapter, activity));
        }
    }

    /**
     * Race a turn against the turn timeout, using a real, unref'd timer.
     */
    private async withTimeout(turn: Promise<void>, ms: number): Promise<void> {
        if (!ms) {
            return turn;
        }
        let timer: any;
        const timeout = new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => {
                const err = new Error(`Timed out after ${ ms }ms`);
                err.name = 'TurnTimeoutError';
                reject(err);
            }, ms);
            if (timer && typeof timer.unref === 'function') {
                timer.unref();
            }
        });
        try {
            await Promise.race([turn, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Count a failed run once, keeping the first error message.
     */
    private recordError(record: RunRecord, err: any): void {
        if (!record.failed) {
            record.failed = true;
            record.job.errors += 1;
            record.job.lastError = err && err.message ? err.message : String(err);
        }
    }

    /**
     * Route a scheduled event past the dialog system, once per event name.
     * The interrupt matches only turns started by this scheduler, runs the `on()` handlers and records their errors.
     */
    private route(event: string): void {
        if (this.routes[event]) {
            return;
        }
        this.routes[event] = true;
        this.controller.interrupts(async (message: BotkitMessage) => message.botkitScheduler === true && !!runRecordOf(message), [event], async (bot, message) => {
            try {
                await this.controller.trigger(message.type, bot, message);
            } catch (err) {
                // The pattern above only matches turns that carry a run record.
                this.recordError(runRecordOf(message), err);
                try {
                    await this.controller.trigger('scheduler_error', bot, { ...message, type: 'scheduler_error', error: err });
                } catch (e) {
                    console.error('botkit-plugin-scheduler: error in a scheduler_error handler', e);
                }
            }
            // Returning anything but false ends the turn here: a dialog waiting for an answer is left as it was.
        });
    }

    /**
     * Spawn middleware: remember which adapter serves each channel, and add bot.schedule() and bot.cancelSchedule().
     */
    private extendBot(bot: BotWorker): void {
        // Botkit binds a plugin's middleware before init() runs, so a controller that init() refused would still call this.
        if (bot.controller !== this.controller) {
            return;
        }
        const adapter = bot.getConfig('adapter');
        const reference = bot.getConfig('reference');
        if (adapter && reference && reference.channelId) {
            this.learnedAdapters[reference.channelId] = adapter;
        }

        const worker = bot as any;
        worker.schedule = async (options: Partial<ScheduleOptions> & { event: string }): Promise<ScheduledJob> => {
            const opts = { ...options };
            if (opts.reference === undefined) {
                // Read the reference now: changeContext() may have moved the bot since it was spawned.
                // A bot with no reference, or one on the clock channel, schedules a clock job.
                opts.reference = bot.getConfig('reference') || null;
            }
            return this.schedule(opts);
        };
        worker.cancelSchedule = async (id: string): Promise<boolean> => this.cancel(id);
    }

    private adapterFor(channelId: string): BotAdapter {
        return this._config.adapters[channelId] || this.learnedAdapters[channelId] || this.controller.adapter;
    }

    /**
     * A job that will not run again: delete it, or keep it with nextRunAt null.
     */
    private finish(job: ScheduledJob): void {
        job.nextRunAt = null;
        if (this._config.pruneCompleted) {
            delete this.jobs[job.id];
            delete this.catchUpSlots[job.id];
        }
    }

    /**
     * Arm the timer for the earliest job that is not paused.
     */
    private arm(): void {
        this.clearTimer();
        if (!this.started || this.stopped) {
            return;
        }
        let next = Infinity;
        for (const id of Object.keys(this.jobs)) {
            const job = this.jobs[id];
            if (!job.paused && job.nextRunAt !== null) {
                next = Math.min(next, Date.parse(job.nextRunAt));
            }
        }
        if (next === Infinity) {
            return;
        }
        const { clock, unref } = this._config;
        const delay = Math.min(Math.max(next - clock.now(), 0), MAX_DELAY);
        // The callback returns the tick's promise so that a fake clock can await it; setTimeout ignores it.
        this.timer = clock.setTimeout(() => {
            this.timer = null;
            return this.tick().catch((err) => {
                console.error('botkit-plugin-scheduler: tick failed', err);
            });
        }, delay);
        if (unref && this.timer && typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            this._config.clock.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * Save every job. Writes run one at a time; mutations made while a write waits are included in it.
     */
    private persist(): Promise<void> {
        if (!this.queuedWrite) {
            const write = this.writeChain.then(() => {
                this.queuedWrite = null;
                return this.storage.write({
                    [this._config.storageKey]: { version: 1, jobs: copy(this.jobs), eTag: '*' }
                });
            });
            this.queuedWrite = write;
            this.writeChain = write.catch((err) => {
                debug('Storage write failed', err);
            });
        }
        return this.queuedWrite;
    }

    /**
     * Validate schedule() options and build a new job from them.
     */
    private build(options: ScheduleOptions, now: number): ScheduledJob {
        if (!options || typeof options !== 'object') {
            throw new Error('event is required');
        }
        checkEvent(options.event);

        const timing = ['in', 'at', 'every', 'cron'].filter((key) => options[key] !== undefined && options[key] !== null);
        if (timing.length !== 1) {
            throw new Error('Specify exactly one of in, at, every or cron');
        }

        let id = options.id;
        if (id === undefined || id === null) {
            do {
                id = 'job-' + crypto.randomBytes(4).toString('hex');
            } while (this.jobs[id]);
        } else if (typeof id !== 'string' || id === '') {
            throw new Error('id must be a non-empty string');
        }

        let maxRuns: number = null;
        if (options.maxRuns !== undefined && options.maxRuns !== null) {
            if (!Number.isInteger(options.maxRuns) || options.maxRuns < 1) {
                throw new Error('maxRuns must be a positive integer');
            }
            maxRuns = options.maxRuns;
        }

        const overlap = options.overlap === undefined || options.overlap === null ? 'skip' : options.overlap;
        if (overlap !== 'skip' && overlap !== 'allow') {
            throw new Error('overlap must be "skip" or "allow"');
        }

        if (options.timezone !== undefined && options.timezone !== null) {
            assertTimezone(options.timezone);
        }
        const startAt = options.startAt === undefined || options.startAt === null ? null : toTime(options.startAt);

        const job: ScheduledJob = {
            id,
            event: options.event,
            payload: toJson(options.payload, 'payload'),
            kind: 'at',
            at: null,
            every: null,
            cron: null,
            timezone: null,
            startAt: null,
            reference: toReference(options.reference),
            nextRunAt: null,
            lastRunAt: null,
            createdAt: toIso(now),
            runs: 0,
            maxRuns,
            paused: false,
            overlap,
            errors: 0,
            lastError: null,
            skipped: 0
        };

        if (timing[0] === 'in') {
            job.at = toIso(now + parseDuration(options.in));
            job.nextRunAt = job.at;
        } else if (timing[0] === 'at') {
            job.at = toIso(toTime(options.at));
            job.nextRunAt = job.at;
        } else if (timing[0] === 'every') {
            const every = parseDuration(options.every);
            job.kind = 'every';
            job.every = every;
            if (startAt === null) {
                job.nextRunAt = toIso(now + every);
            } else {
                job.startAt = toIso(startAt);
                job.nextRunAt = toIso(startAt >= now ? startAt : startAt + Math.ceil((now - startAt) / every) * every);
            }
        } else {
            const cron = parseCron(options.cron);
            job.kind = 'cron';
            job.cron = cron.source;
            job.timezone = options.timezone || this._config.timezone;
            job.nextRunAt = firstCronRun(cron, now, job.timezone);
        }

        return job;
    }

    /**
     * Validate a job read from storage, and fill in counters that are missing.
     */
    private restore(id: string, record: any): ScheduledJob {
        if (!record || typeof record !== 'object') {
            throw new Error('not an object');
        }
        if (record.id !== id) {
            throw new Error('its id does not match its key');
        }
        checkEvent(record.event);
        if (['at', 'every', 'cron'].indexOf(record.kind) < 0) {
            throw new Error(`unknown kind "${ record.kind }"`);
        }

        const job: ScheduledJob = {
            id,
            event: record.event,
            payload: record.payload === undefined ? null : record.payload,
            kind: record.kind,
            at: null,
            every: null,
            cron: null,
            timezone: null,
            startAt: null,
            reference: toReference(record.reference),
            nextRunAt: isoOrNull(record.nextRunAt),
            lastRunAt: isoOrNull(record.lastRunAt),
            createdAt: toIso(toTime(record.createdAt)),
            runs: count(record.runs, 'runs'),
            maxRuns: record.maxRuns === null || record.maxRuns === undefined ? null : positive(record.maxRuns, 'maxRuns'),
            paused: record.paused === true,
            overlap: record.overlap === 'allow' ? 'allow' : 'skip',
            errors: count(record.errors || 0, 'errors'),
            lastError: typeof record.lastError === 'string' ? record.lastError : null,
            skipped: count(record.skipped || 0, 'skipped')
        };

        if (job.kind === 'at') {
            job.at = toIso(toTime(record.at));
        } else if (job.kind === 'every') {
            job.every = parseDuration(record.every);
            job.startAt = isoOrNull(record.startAt);
        } else {
            job.cron = parseCron(record.cron).source;
            job.timezone = record.timezone || this._config.timezone;
            assertTimezone(job.timezone);
        }
        return job;
    }
}

/**
 * Get the bookkeeping record a scheduler stored in a turn, if any.
 */
function runRecordOf(message: BotkitMessage): RunRecord | undefined {
    return message.context && message.context.turnState ? message.context.turnState.get(RUN_KEY) : undefined;
}

function checkEvent(event: any): void {
    if (typeof event !== 'string' || event === '') {
        throw new Error('event is required');
    }
    if (RESERVED_EVENTS.indexOf(event) >= 0) {
        throw new Error(`The event "${ event }" is reserved; choose another event name`);
    }
    if (event.indexOf(',') >= 0) {
        // controller.on() splits event lists on commas, so no handler could receive this event.
        throw new Error(`The event "${ event }" cannot contain a comma`);
    }
}

/**
 * Reduce a conversation reference to the fields a job keeps, as a JSON copy.
 * A reference on the clock channel becomes null: the job is a clock job.
 */
function toReference(reference: any): Partial<ConversationReference> | null {
    if (reference === undefined || reference === null) {
        return null;
    }
    if (typeof reference !== 'object' || !reference.channelId || !reference.conversation || !reference.conversation.id || !reference.user || !reference.user.id) {
        throw new Error('reference must include channelId, conversation.id and user.id');
    }
    if (reference.channelId === 'scheduler') {
        return null;
    }
    return toJson({
        channelId: reference.channelId,
        serviceUrl: reference.serviceUrl,
        locale: reference.locale,
        conversation: reference.conversation,
        user: reference.user,
        bot: reference.bot || { id: 'bot' }
    }, 'reference');
}

/**
 * The first run of a cron job after `now`.
 */
function firstCronRun(cron: CronExpression, now: number, timezone: string): string {
    const next = nextRun(cron, now, timezone);
    if (!next) {
        throw new Error(`Invalid cron expression "${ cron.source }": it does not match any time in the next 8 years`);
    }
    return next.toISOString();
}

/**
 * Convert a Date, date string or millisecond count into milliseconds.
 */
function toTime(value: any): number {
    let ms = NaN;
    if (value instanceof Date) {
        ms = value.getTime();
    } else if (typeof value === 'number') {
        ms = value;
    } else if (typeof value === 'string' && value.trim() !== '') {
        ms = Date.parse(value);
    }
    if (!isFinite(ms) || Math.abs(ms) > MAX_TIME) {
        throw new Error(`Invalid date "${ value }"`);
    }
    return ms;
}

function toIso(ms: number): string {
    if (!isFinite(ms) || Math.abs(ms) > MAX_TIME) {
        throw new Error(`Invalid date: ${ ms } is out of range`);
    }
    return new Date(ms).toISOString();
}

function isoOrNull(value: any): string | null {
    return value === null || value === undefined ? null : toIso(toTime(value));
}

function count(value: any, name: string): number {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${ name } must be a non-negative integer`);
    }
    return value;
}

function positive(value: any, name: string): number {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${ name } must be a positive integer`);
    }
    return value;
}

/**
 * A JSON copy of a value; undefined becomes null.
 */
function toJson(value: any, name: string): any {
    if (value === undefined) {
        return null;
    }
    let text: string;
    try {
        text = JSON.stringify(value);
    } catch (err) {
        throw new Error(`${ name } must be JSON-serializable: ${ err.message }`);
    }
    if (text === undefined) {
        throw new Error(`${ name } must be JSON-serializable`);
    }
    return JSON.parse(text);
}

function copy<T>(value: T): T {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * True when two jobs have the same timing, event and reference.
 */
function sameTiming(a: ScheduledJob, b: ScheduledJob): boolean {
    return a.kind === b.kind &&
        a.at === b.at &&
        a.every === b.every &&
        a.cron === b.cron &&
        a.timezone === b.timezone &&
        a.startAt === b.startAt &&
        a.event === b.event &&
        stableStringify(a.reference) === stableStringify(b.reference);
}

/**
 * JSON with object keys sorted, for comparing references.
 */
function stableStringify(value: any): string {
    if (Array.isArray(value)) {
        return '[' + value.map(stableStringify).join(',') + ']';
    }
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}

/**
 * Sort by nextRunAt, soonest first with nulls last, then by id.
 */
function byNextRun(a: ScheduledJob, b: ScheduledJob): number {
    if (a.nextRunAt !== b.nextRunAt) {
        if (a.nextRunAt === null) {
            return 1;
        }
        if (b.nextRunAt === null) {
            return -1;
        }
        return Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt);
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
