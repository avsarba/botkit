/**
 * @module botkit-plugin-scheduler
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * A parsed cron expression, as returned by [parseCron()](#parseCron).
 * Every list is sorted and holds each allowed value once.
 */
export interface CronExpression {
    /**
     * The expression as it was passed to `parseCron()`, trimmed.
     */
    source: string;
    /**
     * True when the expression has 6 fields, the first one being seconds.
     */
    hasSeconds: boolean;
    /**
     * Allowed seconds (0-59). `[0]` for a 5-field expression.
     */
    seconds: number[];
    /**
     * Allowed minutes (0-59).
     */
    minutes: number[];
    /**
     * Allowed hours (0-23).
     */
    hours: number[];
    /**
     * Allowed days of the month (1-31).
     */
    daysOfMonth: number[];
    /**
     * Allowed months (1-12).
     */
    months: number[];
    /**
     * Allowed days of the week (0-6, where 0 is Sunday). A `7` in the expression is stored as `0`.
     */
    daysOfWeek: number[];
    /**
     * False when the day-of-month field starts with `*` or `?`.
     */
    domRestricted: boolean;
    /**
     * False when the day-of-week field starts with `*` or `?`.
     */
    dowRestricted: boolean;
}

interface FieldSpec {
    name: string;
    min: number;
    max: number;
    names?: string[];
    namesStart?: number;
    question?: boolean;
}

const MACROS: { [macro: string]: string } = {
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
    '@monthly': '0 0 1 * *',
    '@weekly': '0 0 * * 0',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@hourly': '0 * * * *'
};

const SECOND: FieldSpec = { name: 'second', min: 0, max: 59 };
const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 };
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { name: 'day-of-month', min: 1, max: 31, question: true };
const MONTH: FieldSpec = {
    name: 'month',
    min: 1,
    max: 12,
    names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
    namesStart: 1
};
const DAY_OF_WEEK: FieldSpec = {
    name: 'day-of-week',
    min: 0,
    max: 7,
    names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
    namesStart: 0,
    question: true
};

/** How far nextRun() searches before giving up: 8 years, counting leap days. */
const SEARCH_LIMIT = (8 * 365 + 2) * 24 * 60 * 60 * 1000;
/** Every UTC offset in use is less than a day, and a zone's offset changes months apart. */
const DAY = 24 * 60 * 60 * 1000;

/**
 * A cron expression as lookup tables, indexed by field value.
 */
interface Matcher {
    seconds: boolean[];
    minutes: boolean[];
    hours: boolean[];
    daysOfMonth: boolean[];
    months: boolean[];
    daysOfWeek: boolean[];
    either: boolean;
    unit: number;
}

const formatters: { [timezone: string]: any } = {};

/**
 * Parse a cron expression.
 *
 * Supported syntax:
 * * 5 fields (`minute hour day-of-month month day-of-week`) or 6 fields (a leading `second` field).
 * * The macros `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight` and `@hourly`.
 * * In each field: `*`, a value `a`, a range `a-b`, the steps `a-b/n` and `a/n` (from `a` to the end of the range),
 *   `*` followed by `/n` (every n), and comma-separated lists of these.
 * * `?` in the day-of-month and day-of-week fields, meaning the same as `*`.
 * * Month names `JAN`-`DEC` and day names `SUN`-`SAT`, in any case. In the day-of-week field, both 0 and 7 mean Sunday.
 *
 * Day-of-month and day-of-week follow Vixie cron: when both fields are restricted (their text does not start with `*` or `?`),
 * a day matches if EITHER field matches. Otherwise a day must match both. So `0 0 13 * 5` runs on the 13th of every month and on every Friday.
 *
 * ```javascript
 * const { parseCron } = require('botkit-plugin-scheduler');
 *
 * const cron = parseCron('0 9 * * MON-FRI');
 * console.log(cron.daysOfWeek); // [1, 2, 3, 4, 5]
 * ```
 *
 * @param expression A cron expression such as `'0 9 * * MON-FRI'`, `'0 0 1 JAN,JUL *'` or `'@daily'`.
 * @returns The parsed expression.
 * @throws Error('Invalid cron expression "<expression>": <reason>') when the expression cannot be parsed.
 */
