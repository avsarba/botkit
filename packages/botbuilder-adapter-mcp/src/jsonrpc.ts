/**
 * @module botbuilder-adapter-mcp
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import * as Debug from 'debug';
import * as readline from 'readline';
import { JSONRPC_ERRORS } from './protocol';
import { isPlainObject } from './util';
const debug = Debug('botkit:mcp');

/**
 * True for a JSON-RPC response object (it has an id and a result or error, and no method).
 */
function isResponse(message: any): boolean {
    return isPlainObject(message) && message.method === undefined && Object.prototype.hasOwnProperty.call(message, 'id') &&
        (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
}

/**
 * The error message of any thrown value.
 */
function errorMessage(err: any): string {
    return err && err.message ? err.message : String(err);
}

/**
 * A newline-delimited JSON-RPC 2.0 connection over a pair of streams, as used by the MCP stdio transport.
 *
 * * Each line of `input` is one JSON message. A trailing carriage return is removed and blank lines are skipped.
 * * A line that is not valid JSON is answered with the error `-32700 Parse error`.
 * * Every other message is passed to `handler` without waiting for earlier ones, so requests run concurrently.
 *   A result that is not null is written to `output` as one line of JSON. Nothing else is ever written to `output`.
 * * When `input` ends, the connection waits for every message in `pending` to be handled, then closes and calls the [onClose()](#onClose) listeners.
 * * An error on `output` (for example EPIPE because the client went away) or on `input` is treated like the end of `input`.
 *
 * ```javascript
 * const { JsonRpcConnection } = require('botbuilder-adapter-mcp');
 * const connection = new JsonRpcConnection(process.stdin, process.stdout, async (message) => {
 *     if (message.method === 'ping') {
 *         return { jsonrpc: '2.0', id: message.id, result: {} };
 *     }
 *     return null;
 * });
 * connection.onClose(() => console.error('The client went away.'));
 * connection.start();
 * ```
 */
export class JsonRpcConnection {
    /**
     * The messages that are being handled, as promises that settle when each one is done. They never reject.
     */
    public readonly pending = new Set<Promise<any>>();

    private input: NodeJS.ReadableStream;
    private output: NodeJS.WritableStream;
    private handler: (message: any) => Promise<any | null>;
    private reader: readline.Interface = null;
    private started = false;
    private closing = false;
    private closed = false;
    private outputBroken = false;
    private inputFailed = false;
    private closeListeners: (() => void)[] = [];

    /**
     * Create a connection. Call [start()](#start) to begin reading.
     * @param input The stream to read messages from, such as `process.stdin`.
     * @param output The stream to write responses and notifications to, such as `process.stdout`.
     * @param handler Handles one parsed message (an object, or an array for a batch) and resolves with the response to write, or null to write nothing.
     */
    public constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, handler: (message: any) => Promise<any | null>) {
        this.input = input;
        this.output = output;
        this.handler = handler;
    }

    /**
     * Start reading messages from the input stream. Calling it again does nothing.
     */
    public start(): void {
        if (this.started || this.closed) {
            return;
        }
        this.started = true;
        // These listeners stay attached after close(): an error from a write that was still in flight must not become an uncaught exception.
        this.output.on('error', (err: any) => this.onOutputError(err));
        this.input.on('error', (err: any) => this.onInputError(err));
        this.reader = readline.createInterface({ input: this.input, crlfDelay: Infinity });
        // newer versions of Node re-emit input errors on the readline interface
        this.reader.on('error', (err: any) => this.onInputError(err));
        this.reader.on('line', (line: string) => this.receive(line));
        this.reader.on('close', () => {
            this.onInputEnd().catch((err) => debug('Error while closing the connection', err));
        });
    }

    /**
     * Stop reading and writing now. Responses to requests that are still running are dropped, and the [onClose()](#onClose) listeners are not called.
     * Calling it again does nothing.
     */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        if (this.reader) {
            this.reader.close();
        }
    }

    /**
     * Write one message to the output stream as a line of JSON. Messages sent after [close()](#close) are dropped.
     * A response that cannot be serialized is replaced by a `-32603 Internal error` response with the same id; any other such message is dropped.
     * @param message A JSON-RPC response, notification, or an array of responses.
     */
    public send(message: any): void {
        if (this.closed || this.outputBroken) {
            debug('Connection closed, dropping message', message && message.method ? message.method : message && message.id);
            return;
        }
        const line = Array.isArray(message) ? this.serializeBatch(message) : this.serialize(message);
        if (line !== null) {
            this.output.write(line + '\n');
        }
    }

    /**
     * Register a function to call once the input stream has ended and every pending message has been handled.
     * It is not called when the connection is closed with [close()](#close).
     * @param fn The function to call.
     */
    public onClose(fn: () => void): void {
        this.closeListeners.push(fn);
    }

    /**
     * Handle one line of input.
     */
    private receive(line: string): void {
        if (this.closed) {
            return;
        }
        const text = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (!text.trim()) {
            return;
        }

        let message: any;
        try {
            message = JSON.parse(text);
        } catch (err) {
            debug('Could not parse message', err.message);
            this.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_ERRORS.PARSE_ERROR, message: 'Parse error' } });
            return;
        }

        const task: Promise<void> = Promise.resolve()
            .then(() => this.handler(message))
            .then((response) => {
                if (response !== null && response !== undefined) {
                    this.send(response);
                }
            }, (err) => {
                debug('Error in message handler', err);
                if (isPlainObject(message) && typeof message.method === 'string' && Object.prototype.hasOwnProperty.call(message, 'id')) {
                    this.send({ jsonrpc: '2.0', id: message.id, error: { code: JSONRPC_ERRORS.INTERNAL_ERROR, message: 'Internal error: ' + errorMessage(err) } });
                }
            });
        this.pending.add(task);
        task.then(() => this.pending.delete(task));
    }

    /**
     * The input ended: finish the pending messages, then close and tell the listeners.
     */
    private async onInputEnd(): Promise<void> {
        if (this.closing || this.closed) {
            return;
        }
        this.closing = true;
        debug('Input ended, waiting for %d pending message(s)', this.pending.size);
        while (this.pending.size && !this.closed) {
            await Promise.all(Array.from(this.pending));
        }
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.closeListeners.forEach((fn) => {
            try {
                fn();
            } catch (err) {
                debug('Error in close listener', err);
            }
        });
    }

    /**
     * The output stream failed, usually because the client went away. Stop writing and end the input side too.
     */
    private onOutputError(err: any): void {
        debug('Output stream error', err);
        if (this.outputBroken) {
            return;
        }
        this.outputBroken = true;
        if (this.reader && !this.closed) {
            this.reader.close();
        }
    }

    /**
     * The input stream failed. Readline does not close on errors, so treat it like the end of the input.
     */
    private onInputError(err: any): void {
        if (this.inputFailed) {
            return;
        }
        this.inputFailed = true;
        debug('Input stream error', err);
        if (this.reader && !this.closed) {
            this.reader.close();
        }
    }

    /**
     * Serialize one message. Returns null when it cannot be sent at all.
     */
    private serialize(message: any): string | null {
        try {
            return JSON.stringify(message);
        } catch (err) {
            debug('Could not serialize message', err);
            if (isResponse(message)) {
                return JSON.stringify({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: JSONRPC_ERRORS.INTERNAL_ERROR, message: 'Internal error: the response could not be serialized as JSON: ' + errorMessage(err) }
                });
            }
            return null;
        }
    }

    /**
     * Serialize a batch of responses one by one, so one bad response does not lose the others.
     */
    private serializeBatch(messages: any[]): string | null {
        const lines = messages.map((message) => this.serialize(message)).filter((line) => line !== null);
        return lines.length ? '[' + lines.join(',') + ']' : null;
    }
}
