# Botkit Scheduler Plugin Class Reference

[&larr; Botkit Documentation](../core.md) [&larr; Class Index](index.md) 

This is a class reference for all the methods exposed by the [botkit-plugin-scheduler](https://github.com/howdyai/botkit/tree/master/packages/botkit-plugin-scheduler) package.

## Classes


* <a href="#BotkitScheduler" aria-current="page">BotkitScheduler</a>
* <a href="#ClockAdapter" aria-current="page">ClockAdapter</a>

## Interfaces

* <a href="#BotkitSchedulerOptions" aria-current="page">BotkitSchedulerOptions</a>
* <a href="#CronExpression" aria-current="page">CronExpression</a>
* <a href="#ScheduleOptions" aria-current="page">ScheduleOptions</a>
* <a href="#ScheduledJob" aria-current="page">ScheduledJob</a>
* <a href="#SchedulerClock" aria-current="page">SchedulerClock</a>

## Functions

* <a href="#assertTimezone" aria-current="page">assertTimezone()</a>
* <a href="#nextRun" aria-current="page">nextRun()</a>
* <a href="#parseCron" aria-current="page">parseCron()</a>
* <a href="#parseDuration" aria-current="page">parseDuration()</a>

---

<a name="BotkitScheduler"></a>
## BotkitScheduler
Give Botkit a clock: run cron, interval and one-shot jobs that survive restarts.

A job that comes due becomes an ordinary Botkit turn with the job's event as `message.type`, handled with `controller.on(event, handler)`.
* A job without a conversation reference (a "clock job") runs on the scheduler's own `scheduler` channel. Messages the bot sends there go to the `output` option.
* A job with a reference runs inside that conversation, on the adapter that owns it, so `bot.say()` reaches the user.
  Scheduled turns are handled before the dialog system, so a job fires even while a dialog is waiting for an answer, and the
  dialog still receives the user's next message.

Jobs are kept in Botkit storage and reloaded at startup, where the `catchUp` option decides what happens to runs that were missed.
The scheduler is built for a single process: if several processes share the storage, each one runs every job.

```javascript
const { BotkitScheduler } = require('botkit-plugin-scheduler');

const scheduler = new BotkitScheduler({ timezone: 'America/New_York' });
controller.usePlugin(scheduler);

// a nightly job, declared at every boot without creating duplicates
controller.ready(async () => {
    await controller.plugins.scheduler.cron('nightly-report', '0 2 * * *', { event: 'nightly_report' });
});
controller.on('nightly_report', async (bot, message) => {
    // runs at 2am New York time
});

// a reminder in the user's own conversation
controller.hears('remind me', 'message', async (bot, message) => {
    await bot.schedule({ in: '10m', event: 'reminder', payload: { text: 'Stretch!' } });
    await bot.reply(message, 'OK, in 10 minutes.');
});
controller.on('reminder', async (bot, message) => {
    await bot.say(message.value.text);
});
```

To use this class in your application, first install the package:
```bash
npm install --save botkit-plugin-scheduler
```

Then import this and other classes into your code:
```javascript
const { BotkitScheduler } = require('botkit-plugin-scheduler');
```

This class includes the following methods:
* [at()](#at)
* [cancel()](#cancel)
* [cron()](#cron)
* [every()](#every)
* [get()](#get)
* [getConfig()](#getConfig)
* [init()](#init)
* [list()](#list)
* [pause()](#pause)
* [resume()](#resume)
* [runNow()](#runNow)
* [schedule()](#schedule)
* [start()](#start)
* [stop()](#stop)
* [tick()](#tick)
* [useAdapter()](#useAdapter)



### Create a new BotkitScheduler()
**Parameters**

| Argument | Type | Description
|--- |--- |---
| options | [BotkitSchedulerOptions](#BotkitSchedulerOptions) | See [BotkitSchedulerOptions](#BotkitSchedulerOptions).<br/>

Create a scheduler. Register it with `controller.usePlugin(scheduler)`, after which it is also available as `controller.plugins.scheduler`.

```javascript
const scheduler = new BotkitScheduler({
    timezone: 'Europe/Paris',
    catchUp: 'skip',
    output: (activity, job) => console.log(activity.text)
});
controller.usePlugin(scheduler);
```

Throws an Error when an option is not valid.



## Properties and Accessors

| Name | Type | Description
|--- |--- |---
| clockAdapter | [ClockAdapter](#ClockAdapter) | The adapter behind the clock channel. See [ClockAdapter](#ClockAdapter).
| loaded | Promise&lt;void&gt; | Resolves once the jobs have been loaded from storage, and rejects with the storage error if they could not be read.<br/>Every job method waits for it, so there is normally no need to.
| name | string | The plugin name, used by Botkit.

## BotkitScheduler Class Methods
<a name="at"></a>
### at()
Create or update a job that runs once, at a given time. Shorthand for `schedule({ ...options, id, at: when })`.

**Parameters**

| Argument | Type | description
|--- |--- |---
| id| string | The job id.
| when|  | A Date, an ISO 8601 string or milliseconds since the epoch.
| options|  | The event and any other [ScheduleOptions](#ScheduleOptions).<br/>


**Returns**

A copy of the job.




```javascript
await scheduler.at('launch', new Date('2026-10-01T15:00:00Z'), { event: 'launch' });
```


<a name="cancel"></a>
### cancel()
Delete a job. A run that is already going is not stopped.

**Parameters**

| Argument | Type | description
|--- |--- |---
| id| string | The job id.<br/>


**Returns**

True if the job existed.




```javascript
await scheduler.cancel('heartbeat');
```


<a name="cron"></a>
### cron()
Create or update a job that runs on a cron schedule. Shorthand for `schedule({ ...options, id, cron: expression })`.

**Parameters**

| Argument | Type | description
|--- |--- |---
| id| string | The job id.
| expression| string | A cron expression. See [parseCron()](#parseCron).
| options|  | The event and any other [ScheduleOptions](#ScheduleOptions), such as `timezone`.<br/>


**Returns**

A copy of the job.




```javascript
await scheduler.cron('weekday-standup', '45 9 * * MON-FRI', {
    event: 'standup',
    timezone: 'Europe/London',
    reference: savedReference
});
```


<a name="every"></a>
### every()
Create or update a job that runs at a fixed interval. Shorthand for `schedule({ ...options, id, every: interval })`.

**Parameters**

| Argument | Type | description
|--- |--- |---
| id| string | The job id.
| interval|  | Milliseconds, or a duration such as `'30s'` or `'1h'`.
| options|  | The event and any other [ScheduleOptions](#ScheduleOptions).<br/>


**Returns**

A copy of the job.




```javascript
await scheduler.every('heartbeat', '1m', { event: 'heartbeat', payload: { source: 'cron' } });
```


<a name="get"></a>
### get()
Get one job.

**Parameters**

| Argument | Type | description
|--- |--- |---
| id| string | The job id.<br/>


**Returns**

A copy of the job, or undefined if there is no such job.




```javascript
const job = await scheduler.get('heartbeat');
console.log(job.nextRunAt, job.runs, job.lastError);
```


<a name="getConfig"></a>
### getConfig()
Get a value from the scheduler's resolved configuration, with defaults applied.

**Parameters**

| Argument | Type | description
|--- |--- |---
| key (optional)| string | The name of an option from [BotkitSchedulerOptions](#BotkitSchedulerOptions). Omit it to get every option.<br/>



```javascript
const tz = scheduler.getConfig('timezone'); // 'UTC' unless set
```


<a name="init"></a>
### init()
Botkit plugin init function, called by `controller.usePlugin(scheduler)`.
Registers `controller.plugins.scheduler`, loads the saved jobs, stops the timer on shutdown and, unless `autoStart` is false,
starts the timer once Botkit is ready.

**Parameters**

| Argument | Type | description
|--- |--- |---
| botkit| Botkit | A Botkit controller.<br/>



```javascript
controller.usePlugin(scheduler);
```


<a name="list"></a>
### list()
List jobs, soonest first. Jobs that will not run again come last. Ties are sorted by id.

**Parameters**

| Argument | Type | description
|--- |--- |---
| filter|  | Only list jobs with this `event`, whose reference has this `conversation` id, or whose reference has this `user` id.<br/>


**Returns**

Copies of the matching jobs.




```javascript
// every reminder for the user who sent this message
const reminders = await scheduler.list({ event: 'reminder', user: message.user });
```


<a name="pause"></a>
### pause()
Pause a job. It keeps its next run time but does not run until it is resumed.

**Parameters**

| Argument | Type | description
|--- |--- |---
| id| string | The job id.<br/>


**Returns**

A copy of the job, or undefined if there is no such job.




```javascript
await scheduler.pause('nightly-report');
```


<a name="resume"></a>
### resume()
Resume a paused job. Runs that fell due while it was paused are not made up:
an interval job continues at its next slot from now, and a cron job at its next matching time.
A one-shot job keeps its time, so it runs on the next tick if that time has passed.

**Parameters**

| Argument | Type | description
|--- |--- |---
| id| string | The job id.<br/>


**Returns**

A copy of the job, or undefined if there is no such job.




```javascript
await scheduler.resume('nightly-report');
```


<a name="runNow"></a>
### runNow()
Run a job now, whether or not it is paused and even if a run is already going. The job's next run time does not change,
but the run counts toward `maxRuns`, and a one-shot job is finished by it.
Errors in the run are recorded on the job and emitted as `scheduler_error`, as for any other run.

**Parameters**

| Argument | Type | description
|--- |--- |---
| id| string | The job id.<br/>


**Returns**

Resolves when the job's turn ends. Rejects with Error('Unknown job "&lt;id&gt;"') when there is no such job.




Do not await it from inside a turn of the conversation the job is bound to, on an adapter that runs one turn at a time
per conversation: the job's turn would wait for the current turn, which waits for the job.

```javascript
controller.hears('report now', 'message', async (bot, message) => {
    await controller.plugins.scheduler.runNow('nightly-report');
    await bot.reply(message, 'Report sent.');
});
```


<a name="schedule"></a>
### schedule()
Create a job, or update the job with the same id.

**Parameters**

| Argument | Type | description
|--- |--- |---
| options| [ScheduleOptions](#ScheduleOptions) | See [ScheduleOptions](#ScheduleOptions).<br/>


**Returns**

A copy of the job.




Give exactly one of `in`, `at`, `every` or `cron`. When the id already exists with the same timing, event and reference,
the job keeps its next run time and counters, and only `payload`, `maxRuns` and `overlap` change. That makes it safe to
declare jobs at every startup. When the timing, event or reference changed, the next run time is worked out again,
and the counters are kept.

If the job cannot be saved, the promise rejects with the storage error. The job is still scheduled in memory,
and it is saved by the next write that succeeds.

The promise rejects with an Error whose message says what is wrong when the options are not valid:
`event is required`, a `reserved` event (`message` or `shutdown`), not `exactly one of in, at, every or cron`,
`Invalid duration`, `Invalid cron expression`, `Invalid timezone`, `Invalid date`, a `maxRuns` that is not a positive integer,
or a `reference must include channelId, conversation.id and user.id`.

```javascript
// a clock job every 15 minutes
await scheduler.schedule({ id: 'sync', every: '15m', event: 'sync_inventory' });

// a reminder in a conversation, tomorrow at 9am
await scheduler.schedule({
    event: 'reminder',
    at: '2026-09-28T09:00:00-04:00',
    reference: message.reference,
    payload: { text: 'Standup in 15 minutes' }
});
```


<a name="start"></a>
### start()
Start the timer that runs jobs when they are due. Botkit calls this when it is ready, unless `autoStart` is false.
Calling it again after [stop()](#stop) starts the timer again.



```javascript
const scheduler = new BotkitScheduler({ autoStart: false });
controller.usePlugin(scheduler);
// ...later
scheduler.start();
```


<a name="stop"></a>
### stop()
Stop the timer and wait for pending storage writes. Runs that are already going are not waited for.
Botkit calls this on `controller.shutdown()`. [tick()](#tick) and the other methods keep working after it.



```javascript
await scheduler.stop();
```


<a name="tick"></a>
### tick()
Run every job that is due. The timer calls this; tests and custom loops can call it directly, with or without the timer.

**Parameters**

| Argument | Type | description
|--- |--- |---
| now (optional)| number | The time used to decide which jobs are due. Defaults to the clock's current time.<br/>


**Returns**

Resolves when the turns it started have ended, with the number of runs.




Each due job's next run time is worked out and saved before it runs, so a crash cannot run the same slot twice.
A job that fell several slots behind runs once and counts the other slots in `skipped`
(except runs being made up at startup with `catchUp: 'all'`).

```javascript
const fired = await scheduler.tick();
console.log(`${ fired } runs finished`);
```


<a name="useAdapter"></a>
### useAdapter()
Use a specific adapter for jobs bound to conversations on a channel. This is the same as the `adapters` option.

**Parameters**

| Argument | Type | description
|--- |--- |---
| channelId| string | A `channelId`, as found in conversation references.
| adapter| BotAdapter | The adapter that owns that channel.<br/>



```javascript
scheduler.useAdapter('slack', slackAdapter);
```




<a name="ClockAdapter"></a>
## ClockAdapter
The adapter behind the scheduler's built-in `scheduler` channel, which runs jobs that are not bound to a conversation ("clock jobs").

Each [BotkitScheduler](#BotkitScheduler) creates one, available as `scheduler.clockAdapter`. It is never the controller's primary adapter:
Botkit spawns the `bot` for a clock-job turn from the turn's own adapter, so handlers use the normal `bot.say()`, `bot.beginDialog()` and so on.

In a clock-job turn the activity has channelId `scheduler`, conversation id `scheduler:<job id>` and user id `scheduler`,
and `context.turnState.get('botkit-scheduler.job')` holds a copy of the job.
Anything the bot sends on this channel is handed to the scheduler's `output` option.

```javascript
const scheduler = new BotkitScheduler({
    output: async (activity, job) => {
        console.log(`[${ job ? job.id : 'scheduler' }] ${ activity.text }`);
    }
});
controller.usePlugin(scheduler);

await scheduler.every('heartbeat', '1m', { event: 'heartbeat' });
controller.on('heartbeat', async (bot, message) => {
    await bot.say('still here'); // printed by the output function
});
```

To use this class in your application, first install the package:
```bash
npm install --save botkit-plugin-scheduler
```

Then import this and other classes into your code:
```javascript
const { ClockAdapter } = require('botkit-plugin-scheduler');
```

This class includes the following methods:
* [continueConversation()](#continueConversation)
* [run()](#run)
* [sendActivities()](#sendActivities)



### Create a new ClockAdapter()
**Parameters**

| Argument | Type | Description
|--- |--- |---
| scheduler | [BotkitScheduler](#BotkitScheduler) | The scheduler whose `output` option receives outgoing activities.<br/>

Create the clock adapter for a scheduler. BotkitScheduler does this itself; there is no need to call it.

```javascript
const clock = new ClockAdapter(scheduler);
```



## Properties and Accessors

| Name | Type | Description
|--- |--- |---
| name | string | Name of this adapter.

## ClockAdapter Class Methods
<a name="continueConversation"></a>
### continueConversation()
Standard BotBuilder adapter method for continuing an existing conversation based on a conversation reference.
Errors from the middleware or the logic are passed on to the caller.
[BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#continueconversation)

**Parameters**

| Argument | Type | description
|--- |--- |---
| reference| Partial&lt;ConversationReference&gt; | A conversation reference on the `scheduler` channel.
| logic|  | A bot logic function that will perform continuing action in the form `async(context) => { ... }`<br/>



<a name="run"></a>
### run()
Run a turn on the clock channel through this adapter's middleware.
The scheduler calls this for every clock-job run; `logic` is normally `controller.handleTurn`.

**Parameters**

| Argument | Type | description
|--- |--- |---
| activity| Partial&lt;Activity&gt; | The incoming activity. It must include `channelId`, `conversation.id` and `from.id`.
| logic|  | The turn handler, in the form `async(context) => { ... }`.
| job (optional)| [ScheduledJob](#ScheduledJob) | The job this turn runs, stored in `context.turnState` as `botkit-scheduler.job` and passed to the output function.<br/>



```javascript
await scheduler.clockAdapter.run({
    type: 'event',
    name: 'heartbeat',
    channelId: 'scheduler',
    conversation: { id: 'scheduler:heartbeat' },
    from: { id: 'scheduler' },
    recipient: { id: 'bot' },
    channelData: { botkitEventType: 'heartbeat' }
}, controller.handleTurn.bind(controller));
```


<a name="sendActivities"></a>
### sendActivities()
Standard BotBuilder adapter method that sends outgoing activities. Each activity is passed to the scheduler's `output` function,
together with the job the turn belongs to (null when it cannot be found).
[BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#sendactivities).

**Parameters**

| Argument | Type | description
|--- |--- |---
| context| TurnContext | A TurnContext representing the current incoming message and environment.
| activities|  | An array of outgoing activities.<br/>


**Returns**

One `{ id }` per activity, in the form `clock-<n>`.




<a name="assertTimezone"></a>
## Function assertTimezone()
Check that a time zone name is one this runtime knows.

**Parameters**

| Argument | Type | description
|--- |--- |---
| timezone| string | An IANA time zone name such as `America/New_York`, or `UTC`.<br/>

Throws Error('Invalid timezone "&lt;timezone&gt;"') when the runtime does not recognize the name.

```javascript
const { assertTimezone } = require('botkit-plugin-scheduler');

assertTimezone('Europe/Paris'); // ok
assertTimezone('Mars/Olympus'); // throws Error('Invalid timezone "Mars/Olympus"')
```


<a name="nextRun"></a>
## Function nextRun()
Find the next time a cron expression fires, strictly after a given instant.

**Parameters**

| Argument | Type | description
|--- |--- |---
| expression|  | A cron expression string, or the result of [parseCron()](#parseCron).
| from|  | The instant to search from, as a Date or milliseconds. The result is always later than this.
| timezone (optional)| string | An IANA time zone name such as `America/New_York`. Defaults to `UTC`.<br/>


**Returns**

The next matching instant, or null if nothing matches within 8 years (for example `0 0 30 2 *`).




The expression is evaluated against the wall clock of `timezone`. Around daylight saving time changes:
* A time that does not exist because clocks spring forward runs once, at the same offset after the change. For example `30 2 * * *` in `America/New_York` runs at 03:30 EDT on the day clocks go from 02:00 to 03:00.
* A time that happens twice because clocks fall back runs once, at its first occurrence.

```javascript
const { nextRun } = require('botkit-plugin-scheduler');

// 9am New York time on weekdays
const next = nextRun('0 9 * * 1-5', new Date('2026-09-27T12:00:00Z'), 'America/New_York');
console.log(next.toISOString()); // 2026-09-28T13:00:00.000Z
```


<a name="parseCron"></a>
## Function parseCron()
Parse a cron expression.

**Parameters**

| Argument | Type | description
|--- |--- |---
| expression| string | A cron expression such as `'0 9 * * MON-FRI'`, `'0 0 1 JAN,JUL *'` or `'@daily'`.<br/>


**Returns**

The parsed expression, a [CronExpression](#CronExpression). Throws Error('Invalid cron expression "&lt;expression&gt;": &lt;reason&gt;') when the expression cannot be parsed.




Supported syntax:
* 5 fields (`minute hour day-of-month month day-of-week`) or 6 fields (a leading `second` field).
* The macros `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight` and `@hourly`.
* In each field: `*`, a value `a`, a range `a-b`, the steps `a-b/n` and `a/n` (from `a` to the end of the range),
  `*` followed by `/n` (every n), and comma-separated lists of these.
* `?` in the day-of-month and day-of-week fields, meaning the same as `*`.
* Month names `JAN`-`DEC` and day names `SUN`-`SAT`, in any case. In the day-of-week field, both 0 and 7 mean Sunday.

Day-of-month and day-of-week follow Vixie cron: when both fields are restricted (their text does not start with `*` or `?`),
a day matches if EITHER field matches. Otherwise a day must match both. So `0 0 13 * 5` runs on the 13th of every month and on every Friday.

```javascript
const { parseCron } = require('botkit-plugin-scheduler');

const cron = parseCron('0 9 * * MON-FRI');
console.log(cron.daysOfWeek); // [1, 2, 3, 4, 5]
```


<a name="parseDuration"></a>
## Function parseDuration()
Convert a duration into milliseconds.

**Parameters**

| Argument | Type | description
|--- |--- |---
| value|  | A number of milliseconds, or a duration string such as `'30s'`, `'5m'` or `'1h30m'`.<br/>


**Returns**

The duration in milliseconds, always greater than 0. Throws Error('Invalid duration "&lt;value&gt;"') when the value cannot be read or is not greater than 0.




A finite number greater than 0 is read as milliseconds, and so is a string of digits.
Any other string must be one or more `<integer><unit>` groups with no spaces between them,
where the unit is `ms`, `s`, `m`, `h`, `d` or `w`.

```javascript
const { parseDuration } = require('botkit-plugin-scheduler');

parseDuration('1h30m'); // 5400000
parseDuration('500ms'); // 500
parseDuration(1500);    // 1500
parseDuration('10');    // 10
```



<a name="BotkitSchedulerOptions"></a>
## Interface BotkitSchedulerOptions
Options for the [BotkitScheduler](#BotkitScheduler) constructor. Every option is optional.

**Fields**

| Name | Type | Description
|--- |--- |---
| adapters |  | The adapter to use for jobs bound to a conversation, by the `channelId` of the job's reference.<br/>Channels not listed here use the adapter the scheduler last saw spawn a bot on that channel, and then the controller's adapter.<br/>
| autoStart | boolean | Start the timer automatically once Botkit is ready. Defaults to true. When false, call `scheduler.start()` or drive it with `scheduler.tick()`.<br/>
| catchUp |  | What to do at startup with jobs whose run time passed while the bot was not running.<br/>`skip` drops the missed runs, `once` (the default) runs the job once, and `all` runs every missed slot, up to `maxCatchUp`.<br/>
| clock | [SchedulerClock](#SchedulerClock) | The source of time. Defaults to the system clock.<br/>
| maxCatchUp | number | With `catchUp: 'all'`, the most missed runs to make up per job. Defaults to 10.<br/>
| output |  | Receives every activity a bot sends on the clock channel (the `scheduler` channel of jobs that have no reference),<br/>with a copy of the job it belongs to, or null when that job cannot be found. Defaults to logging with `debug('botkit:scheduler')`.<br/>
| pruneCompleted | boolean | Delete one-shot jobs, and jobs that reached `maxRuns`, once they finish. Defaults to true.<br/>When false, finished jobs stay in storage with `nextRunAt: null`.<br/>
| storage | Storage | Where jobs are saved. Defaults to the controller's storage (`controller.storage`).<br/>
| storageKey | string | The storage key of the document that holds every job. Defaults to `botkit-scheduler/jobs`.<br/>
| timezone | string | The time zone for cron jobs that do not name one. Defaults to `UTC`.<br/>
| turnTimeout | number | How long a job's turn may run, in milliseconds, before it is recorded as failed. Defaults to 30000. 0 turns the limit off.<br/>The turn itself is not cancelled.<br/>
| unref | boolean | Unref the timer, so that a pending job does not keep the Node.js process alive. Defaults to false.<br/>
<a name="CronExpression"></a>
## Interface CronExpression
A parsed cron expression, as returned by [parseCron()](#parseCron).
Every list is sorted and holds each allowed value once.

**Fields**

| Name | Type | Description
|--- |--- |---
| daysOfMonth |  | Allowed days of the month (1-31).<br/>
| daysOfWeek |  | Allowed days of the week (0-6, where 0 is Sunday). A `7` in the expression is stored as `0`.<br/>
| domRestricted | boolean | False when the day-of-month field starts with `*` or `?`.<br/>
| dowRestricted | boolean | False when the day-of-week field starts with `*` or `?`.<br/>
| hasSeconds | boolean | True when the expression has 6 fields, the first one being seconds.<br/>
| hours |  | Allowed hours (0-23).<br/>
| minutes |  | Allowed minutes (0-59).<br/>
| months |  | Allowed months (1-12).<br/>
| seconds |  | Allowed seconds (0-59). `[0]` for a 5-field expression.<br/>
| source | string | The expression as it was passed to `parseCron()`, trimmed.<br/>
<a name="ScheduleOptions"></a>
## Interface ScheduleOptions
Options for [scheduler.schedule()](#schedule) and `bot.schedule()`. Give exactly one of `in`, `at`, `every` or `cron`.

**Fields**

| Name | Type | Description
|--- |--- |---
| at |  | Run once, at this time. A time in the past runs on the next tick.<br/>
| cron | string | Run on a cron schedule, such as `'0 9 * * MON-FRI'`. See [parseCron()](#parseCron) for the syntax.<br/>
| event | string | The Botkit event the job fires. Handle it with `controller.on(event, handler)`. It cannot be `message` or `shutdown`.<br/>
| every |  | Run repeatedly, this often: milliseconds, or a duration such as `'5m'`.<br/>
| id | string | The job id. Scheduling an id that already exists updates that job. Defaults to `job-` followed by 8 random hex characters.<br/>
| in |  | Run once, after this long: milliseconds, or a duration such as `'90s'` or `'1h30m'`.<br/>It is measured from each call, so scheduling the same id again moves the run (to snooze or debounce it).<br/>
| maxRuns | number | Stop after this many runs.<br/>
| overlap |  | What to do when a run comes due while the previous run of the same job is still going.<br/>`skip` (the default) skips the new run and counts it in `skipped`; `allow` runs both.<br/>
| payload | any | Data for the handler, available as `message.value`. It is stored as JSON.<br/>
| reference |  | The conversation the job runs in, usually `message.reference`. Omit it, or pass null, for a clock job.<br/>It must include `channelId`, `conversation.id` and `user.id`.<br/>A reference on the scheduler's own `scheduler` channel (such as `message.reference` in a clock job's handler) also makes a clock job.<br/>
| startAt |  | For every jobs: the time of the first run. Later runs follow at `every` intervals from it; a start in the past<br/>begins at the next slot that is not in the past. Defaults to one interval from now. Other jobs ignore it.<br/>
| timezone | string | For cron jobs: the time zone the expression is read in. Defaults to the scheduler's `timezone`. Other jobs ignore it.<br/>
<a name="ScheduledJob"></a>
## Interface ScheduledJob
A scheduled job, as returned by [get()](#get), [list()](#list) and [schedule()](#schedule). Times are ISO 8601 strings.
Returned jobs are copies: changing them does not change the schedule.

**Fields**

| Name | Type | Description
|--- |--- |---
| at |  | For one-shot jobs: when it runs.<br/>
| createdAt | string | When the job was first scheduled.<br/>
| cron |  | For cron jobs: the cron expression.<br/>
| errors | number | How many runs failed: the handler threw, the turn failed or it timed out.<br/>
| event | string | The Botkit event the job fires.<br/>
| every |  | For interval jobs: the interval in milliseconds.<br/>
| id | string | The job id.<br/>
| kind |  | `at` for one-shot jobs (created with `at` or `in`), `every` for interval jobs and `cron` for cron jobs.<br/>
| lastError |  | The message of the latest failure, or null.<br/>
| lastRunAt |  | When the job last started a run, or null.<br/>
| maxRuns |  | The most runs allowed, or null for no limit.<br/>
| nextRunAt |  | When the job runs next, or null when it will not run again.<br/>
| overlap |  | `skip` or `allow`: see [ScheduleOptions](#ScheduleOptions).<br/>
| paused | boolean | True while the job is paused.<br/>
| payload | any | The data passed to the handler as `message.value`, or null.<br/>
| reference |  | The conversation the job runs in, or null for a clock job.<br/>Only `channelId`, `serviceUrl`, `locale`, `conversation`, `user` and `bot` are kept.<br/>
| runs | number | How many times the job has run.<br/>
| skipped | number | How many run times passed without a run: overlapping runs, and runs missed while the bot was stopped or busy.<br/>
| startAt |  | For interval jobs: the `startAt` they were created with, or null.<br/>
| timezone |  | For cron jobs: the time zone the expression is read in.<br/>
<a name="SchedulerClock"></a>
## Interface SchedulerClock
A source of time for [BotkitScheduler](#BotkitScheduler). Pass a fake one in tests to control time.
The default uses `Date.now()`, `setTimeout()` and `clearTimeout()`.

**Fields**

| Name | Type | Description
|--- |--- |---
| clearTimeout |  | Cancel a callback set with `setTimeout()`.<br/>
| now |  | The current time, in milliseconds since the epoch.<br/>
| setTimeout |  | Call `fn` once after `ms` milliseconds, and return a handle for `clearTimeout()`.<br/>