export function parseCron(expression: string): CronExpression {
    if (typeof expression !== 'string') {
        throw new Error(`Invalid cron expression "${ expression }": expected a string`);
    }
    const source = expression.trim();
    const fail = (reason: string): Error => new Error(`Invalid cron expression "${ source }": ${ reason }`);

    let text = source;
    if (text.charAt(0) === '@') {
        text = MACROS[text.toLowerCase()];
        if (!text) {
            throw fail('unknown macro');
        }
    }

    const fields = text.split(/\s+/).filter((field) => field !== '');
    if (fields.length !== 5 && fields.length !== 6) {
        throw fail(`expected 5 or 6 fields but found ${ fields.length }`);
    }
    const hasSeconds = fields.length === 6;
    const [second, minute, hour, dom, month, dow] = hasSeconds ? fields : ['0', ...fields];

    const daysOfWeek = parseField(dow, DAY_OF_WEEK, fail).map((day) => day === 7 ? 0 : day);

    return {
        source,
        hasSeconds,
        seconds: parseField(second, SECOND, fail),
        minutes: parseField(minute, MINUTE, fail),
        hours: parseField(hour, HOUR, fail),
        daysOfMonth: parseField(dom, DAY_OF_MONTH, fail),
        months: parseField(month, MONTH, fail),
        daysOfWeek: unique(daysOfWeek),
        domRestricted: !isWildcard(dom),
        dowRestricted: !isWildcard(dow)
    };
}

/**
 * Find the next time a cron expression fires, strictly after a given instant.
 *
 * The expression is evaluated against the wall clock of `timezone`. Around daylight saving time changes:
 * * A time that does not exist because clocks spring forward runs once, at the same offset after the change. For example `30 2 * * *` in `America/New_York` runs at 03:30 EDT on the day clocks go from 02:00 to 03:00.
 * * A time that happens twice because clocks fall back runs once, at its first occurrence.
 *
 * ```javascript
 * const { nextRun } = require('botkit-plugin-scheduler');
 *
 * // 9am New York time on weekdays
 * const next = nextRun('0 9 * * 1-5', new Date('2026-09-27T12:00:00Z'), 'America/New_York');
 * console.log(next.toISOString()); // 2026-09-28T13:00:00.000Z
 * ```
 *
 * @param expression A cron expression string, or the result of [parseCron()](#parseCron).
 * @param from The instant to search from. The result is always later than this.
 * @param timezone An IANA time zone name such as `America/New_York`. Defaults to `UTC`.
 * @returns The next matching instant, or null if nothing matches within 8 years (for example `0 0 30 2 *`).
 */
export function nextRun(expression: string | CronExpression, from: Date | number, timezone = 'UTC'): Date | null {
    const cron = typeof expression === 'string' ? parseCron(expression) : expression;
    assertTimezone(timezone);
    const fromMs = from instanceof Date ? from.getTime() : from;
    if (typeof fromMs !== 'number' || !isFinite(fromMs)) {
        throw new Error(`Invalid date "${ from }"`);
    }

    const matcher: Matcher = {
        seconds: lookup(cron.seconds, 59),
        minutes: lookup(cron.minutes, 59),
        hours: lookup(cron.hours, 23),
        daysOfMonth: lookup(cron.daysOfMonth, 31),
        months: lookup(cron.months, 12),
        daysOfWeek: lookup(cron.daysOfWeek, 6),
        either: cron.domRestricted && cron.dowRestricted,
        unit: cron.hasSeconds ? 1000 : 60000
    };

    const wall = wallClock(fromMs, timezone);
    let next = search(matcher, wall, wall + SEARCH_LIMIT, fromMs, timezone);

    // Just after clocks spring forward, times the change skipped can still be ahead, because they run shifted by the change:
    // when 02:00 becomes 03:00, 02:30 runs at 03:30, so a search from 03:10 must still find it.
    // Those times are the wall-clock times between `from` read with the offset of before the change, and `from` itself.
    const before = wallBeforeChange(fromMs, wall, timezone);
    if (before !== null) {
        const skipped = search(matcher, before, wall, fromMs, timezone);
        if (skipped !== null && (next === null || skipped < next)) {
            next = skipped;
        }
    }
    return next === null ? null : new Date(next);
}

