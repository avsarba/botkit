const assert = require('assert');
const { assertTimezone, nextRun, parseCron, parseDuration } = require('../');

const iso = (date) => date === null ? null : date.toISOString();
const show = (value) => typeof value === 'string' ? JSON.stringify(value) : String(value);

describe('Cron', function() {
    describe('nextRun in UTC', function() {
        const table = [
            ['*/15 * * * *', '2026-09-27T10:07:30Z', '2026-09-27T10:15:00.000Z'],
            ['0 9 * * 1-5', '2026-09-27T12:00:00Z', '2026-09-28T09:00:00.000Z'],
            ['0 9 * * MON-FRI', '2026-10-02T09:00:00Z', '2026-10-05T09:00:00.000Z'],
            ['0 0 13 * 5', '2026-09-27T00:00:00Z', '2026-10-02T00:00:00.000Z'],
            ['0 0 13 * 5', '2026-10-10T00:00:00Z', '2026-10-13T00:00:00.000Z'],
            ['0 0 29 2 *', '2026-03-01T00:00:00Z', '2028-02-29T00:00:00.000Z'],
            ['0 0 30 2 *', '2026-03-01T00:00:00Z', null],
            ['0 0 30 2 *', '1999-12-31T23:59:59Z', null],
            ['@hourly', '2026-09-27T10:00:00Z', '2026-09-27T11:00:00.000Z'],
            ['*/10 * * * * *', '2026-09-27T10:00:05Z', '2026-09-27T10:00:10.000Z'],
            ['0 0 * * 7', '2026-09-26T12:00:00Z', '2026-09-27T00:00:00.000Z'],
            ['0 0 1 JAN,JUL *', '2026-09-27T00:00:00Z', '2027-01-01T00:00:00.000Z'],
            ['0 0 31 * *', '2026-09-27T00:00:00Z', '2026-10-31T00:00:00.000Z'],
            ['5-10/5 * * * *', '2026-09-27T10:06:00Z', '2026-09-27T10:10:00.000Z'],
            ['0 0 */2 * *', '2026-09-30T12:00:00Z', '2026-10-01T00:00:00.000Z'],
            ['0 0 * * *', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00.000Z'],
            // additional cases
            ['@yearly', '2026-09-27T00:00:00Z', '2027-01-01T00:00:00.000Z'],
            ['@monthly', '2026-09-27T00:00:00Z', '2026-10-01T00:00:00.000Z'],
            ['@weekly', '2026-09-27T00:00:00Z', '2026-10-04T00:00:00.000Z'],
            ['0 0 ? * sun', '2026-09-27T00:00:00Z', '2026-10-04T00:00:00.000Z'],
            ['0 12 * * *', '2026-09-27T11:59:59.999Z', '2026-09-27T12:00:00.000Z'],
            ['0 12 * * *', '2026-09-27T12:00:00.001Z', '2026-09-28T12:00:00.000Z'],
            ['30/10 * * * *', '2026-09-27T10:55:00Z', '2026-09-27T11:30:00.000Z'],
            ['0 0 1 * 1', '2026-09-27T00:00:00Z', '2026-09-28T00:00:00.000Z'],
            ['0 0 1-7 * */2', '2026-09-27T00:00:00Z', '2026-10-01T00:00:00.000Z']
        ];

        table.forEach(([expression, from, expected]) => {
            it(`should run "${ expression }" after ${ from } at ${ expected }`, function() {
                assert.strictEqual(iso(nextRun(expression, new Date(from))), expected);
            });
        });

        it('should accept a parsed expression and a millisecond timestamp', function() {
            const cron = parseCron('*/15 * * * *');
            assert.strictEqual(iso(nextRun(cron, Date.parse('2026-09-27T10:07:30Z'))), '2026-09-27T10:15:00.000Z');
            assert.strictEqual(iso(nextRun(cron, Date.parse('2026-09-27T10:07:30Z'), 'UTC')), '2026-09-27T10:15:00.000Z');
        });

        it('should reject an invalid start time', function() {
            assert.throws(() => nextRun('* * * * *', NaN), /Invalid date/);
        });
    });

    describe('nextRun in a time zone', function() {
        const table = [
            // the spring-forward gap: 02:30 does not exist, so the job runs at 03:30 EDT
            ['30 2 * * *', '2026-03-08T06:00:00Z', 'America/New_York', '2026-03-08T07:30:00.000Z'],
            ['30 2 * * *', '2026-03-08T07:30:00Z', 'America/New_York', '2026-03-09T06:30:00.000Z'],
            ['0 * * * *', '2026-03-08T06:30:00Z', 'America/New_York', '2026-03-08T07:00:00.000Z'],
            ['0 * * * *', '2026-03-08T07:00:00Z', 'America/New_York', '2026-03-08T08:00:00.000Z'],
            // the fall-back overlap: 01:30 happens twice and runs once, at its first occurrence
            ['30 1 * * *', '2026-11-01T04:00:00Z', 'America/New_York', '2026-11-01T05:30:00.000Z'],
            ['30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York', '2026-11-02T06:30:00.000Z'],
            ['30 1 * * *', '2026-11-01T06:00:00Z', 'America/New_York', '2026-11-02T06:30:00.000Z'],
            ['*/15 * * * *', '2026-11-01T05:45:00Z', 'America/New_York', '2026-11-01T07:00:00.000Z'],
            ['0 9 * * *', '2026-09-27T12:00:00Z', 'America/New_York', '2026-09-27T13:00:00.000Z'],
            ['0 9 * * *', '2026-12-01T15:00:00Z', 'America/New_York', '2026-12-02T14:00:00.000Z'],
            ['0 0 * * *', '2026-09-27T12:00:00Z', 'Asia/Kolkata', '2026-09-27T18:30:00.000Z'],
            ['@daily', '2026-09-27T12:00:00Z', 'Asia/Kathmandu', '2026-09-27T18:15:00.000Z'],
            // additional cases
            ['0 9 * * MON', '2026-09-27T12:00:00Z', 'Europe/London', '2026-09-28T08:00:00.000Z'],
            ['0 0 1 1 *', '2026-12-31T10:00:00Z', 'Pacific/Auckland', '2026-12-31T11:00:00.000Z'],
            ['0 0 * * *', '2026-09-27T12:00:00Z', 'UTC', '2026-09-28T00:00:00.000Z']
        ];

        table.forEach(([expression, from, timezone, expected]) => {
            it(`should run "${ expression }" in ${ timezone } after ${ from } at ${ expected }`, function() {
                assert.strictEqual(iso(nextRun(expression, new Date(from), timezone)), expected);
            });
        });

        it('should run each slot of a recurring job once across a fall-back change', function() {
            const runs = [];
            let from = Date.parse('2026-11-01T04:30:00Z'); // 00:30 EDT
            for (let i = 0; i < 4; i++) {
                const next = nextRun('0,30 * * * *', from, 'America/New_York');
                runs.push(next.toISOString());
                from = next.getTime();
            }
            // 01:00 EDT, 01:30 EDT, then 02:00 EST: the repeated 01:00 and 01:30 EST are not run again.
            assert.deepStrictEqual(runs, [
                '2026-11-01T05:00:00.000Z',
                '2026-11-01T05:30:00.000Z',
                '2026-11-01T07:00:00.000Z',
                '2026-11-01T07:30:00.000Z'
            ]);
        });

        it('should reject an unknown time zone', function() {
            assert.throws(() => nextRun('* * * * *', 0, 'Mars/Olympus'), /Invalid timezone "Mars\/Olympus"/);
        });

        it('should run a time shifted by a spring-forward gap when searching from inside the shifted hour', function() {
            // 03:10 EDT: today's 02:30 runs at 03:30 EDT, which is still ahead.
            assert.strictEqual(iso(nextRun('30 2 * * *', Date.parse('2026-03-08T07:10:00Z'), 'America/New_York')), '2026-03-08T07:30:00.000Z');
            const runs = [];
            let from = Date.parse('2026-03-08T06:00:00Z'); // 01:00 EST
            for (let i = 0; i < 5; i++) {
                const next = nextRun('*/15 2 * * *', from, 'America/New_York');
                runs.push(next.toISOString());
                from = next.getTime();
            }
            // 02:00, 02:15, 02:30 and 02:45 do not exist that day: each runs once, an hour later, and then the next day.
            assert.deepStrictEqual(runs, [
                '2026-03-08T07:00:00.000Z',
                '2026-03-08T07:15:00.000Z',
                '2026-03-08T07:30:00.000Z',
                '2026-03-08T07:45:00.000Z',
                '2026-03-09T06:00:00.000Z'
            ]);
        });
    });

    describe('nextRun around daylight saving time changes in any zone', function() {
        const table = [
            // Pacific/Auckland springs forward on 2026-09-27 at 02:00 NZST (+12) to 03:00 NZDT (+13)
            ['30 2 * * *', '2026-09-25T12:00:00Z', 'Pacific/Auckland', '2026-09-25T14:30:00.000Z'],
            ['30 2 * * *', '2026-09-25T14:30:00Z', 'Pacific/Auckland', '2026-09-26T14:30:00.000Z'], // 03:30 NZDT
            ['30 2 * * *', '2026-09-26T14:30:00Z', 'Pacific/Auckland', '2026-09-27T13:30:00.000Z'],
            // ...and falls back on 2026-04-05 at 03:00 NZDT to 02:00 NZST: 02:30 runs at its first occurrence, in NZDT
            ['30 2 * * *', '2026-04-03T12:00:00Z', 'Pacific/Auckland', '2026-04-03T13:30:00.000Z'],
            ['30 2 * * *', '2026-04-03T13:30:00Z', 'Pacific/Auckland', '2026-04-04T13:30:00.000Z'],
            ['30 2 * * *', '2026-04-04T13:30:00Z', 'Pacific/Auckland', '2026-04-05T14:30:00.000Z'],
            ['0 * * * *', '2026-04-04T12:00:00Z', 'Pacific/Auckland', '2026-04-04T13:00:00.000Z'],
            ['0 * * * *', '2026-04-04T13:00:00Z', 'Pacific/Auckland', '2026-04-04T15:00:00.000Z'],
            // Pacific/Chatham (+12:45/+13:45) changes at 02:45 standard time
            ['30 2 * * *', '2026-09-25T12:00:00Z', 'Pacific/Chatham', '2026-09-25T13:45:00.000Z'],
            ['30 2 * * *', '2026-09-25T13:45:00Z', 'Pacific/Chatham', '2026-09-26T13:45:00.000Z'],
            ['0 3 * * *', '2026-04-04T00:00:00Z', 'Pacific/Chatham', '2026-04-04T13:15:00.000Z'],
            ['0 2 * * *', '2026-04-04T00:00:00Z', 'Pacific/Chatham', '2026-04-04T12:15:00.000Z']
        ];

        table.forEach(([expression, from, timezone, expected]) => {
            it(`should run "${ expression }" in ${ timezone } after ${ from } at ${ expected }`, function() {
                assert.strictEqual(iso(nextRun(expression, new Date(from), timezone)), expected);
            });
        });

        /**
         * The documented instant for a wall-clock time, found by brute force: the first instant that shows it,
         * or, for a time skipped by a spring-forward gap, the time shifted by the change.
         */
        function expectedRuns(timezone, from, until) {
            const format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
            const wall = (ms) => {
                const f = {};
                format.formatToParts(ms).forEach((part) => { f[part.type] = parseInt(part.value, 10); });
                return Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute);
            };
            const first = new Map();
            const step = 15 * 60000; // every UTC offset in use is a multiple of 15 minutes
            for (let ms = from - 15 * 3600000; ms <= until + 15 * 3600000; ms += step) {
                const naive = wall(ms);
                if (!first.has(naive)) {
                    first.set(naive, ms);
                }
            }
            const offsetBefore = wall(from - 15 * 3600000) - (from - 15 * 3600000);
            return (naive) => first.has(naive) ? first.get(naive) : naive - offsetBefore;
        }

        [
            ['America/New_York', [2026, 2, 8]], ['America/New_York', [2026, 10, 1]],
            ['Europe/London', [2026, 2, 29]], ['Europe/London', [2026, 9, 25]],
            ['Australia/Sydney', [2026, 3, 5]], ['Australia/Sydney', [2026, 9, 4]],
            ['Australia/Lord_Howe', [2026, 3, 5]], ['Australia/Lord_Howe', [2026, 9, 4]],
            ['Pacific/Auckland', [2026, 3, 5]], ['Pacific/Auckland', [2026, 8, 27]],
            ['Pacific/Chatham', [2026, 3, 5]], ['Pacific/Chatham', [2026, 8, 27]],
            ['America/Santiago', [2026, 3, 5]], ['America/Santiago', [2026, 8, 6]],
            ['America/Havana', [2026, 2, 8]], ['America/Havana', [2026, 10, 1]]
        ].forEach(([timezone, [year, month, day]]) => {
            it(`should run every quarter hour of the days around ${ year }-${ month + 1 }-${ day } in ${ timezone } once, at the documented time`, function() {
                const start = Date.UTC(year, month, day - 1);
                const end = Date.UTC(year, month, day + 1);
                const expected = expectedRuns(timezone, start, end);
                const wrong = [];
                for (let naive = start; naive < end; naive += 15 * 60000) {
                    const date = new Date(naive);
                    const expression = `${ date.getUTCMinutes() } ${ date.getUTCHours() } ${ date.getUTCDate() } ${ date.getUTCMonth() + 1 } *`;
                    const want = expected(naive);
                    // from well before the run, and from just before it
                    [want - 12 * 3600000, want - 1000].forEach((from) => {
                        const got = nextRun(expression, from, timezone);
                        if (!got || got.getTime() !== want) {
                            wrong.push(`${ expression } from ${ iso(new Date(from)) }: ${ iso(got) } instead of ${ iso(new Date(want)) }`);
                        }
                    });
                }
                assert.deepStrictEqual(wrong, []);
            });
        });
    });

    describe('parseCron', function() {
        it('should parse fields, names and flags', function() {
            const cron = parseCron(' 0 9 * jan,Jul MON-fri ');
            assert.strictEqual(cron.source, '0 9 * jan,Jul MON-fri');
            assert.strictEqual(cron.hasSeconds, false);
            assert.deepStrictEqual(cron.seconds, [0]);
            assert.deepStrictEqual(cron.minutes, [0]);
            assert.deepStrictEqual(cron.hours, [9]);
            assert.strictEqual(cron.daysOfMonth.length, 31);
            assert.deepStrictEqual(cron.months, [1, 7]);
            assert.deepStrictEqual(cron.daysOfWeek, [1, 2, 3, 4, 5]);
            assert.strictEqual(cron.domRestricted, false);
            assert.strictEqual(cron.dowRestricted, true);
        });

        it('should read a leading seconds field', function() {
            const cron = parseCron('*/20 0 0 1 1 *');
            assert.strictEqual(cron.hasSeconds, true);
            assert.deepStrictEqual(cron.seconds, [0, 20, 40]);
        });

        it('should treat 7 as Sunday and remove duplicates', function() {
            assert.deepStrictEqual(parseCron('0 0 * * 0,7,SUN').daysOfWeek, [0]);
            assert.deepStrictEqual(parseCron('0 0 * * 5-7').daysOfWeek, [0, 5, 6]);
        });

        it('should treat */n and ? as unrestricted days', function() {
            const cron = parseCron('0 0 */2 * ?');
            assert.strictEqual(cron.domRestricted, false);
            assert.strictEqual(cron.dowRestricted, false);
            assert.deepStrictEqual(cron.daysOfMonth.slice(0, 3), [1, 3, 5]);
        });

        it('should expand macros', function() {
            assert.deepStrictEqual(parseCron('@Hourly').minutes, [0]);
            assert.strictEqual(parseCron('@midnight').hours[0], 0);
            assert.strictEqual(parseCron('@annually').months[0], 1);
        });

        ['x * * * *', '60 * * * *', '* * * *', '0 0 0 * *', '*/0 * * * *', '0 0 * 13 *', '0 0 * * 8',
            '* * * * * * *', '5-1 * * * *', '1-2-3 * * * *', '1,,2 * * * *', '1/2/3 * * * *', '? * * * *', '@often', ''].forEach((expression) => {
            it(`should reject "${ expression }"`, function() {
                assert.throws(() => parseCron(expression), /Invalid cron expression/);
            });
        });

        it('should reject a value that is not a string', function() {
            assert.throws(() => parseCron(42), /Invalid cron expression "42": expected a string/);
        });

        it('should name the problem', function() {
            assert.throws(() => parseCron('0 25 * * *'), /^Error: Invalid cron expression "0 25 \* \* \*": hour 25 is out of range \(0-23\)$/);
        });
    });

    describe('assertTimezone', function() {
        it('should accept known zones', function() {
            assertTimezone('UTC');
            assertTimezone('America/New_York');
            assertTimezone('Asia/Kathmandu');
        });

        it('should reject unknown zones', function() {
            assert.throws(() => assertTimezone('Mars/Olympus'), /Invalid timezone/);
            assert.throws(() => assertTimezone(''), /Invalid timezone/);
            assert.throws(() => assertTimezone(undefined), /Invalid timezone/);
        });
    });

    describe('parseDuration', function() {
        const table = [
            ['500ms', 500],
            ['30s', 30000],
            ['5m', 300000],
            ['1h30m', 5400000],
            ['2d', 172800000],
            ['1w', 604800000],
            [1500, 1500],
            ['10', 10],
            ['1m500ms', 60500],
            [' 2h ', 7200000]
        ];

        table.forEach(([input, expected]) => {
            it(`should read ${ show(input) } as ${ expected }ms`, function() {
                assert.strictEqual(parseDuration(input), expected);
            });
        });

        it('should accept the longest duration a date can hold', function() {
            assert.strictEqual(parseDuration(8.64e15), 8.64e15);
            assert.strictEqual(parseDuration('8640000000000000'), 8.64e15);
        });

        ['5x', '', '-1s', 0, -5, 'm', '0s', '1h 30m', '1.5h', NaN, Infinity, null, undefined,
            // fractions of a millisecond, which ISO times cannot hold
            0.5, 0.001, 1500.5,
            // longer than any date can be
            8.64e15 + 1, 1e300, '9999999999999999999w', '10000000000000000'].forEach((input) => {
            it(`should reject ${ show(input) }`, function() {
                assert.throws(() => parseDuration(input), /Invalid duration/);
            });
        });
    });
});
