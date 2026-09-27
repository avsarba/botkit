[&larr; Botkit Documentation](../core.md)  [&larr; Plugin Index](index.md) 

# botkit-plugin-scheduler

Give [Botkit](https://www.npmjs.com/package/botkit) a clock: cron, interval and one-shot jobs that are saved in Botkit storage and survive restarts.

A job that comes due becomes an ordinary Botkit turn. You handle it with `controller.on(event)`, where `bot.say()`, `bot.beginDialog()` and everything else work as usual.
A job runs in one of two places:

* **On the scheduler's own clock channel**, for machine work that has no chat attached: nightly reports, health checks, cache refreshes. Anything the bot says there goes to an `output` function you provide.
* **Inside a saved conversation**, on whichever adapter owns it: reminders, follow-ups, SLA escalations. `bot.say()` reaches the user in that conversation.

Scheduled turns are handled before Botkit's dialog system, so a reminder fires even while a dialog is waiting for the user's answer, and the dialog still gets the user's next message.

## Install Package

Add this package to your project using npm:

```bash
npm install --save botkit-plugin-scheduler
```

Import the plugin class into your code:

```javascript
const { BotkitScheduler } = require('botkit-plugin-scheduler');
```

## Use the Scheduler in your App

Create the scheduler and register it with `usePlugin()`. It loads saved jobs from the controller's storage, and starts its timer once Botkit is ready.
All of its methods are then also available as `controller.plugins.scheduler`.

```javascript
const scheduler = new BotkitScheduler({ timezone: 'America/New_York' });
controller.usePlugin(scheduler);
```

Use persistent storage, such as `botbuilder-storage-mongodb`, when jobs must survive a restart. With Botkit's default `MemoryStorage` they last only as long as the process.

### Clock jobs

A job without a conversation reference runs on the clock channel. Its turn comes from user `scheduler` in conversation `scheduler:<job id>`, and anything the bot sends there goes to the `output` function.

```javascript
const scheduler = new BotkitScheduler({
    output: (activity, job) => console.log(`[${ job ? job.id : 'scheduler' }] ${ activity.text }`)
});
controller.usePlugin(scheduler);

controller.ready(async () => {
    // Declaring jobs at every startup is safe: a job with the same id and timing is kept as it is.
    await controller.plugins.scheduler.cron('nightly-report', '0 2 * * *', { event: 'nightly_report' });
    await controller.plugins.scheduler.every('health', '5m', { event: 'health_check', payload: { url: 'https://example.com/health' } });
});

controller.on('nightly_report', async (bot, message) => {
    await bot.say('Nightly report sent.'); // printed by the output function
});
```

### Reminders and follow-ups in a conversation

Inside a handler, `bot.schedule()` binds the job to the conversation the bot is in. When the job runs, it runs in that conversation on the same adapter.

```javascript
controller.hears(/remind me in (\d+) minutes? to (.*)/i, 'message', async (bot, message) => {
    const [, minutes, what] = message.matches;
    const job = await bot.schedule({ in: `${ minutes }m`, event: 'reminder', payload: { what } });
    await bot.reply(message, `OK, I will remind you (${ job.id }).`);
});

controller.on('reminder', async (bot, message) => {
    await bot.say(`Reminder: ${ message.value.what }`);
});
```

Outside a handler, pass a saved `reference` (for example `message.reference`) to `scheduler.schedule()`. The reference must include `channelId`, `conversation.id` and `user.id`.

```javascript
await controller.plugins.scheduler.schedule({
    id: `sla-${ ticket.id }`,
    event: 'sla_escalation',
    in: '4h',
    reference: ticket.reference,
    payload: { ticket: ticket.id }
});
```

Jobs bound to another adapter's channel run through that adapter. The scheduler learns which adapter serves each channel from the bots Botkit spawns; to set it explicitly, use the `adapters` option or `scheduler.useAdapter(channelId, adapter)`.

### Managing jobs

```javascript
const scheduler = controller.plugins.scheduler;

await scheduler.schedule({ id: 'sync', every: '15m', event: 'sync' }); // create or update
await scheduler.at('launch', '2026-10-01T15:00:00Z', { event: 'launch' });
await scheduler.pause('sync');
await scheduler.resume('sync');
await scheduler.runNow('sync');     // run now, without moving the schedule
await scheduler.cancel('sync');     // true if the job existed

const job = await scheduler.get('launch');
const reminders = await scheduler.list({ event: 'reminder', user: message.user });
```

A job is given exactly one of these:

| Option | Runs |
|--- |---
| `in: '10m'` | once, after a duration (milliseconds or `ms`, `s`, `m`, `h`, `d` and `w` units, such as `'1h30m'`) |
| `at: date` | once, at a Date, an ISO 8601 string or milliseconds since the epoch. A time in the past runs right away. |
| `every: '1h'` | repeatedly, at a fixed interval. `startAt` sets the first run; later runs keep that rhythm. |
| `cron: '0 9 * * MON-FRI'` | on a cron schedule, in `timezone` or the scheduler's default time zone |

Other job options are `id` (generated when omitted), `payload` (stored as JSON), `maxRuns`, and `overlap`.
By default (`overlap: 'skip'`), a run that comes due while the previous run of the same job is still going is skipped. Use `'allow'` to run both.

Scheduling an `id` that already exists updates that job. If its timing, event and reference are unchanged, it keeps its next run time and counters, and only its payload, `maxRuns` and `overlap` change.
Because `in` is measured from each call, scheduling an `in` job again with the same id moves its run: a simple way to snooze or debounce.
If the job cannot be saved, the call rejects with the storage error, but the change still applies in memory and is saved with the next successful write.

### Options

| Option | Default | Description
|--- |--- |---
| storage | `controller.storage` | Where jobs are saved.
| storageKey | `'botkit-scheduler/jobs'` | The storage key of the document that holds every job.
| timezone | `'UTC'` | The time zone of cron jobs that do not name one.
| catchUp | `'once'` | What to do at startup with runs missed while the bot was down: `'skip'`, `'once'` or `'all'`. See below.
| maxCatchUp | `10` | With `catchUp: 'all'`, the most missed runs to make up per job.
| pruneCompleted | `true` | Delete one-shot jobs, and jobs that reached `maxRuns`, when they finish. When false, they are kept with `nextRunAt: null`.
| turnTimeout | `30000` | Milliseconds a run may take before it is recorded as failed. `0` turns the limit off. The turn itself is not cancelled.
| adapters | `{}` | The adapter to use for each `channelId`, for jobs bound to conversations.
| output | debug log | `(activity, job) => {}`, called for every activity the bot sends on the clock channel.
| clock | system clock | `{ now(), setTimeout(fn, ms), clearTimeout(handle) }`. Pass a fake clock in tests.
| autoStart | `true` | Start the timer when Botkit is ready. When false, call `scheduler.start()`, or drive the scheduler with `scheduler.tick()`.
| unref | `false` | Unref the timer, so that waiting for a job does not keep the process alive.

### What a handler receives

A job's turn is an `event` activity, and the handler's `message` includes:

| Field | Value
|--- |---
| `message.type` | The job's event.
| `message.value` | A copy of the job's payload.
| `message.job` | `{ id, event, kind, runs, scheduledAt, firedAt }`. `scheduledAt` is the slot the run belongs to and `firedAt` is when it started.
| `message.botkitScheduler` | `true`.
| `message.user`, `message.channel` | The reference's user and conversation, or `scheduler` and `scheduler:<job id>` for a clock job.
| `message.reference` | The turn's conversation reference. Pass it to `bot.schedule()` or `scheduler.schedule()` to schedule a follow-up.

In a clock-job turn, `message.context.turnState.get('botkit-scheduler.job')` also holds a copy of the whole job.

### How scheduled turns are routed

The scheduler registers a `controller.interrupts()` handler for each job event. It matches only turns the scheduler started, calls your `controller.on(event)` handlers, and then ends the turn.
As a result:

* **Handle scheduled events with `controller.on(event)`.** `hears()` or `interrupts()` registered for a job's event name do not see scheduled runs.
* **A dialog waiting for an answer is left alone.** The job does not answer the question, and the user's next message still does. A handler may start a new dialog with `bot.beginDialog()`, as in any interrupt.
* An event with the same name that arrives from a user (for example a `reminder` event sent by a web client) is not treated as a scheduled run, even if it sets `botkitScheduler`.

### Errors and time-outs

When a handler throws, the run is recorded as failed (`errors` goes up by one and `lastError` holds the message), the job keeps its schedule, and a `scheduler_error` event is emitted:

```javascript
controller.on('scheduler_error', async (bot, message) => {
    console.error(`Job ${ message.job.id } failed:`, message.error);
});
```

A run whose turn fails in other ways, for example in middleware, or that takes longer than `turnTimeout`, is recorded the same way (`lastError` is `Timed out after <n>ms` for a time-out), without a `scheduler_error` event.

### Catching up after downtime

At startup, the `catchUp` option decides what happens to jobs whose run time passed while the bot was not running:

* `'once'` (the default): each such job runs once, with `scheduledAt` set to its first missed slot, and then continues from the next future slot.
* `'skip'`: missed runs are dropped and counted in `skipped`. One-shot jobs that were missed are deleted (or kept with `nextRunAt: null` when `pruneCompleted` is false).
* `'all'`: every missed slot runs, in order and one at a time, each with its own `scheduledAt`, up to `maxCatchUp` per job. Slots beyond that are counted in `skipped`.

While the bot is running, a job that falls behind (because the process was busy or the machine slept) runs once, and the slots it missed are counted in `skipped`.

### Cron syntax

Expressions have 5 fields (`minute hour day-of-month month day-of-week`) or 6 fields with a leading `second` field.

| Syntax | Meaning
|--- |---
| `*` | every value
| `5`, `1-5`, `1,15,30` | a value, a range, a list
| `*/15`, `0-30/10`, `5/20` | steps: every 15, every 10 from 0 to 30, every 20 from 5 to the end
| `JAN`-`DEC`, `SUN`-`SAT` | month and day names, in any case. `0` and `7` are both Sunday.
| `?` | the same as `*`, in the day-of-month and day-of-week fields
| `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly` | macros

As in Vixie cron, when both day-of-month and day-of-week are restricted (neither starts with `*` or `?`), a day matches if either one matches: `0 0 13 * 5` runs on the 13th of each month and on every Friday.

### Time zones and daylight saving time

Cron jobs follow the wall clock of their time zone (`timezone` on the job, or the scheduler's `timezone` option). Around daylight saving time changes:

* A time that does not exist because clocks spring forward runs once, shifted by the change: in `America/New_York`, `30 2 * * *` runs at 03:30 EDT on that day, and `0 * * * *` runs at 03:00 EDT once.
* A time that happens twice because clocks fall back runs once, at its first occurrence: `30 1 * * *` runs at 01:30 EDT and not again at 01:30 EST, and `*/15 * * * *` does not repeat the hour.

Interval jobs (`every`) ignore time zones: they run every so many milliseconds of real time.

### Testing

Pass `autoStart: false` and drive the scheduler with `tick(now)`, which runs every job due at `now` and resolves when their turns end, with the number of runs:

```javascript
const scheduler = new BotkitScheduler({ autoStart: false });
controller.usePlugin(scheduler);

await scheduler.every('hb', '1m', { event: 'heartbeat' });
const runs = await scheduler.tick(Date.now() + 60000); // 1
```

To test the timer itself, pass a fake `clock` whose `setTimeout()` records the callbacks it is given.

### Limitations

* **One process.** The scheduler is designed for one bot process. If several processes share the same storage, each of them runs every job.
* **At most once.** A job's next run time is saved before it runs, so a crash cannot run the same slot twice; a run interrupted by a crash is not retried.
* **Personal data.** A job bound to a conversation stores its reference, which holds user and conversation ids. When a user asks to be forgotten, cancel their jobs:
  ```javascript
  for (const job of await scheduler.list({ user: userId })) {
      await scheduler.cancel(job.id);
  }
  ```
* Finished one-shot jobs are deleted by default (`pruneCompleted`). A one-shot job declared at every startup with a time in the past therefore runs again at each startup; give it a future time, or set `pruneCompleted: false`.
* `turnTimeout` records a failure but cannot stop a handler that is still running.
* An adapter's own middleware (`adapter.use()`) sees the standard `continueConversation` event activity; Botkit turns it into the job's event after the middleware runs. If the adapter cannot continue a conversation (botbuilder's `TestAdapter`, for one), the scheduler runs the turn directly, as `bot.changeContext()` does, without the adapter's middleware.
* Do not await `scheduler.runNow(id)` inside a turn of the conversation that job is bound to, on an adapter that runs one turn at a time per conversation: the job's turn would wait for the current turn to end, and the current turn would wait for the job.
* Register one scheduler per controller.
* The plugin works with botkit 4.10, with two differences that come from Botkit itself. Botkit 4.10 wraps errors thrown by handlers, so `lastError` reads `Error: boom` instead of `boom`. And when a message fails to send, 4.10's `bot.say()` never settles and raises an unhandled rejection, so the run is recorded as a time-out. Botkit 4.11 fixes both.

## Class Reference

* [BotkitScheduler](../reference/scheduler.md#botkitscheduler)
* [ClockAdapter](../reference/scheduler.md#clockadapter)
* [parseCron()](../reference/scheduler.md#parsecron), [nextRun()](../reference/scheduler.md#nextrun) and [parseDuration()](../reference/scheduler.md#parseduration)

## Event List

| Event | Description
|--- |---
| _your job's event_ | A job ran. See [What a handler receives](#what-a-handler-receives).
| scheduler_error | A job's handler threw. The message is the job's message with `type: 'scheduler_error'` and the thrown `error`.

## Botkit Extensions

In Botkit handlers, the `bot` worker has these extensions, in addition to [the base methods](../reference/core.md#botworker):

### bot.schedule()

Schedule a job, as [scheduler.schedule()](../reference/scheduler.md#schedule) does. Unless `reference` is given, the job is bound to the bot's current conversation; a bot that has no conversation, or is on the clock channel, schedules a clock job.

```javascript
await bot.schedule({ in: '1d', event: 'follow_up', payload: { topic: 'your order' } });
```

### bot.cancelSchedule()

Cancel a job by id. Resolves with true if the job existed.

```javascript
await bot.cancelSchedule('follow-up-123');
```

### controller.plugins.scheduler

The [BotkitScheduler](../reference/scheduler.md#botkitscheduler) instance, with every method.

## Community & Support

Join our thriving community of Botkit developers and bot enthusiasts at large.
Over 10,000 members strong, [our open Slack group](https://community.botkit.ai) is
_the place_ for people interested in the art and science of making bots.
Come to ask questions, share your progress, and commune with your peers!

You can also find help from members of the Botkit team [in our dedicated Cisco Spark room](https://eurl.io/#SyNZuomKx)!

## About Botkit

Botkit is a part of the [Microsoft Bot Framework](https://dev.botframework.com).

Want to contribute? [Read the contributor guide](https://github.com/howdyai/botkit/blob/master/CONTRIBUTING.md)

Botkit is released under the [MIT Open Source license](https://github.com/howdyai/botkit/blob/master/LICENSE.md)