/**
 * Walk a "naive" wall-clock time (the wall clock of the zone, stored as if it were UTC) forward field by field,
 * from the unit after `after` up to `until`, and return the first match whose instant is later than `fromMs`, or null.
 */
function search(matcher: Matcher, after: number, until: number, fromMs: number, timezone: string): number | null {
    const { seconds, minutes, hours, daysOfMonth, months, daysOfWeek, either, unit } = matcher;
    let t = Math.floor(after / unit) * unit + unit;

    while (t <= until) {
        const date = new Date(t);
        const year = date.getUTCFullYear();
        const month = date.getUTCMonth();
        const day = date.getUTCDate();
        const hour = date.getUTCHours();
        const minute = date.getUTCMinutes();

        if (!months[month + 1]) {
            t = Date.UTC(year, month + 1, 1);
            continue;
        }

        const domMatch = daysOfMonth[day];
        const dowMatch = daysOfWeek[date.getUTCDay()];
        if (either ? !(domMatch || dowMatch) : !(domMatch && dowMatch)) {
            t = Date.UTC(year, month, day + 1);
            continue;
        }

        if (!hours[hour]) {
            t = Date.UTC(year, month, day, hour + 1);
            continue;
        }

        if (!minutes[minute]) {
            t = Date.UTC(year, month, day, hour, minute + 1);
            continue;
        }

        if (!seconds[date.getUTCSeconds()]) {
            t += 1000;
            continue;
        }

        const instant = instantFor(t, timezone);
        if (instant > fromMs) {
            return instant;
        }

        // The wall time maps to an instant that is not after `from`: the second pass through a repeated hour,
        // or a spring-forward gap that resolved to a slot that already ran. Keep looking.
        t += unit;
    }

    return null;
}

/**
 * Check that a time zone name is one this runtime knows.
 *
 * ```javascript
 * const { assertTimezone } = require('botkit-plugin-scheduler');
 *
 * assertTimezone('Europe/Paris'); // ok
 * assertTimezone('Mars/Olympus'); // throws Error('Invalid timezone "Mars/Olympus"')
 * ```
 *
 * @param timezone An IANA time zone name such as `America/New_York`, or `UTC`.
 * @throws Error('Invalid timezone "<timezone>"') when the runtime does not recognize the name.
 */
export function assertTimezone(timezone: string): void {
    formatter(timezone);
}

/**
 * Get (and cache) the Intl formatter used to read wall-clock fields in a time zone.
 */
function formatter(timezone: string): any {
    if (typeof timezone !== 'string' || timezone === '') {
        throw new Error(`Invalid timezone "${ timezone }"`);
    }
    if (!formatters[timezone]) {
        try {
            formatters[timezone] = new (Intl as any).DateTimeFormat('en-US', {
                timeZone: timezone,
                hourCycle: 'h23',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric'
            });
        } catch (err) {
            if (err instanceof RangeError) {
                throw new Error(`Invalid timezone "${ timezone }"`);
            }
            throw err;
        }
    }
    return formatters[timezone];
}

/**
 * The wall-clock time of an instant in a time zone, as the milliseconds of Date.UTC(those fields). Milliseconds are dropped.
 */
function wallClock(ms: number, timezone: string): number {
    if (timezone === 'UTC') {
        return Math.floor(ms / 1000) * 1000;
    }
    const fields: { [type: string]: number } = {};
    for (const part of formatter(timezone).formatToParts(ms)) {
        fields[part.type] = parseInt(part.value, 10);
    }
    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour % 24, fields.minute, fields.second);
}

/**
 * The UTC offset of a time zone at an instant, in milliseconds.
 */
