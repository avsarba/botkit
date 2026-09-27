/**
 * @module botkit-plugin-scheduler
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

const UNITS: { [unit: string]: number } = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
};

// 'ms' must come before 'm' so that '500ms' is not read as '500m' followed by a stray 's'.
const DURATION = /^(?:\d+(?:ms|s|m|h|d|w))+$/;
const GROUP = /(\d+)(ms|s|m|h|d|w)/g;

/**
 * Convert a duration into milliseconds.
 *
 * A finite number greater than 0 is read as milliseconds, and so is a string of digits.
 * Any other string must be one or more `<integer><unit>` groups with no spaces between them,
 * where the unit is `ms`, `s`, `m`, `h`, `d` or `w`.
 *
 * ```javascript
 * const { parseDuration } = require('botkit-plugin-scheduler');
 *
 * parseDuration('1h30m'); // 5400000
 * parseDuration('500ms'); // 500
 * parseDuration(1500);    // 1500
 * parseDuration('10');    // 10
 * ```
 *
 * @param value A number of milliseconds, or a duration string such as `'30s'`, `'5m'` or `'1h30m'`.
 * @returns The duration in milliseconds, always greater than 0.
 * @throws Error('Invalid duration "<value>"') when the value cannot be read or is not greater than 0.
 */
export function parseDuration(value: number | string): number {
    let ms = NaN;
    if (typeof value === 'number') {
        ms = value;
    } else if (typeof value === 'string') {
        const text = value.trim();
        if (/^\d+$/.test(text)) {
            ms = parseInt(text, 10);
        } else if (DURATION.test(text)) {
            ms = 0;
            let match: RegExpExecArray;
            GROUP.lastIndex = 0;
            while ((match = GROUP.exec(text)) !== null) {
                ms += parseInt(match[1], 10) * UNITS[match[2]];
            }
        }
    }

    if (!isFinite(ms) || ms <= 0) {
        throw new Error(`Invalid duration "${ value }"`);
    }
    return ms;
}
