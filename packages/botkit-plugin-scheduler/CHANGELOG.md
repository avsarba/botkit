# botkit-plugin-scheduler changelog

# 1.0.0

This is the first release.

* `BotkitScheduler` plugin: cron, interval (`every`), one-shot (`at`, `in`) jobs, saved in Botkit storage and reloaded at startup.
* A job runs as an ordinary Botkit event turn, handled with `controller.on(event)`: on the built-in `scheduler` clock channel, or inside a saved conversation on the adapter that owns it.
* Scheduled turns are routed as interrupts, so they run while a dialog question is pending without answering it.
* `bot.schedule()` and `bot.cancelSchedule()` on every bot; `controller.plugins.scheduler` for the full API: `schedule`, `every`, `cron`, `at`, `cancel`, `pause`, `resume`, `runNow`, `get`, `list`, `tick`, `start`, `stop`, `useAdapter`.
* Catch-up policies for runs missed while the bot was down (`skip`, `once`, `all`), overlap control, `maxRuns`, turn time-outs and a `scheduler_error` event.
* Dependency-free cron parser with seconds, names, macros, Vixie day-of-month/day-of-week semantics, and time zones with defined daylight saving time behaviour (`parseCron`, `nextRun`).
* `parseDuration` for durations such as `'1h30m'`.
* Injectable clock for testing.