function offset(ms: number, timezone: string): number {
    return wallClock(ms, timezone) - Math.floor(ms / 1000) * 1000;
}

/**
 * If clocks sprang forward less than the length of that change before `ms`, the wall-clock time at `ms` read with the offset
 * of before the change; otherwise null. `wall` is the wall-clock time at `ms`.
 */
function wallBeforeChange(ms: number, wall: number, timezone: string): number | null {
    if (timezone === 'UTC') {
        return null;
    }
    const current = wall - Math.floor(ms / 1000) * 1000;
    const earlier = offset(ms - DAY, timezone);
    if (earlier >= current) {
        return null;
    }
    const change = current - earlier;
    if (offset(ms - change, timezone) !== earlier) {
        return null;
    }
    return wall - change;
}

/**
 * Convert a naive wall-clock time into an instant.
 * During a fall-back overlap this is the first occurrence; inside a spring-forward gap it is the time shifted by the gap.
 */
function instantFor(naive: number, timezone: string): number {
    if (timezone === 'UTC') {
        return naive;
    }
    // The instants that show `naive` are within a day of it, so the offsets a day before and a day after
    // are the ones on each side of any change near it, whatever the zone's offset (up to +14:00 or down to -12:00).
    const before = naive - offset(naive - DAY, timezone);
    const after = naive - offset(naive + DAY, timezone);
    const candidates = before === after ? [before] : [Math.min(before, after), Math.max(before, after)];
    for (const candidate of candidates) {
        if (wallClock(candidate, timezone) === naive) {
            return candidate;
        }
    }
    return before;
}

function parseField(text: string, spec: FieldSpec, fail: (reason: string) => Error): number[] {
    const values: number[] = [];

    const readValue = (token: string): number => {
        let value: number;
        const nameIndex = spec.names ? spec.names.indexOf(token.toUpperCase()) : -1;
        if (nameIndex >= 0) {
            value = nameIndex + spec.namesStart;
        } else if (/^\d+$/.test(token)) {
            value = parseInt(token, 10);
        } else {
            throw fail(`"${ token }" is not a valid ${ spec.name }`);
        }
        if (value < spec.min || value > spec.max) {
            throw fail(`${ spec.name } ${ value } is out of range (${ spec.min }-${ spec.max })`);
        }
        return value;
    };

    for (const part of text.split(',')) {
        const pieces = part.split('/');
        if (part === '' || pieces.length > 2) {
            throw fail(`"${ text }" is not a valid ${ spec.name } field`);
        }
        const range = pieces[0];

        let step = 1;
        if (pieces.length === 2) {
            if (!/^\d+$/.test(pieces[1]) || parseInt(pieces[1], 10) < 1) {
                throw fail(`the step in "${ part }" must be a positive integer`);
            }
            step = parseInt(pieces[1], 10);
        }

        let start: number;
        let end: number;
        if (range === '*' || (range === '?' && spec.question)) {
            start = spec.min;
            end = spec.max;
        } else if (range.indexOf('-') >= 0) {
            const bounds = range.split('-');
            if (bounds.length !== 2) {
                throw fail(`"${ part }" is not a valid ${ spec.name } range`);
            }
            start = readValue(bounds[0]);
            end = readValue(bounds[1]);
            if (start > end) {
                throw fail(`the ${ spec.name } range "${ range }" runs backwards`);
            }
        } else {
            start = readValue(range);
            end = pieces.length === 2 ? spec.max : start;
        }

        for (let value = start; value <= end; value += step) {
            values.push(value);
        }
    }

    return unique(values);
}

function isWildcard(field: string): boolean {
    return field.charAt(0) === '*' || field.charAt(0) === '?';
}

function unique(values: number[]): number[] {
    return values.filter((value, index) => values.indexOf(value) === index).sort((a, b) => a - b);
}

function lookup(values: number[], max: number): boolean[] {
    const table: boolean[] = [];
    for (let value = 0; value <= max; value++) {
        table.push(false);
    }
    values.forEach((value) => { table[value] = true; });
    return table;
}
