/**
 * @module botbuilder-adapter-cli
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as Debug from 'debug';
const debug = Debug('botkit:cli');

/**
 * Race a promise against a timer. If the promise has not settled after `ms` milliseconds,
 * the returned promise rejects with an Error named `TurnTimeoutError` and the message `<what> timed out after <ms>ms`.
 * The original promise keeps running; its eventual result or rejection is ignored.
 *
 * The timer is cleared as soon as the promise settles. While it runs it keeps the process alive, so that work which never settles
 * (a lost callback) ends in a timeout error instead of a silent exit once nothing else is left to do.
 * Pass a `timers` set to track the pending timers, so their owner can `unref()` them when it no longer needs them.
 *
 * ```javascript
 * await withTimeout(adapter.runMiddleware(context, logic), 30000);
 * ```
 *
 * @param promise The work to wait for.
 * @param ms The time limit in milliseconds. 0, a negative number or Infinity disables the limit.
 * @param timers An optional set that holds the timer while it is pending.
 * @param what What is timed, for the error message. Defaults to `'Turn'`.
 * @returns A promise that settles like `promise`, or rejects when the time is up.
 * @ignore
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, timers?: Set<any>, what = 'Turn'): Promise<T> {
    if (!(ms > 0) || ms === Infinity) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            if (timers) {
                timers.delete(timer);
            }
            const err = new Error(`${ what } timed out after ${ ms }ms`);
            err.name = 'TurnTimeoutError';
            reject(err);
        }, ms);
        if (timers) {
            timers.add(timer);
        }
        const settle = (): void => {
            clearTimeout(timer);
            if (timers) {
                timers.delete(timer);
            }
        };
        promise.then((value) => {
            settle();
            resolve(value);
        }, (err) => {
            settle();
            reject(err);
        });
    });
}

/**
 * A serial work queue: items are processed strictly one at a time, in order, by a single worker loop.
 * Items can be added at the back ([push()](#push)) or the front ([unshift()](#unshift)),
 * and [idle()](#idle) resolves once nothing is queued or being processed.
 *
 * ```javascript
 * const queue = new TurnQueue(async (item) => { await handle(item); }, () => console.log('idle'));
 * queue.push('a');
 * queue.push('b');
 * await queue.idle();
 * ```
 * @ignore
 */
export class TurnQueue<T> {
    private items: T[] = [];
    private running = false;
    private waiters: (() => void)[] = [];
    private worker: (item: T) => Promise<void>;
    private onIdle: () => void;

    /**
     * Create a queue.
     * @param worker Processes one item. A rejection is logged with debug and does not stop the queue.
     * @param onIdle Called synchronously each time the queue becomes idle after processing items.
     */
    public constructor(worker: (item: T) => Promise<void>, onIdle?: () => void) {
        this.worker = worker;
        this.onIdle = onIdle;
    }

    /**
     * The number of items waiting to be processed, not counting the one in progress.
     */
    public get size(): number {
        return this.items.length;
    }

    /**
     * True while the worker is processing an item.
     */
    public get busy(): boolean {
        return this.running;
    }

    /**
     * Add an item at the back of the queue and start the worker if it is not running.
     * @param item The item to process.
     */
    public push(item: T): void {
        this.items.push(item);
        this.drain();
    }

    /**
     * Add an item at the front of the queue, so it is processed next, and start the worker if it is not running.
     * @param item The item to process.
     */
    public unshift(item: T): void {
        this.items.unshift(item);
        this.drain();
    }

    /**
     * Remove every item that has not started yet.
     * @returns The removed items, in queue order.
     */
    public clear(): T[] {
        const removed = this.items;
        this.items = [];
        return removed;
    }

    /**
     * Wait until no item is being processed and the queue is empty.
     * @returns A promise that resolves when the queue is idle; immediately if it already is.
     */
    public idle(): Promise<void> {
        if (!this.running && this.items.length === 0) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.waiters.push(resolve);
        });
    }

    /**
     * The worker loop. Only one instance runs at a time.
     */
    private async drain(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        while (this.items.length) {
            const item = this.items.shift();
            try {
                await this.worker(item);
            } catch (err) {
                debug('Error in queue worker', err);
            }
        }
        this.running = false;

        const waiters = this.waiters;
        this.waiters = [];
        waiters.forEach((resolve) => resolve());
        if (this.onIdle) {
            try {
                this.onIdle();
            } catch (err) {
                debug('Error in queue idle handler', err);
            }
        }
    }
}
