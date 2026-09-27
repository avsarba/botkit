# Botkit Beyond Chat

[&larr; Botkit Documentation](core.md)

Botkit's building blocks, `hears()`, `on()`, `interrupts()` and [BotkitConversation](conversations.md) dialogs, were designed for chat apps. Nothing in them requires a chat app, though. This guide shows the same blocks serving three kinds of user that have never opened a messenger:

* a person at a **command line**, typing into a REPL, stepping through a wizard, or not there at all because the bot runs in CI;
* an **AI agent**, such as Claude Code, that calls the bot as a set of tools over the Model Context Protocol;
* the **clock**, which starts turns on a schedule.

Table of Contents

* [Why](#why)
* [The three surfaces](#the-three-surfaces)
* [The Ops Desk walkthrough](#the-ops-desk-walkthrough)
* [How turns flow](#how-turns-flow)
* [Designing dialogs for non-chat surfaces](#designing-dialogs-for-non-chat-surfaces)
* [Reference](#reference)

## Why

Many tasks are really conversations, even when nobody is chatting: a deploy that has to ask which service and which environment, an installer, an on-call checklist. A good dialog asks each question once, checks the answer, branches, and refuses to go on without the answers it needs.

Botkit already expresses that well. BotkitConversation gives you questions with keys, validation patterns, threads, and hooks that run between steps. Until now, that logic was only reachable from a chat window.

Serving the same dialog elsewhere gives you:

* **One source of truth.** The deploy wizard a person walks through in the terminal is exactly the one CI runs from an answers file, and the one an agent has to follow step by step. Validation and confirmations cannot drift apart, because they are the same code.
* **Guard rails for agents.** An agent that deploys through a dialog cannot skip the typed confirmation: the dialog, not the agent, decides what comes next.
* **Scheduled work as ordinary turns.** A reminder or a nightly job is just an event handled by `controller.on()`, with the same middleware, storage and `bot.say()` as everything else.

Botkit 4.11 makes this dependable. When a handler throws, `controller.handleTurn()` now rejects with the error. Before, the turn never settled and the process got an unhandled rejection. It also adds [controller.getPendingQuestion()](reference/core.md#getPendingQuestion), which tells an adapter which question a dialog is waiting on, and for which key.

## The three surfaces

| Surface | Package | What it gives you
|--- |--- |---
| Command line | [botbuilder-adapter-cli](platforms/cli.md) | Every typed or piped line is a message. Quick replies become numbered menus. `run({ dialog })` runs a dialog as a wizard and resolves with its status and variables. With `answers` and `nonInteractive`, it runs unattended in CI and exits with a meaningful code. `format: 'json'` writes one JSON object per line.
| AI agents (MCP) | [botbuilder-adapter-mcp](platforms/mcp.md) | The bot becomes a Model Context Protocol server on stdio. The `chat` tool sends a message through the whole pipeline and returns the replies, the choices offered and the pending question. Tools declared with `adapter.tool()` are handled by `controller.on('tool:<name>')`, and they return structured results with `bot.toolResult()`.
| The clock | [botkit-plugin-scheduler](plugins/scheduler.md) | Cron, interval and one-shot jobs, saved in Botkit storage. A job bound to a conversation continues it on the adapter that owns it. A clock job runs on the scheduler's own channel. `bot.schedule()` binds a job to the current conversation.

The two adapters work like any other Botkit adapter, and the scheduler is an ordinary plugin, so the same features can serve every surface. Keep in mind how agents run an MCP server. Each agent session starts its own copy of the bot as a child process, and talks to it over that process's stdin and stdout. It never connects to a bot that is already running. So do not attach an `McpAdapter` to the web chat bot that people use. Every agent session would start another copy of the whole web bot, and each copy would try to bind the web bot's port. Do what Ops Desk does instead. Keep the features in modules, and give agents an entry point of their own that loads them with `new Botkit({ adapter: new McpAdapter(), disable_webserver: true, disable_console: true })`.

## The Ops Desk walkthrough

[Ops Desk](https://github.com/howdyai/botkit/tree/main/packages/examples/ops-desk) is a runnable example in `packages/examples`. It needs no credentials. A single set of feature files handles a guided deploy of three fake services, fleet status, reminders, health watches and a nightly report. Two small entry points serve those features on two adapters:

```javascript
// ops-desk/opsdesk.js (shortened)
module.exports = function createOpsDesk(adapter, options = {}) {
    const controller = new Botkit({ adapter, storage: options.storage, disable_webserver: true, disable_console: true });
    const scheduler = new BotkitScheduler({ clock: options.clock, output: options.reportOutput });
    controller.usePlugin(scheduler);
    controller.addPluginExtension('opsdesk', { fleet, settings: { watchInterval } });
    controller.loadModules(__dirname + '/features');
    return { controller, scheduler, fleet, ready };
};

// ops-desk/cli.js
const cli = createCli({ answers, nonInteractive, autoStart: false });
await cli.ready;
const result = await cli.adapter.run(args.run ? { dialog: args.run } : {});
process.exitCode = result.exitCode;

// ops-desk/mcp.js
const adapter = new McpAdapter({ serverInfo: { name: 'ops-desk', title: 'Ops Desk', version: '1.0.0' } });
adapter.tool('service_status', { description: 'Versions and health of every service', annotations: { readOnlyHint: true } });
createOpsDesk(adapter);
```

**1. A person in the terminal.** `node ops-desk/cli.js` starts a session. Type `deploy`, pick `2` from the menu, then choose `Production`. The bot asks you to type the service name before it ships:

```text
you> deploy
bot> Which service?
     [1] api  [2] billing  [3] search
you> 2
bot> Deploy billing to which environment?
     [1] Staging  [2] Production
you> Production
bot> Type the service name (billing) to confirm a PRODUCTION deploy.
you> billing
bot> Deployed billing 1.4.2 to production.
```

**2. The same dialog in CI.** Every question has a key, so a JSON file can answer it: `{ "service": "billing", "env": "production", "confirm": "billing" }`. Nobody needs to be at the keyboard:

```bash
node ops-desk/cli.js --run deploy --answers ops-desk/answers.json --non-interactive
```

The process exits with 0 when the deploy ships, and with 1 when the confirmation does not match and the dialog is canceled. It exits with 2 when an answer is missing, and prints the question that was left unanswered to stderr.

**3. The same dialog for an agent.** Register the MCP server with Claude Code:

```bash
claude mcp add ops-desk -- node $(pwd)/packages/examples/ops-desk/mcp.js
```

Ask it to "deploy search to staging". The agent calls the `chat` tool with `deploy`, reads `pendingQuestion.key: 'service'` and the offered choices, answers `search`, then answers `staging`. The result says `Deployed search 0.9.9 to staging.` and `awaitingInput: false`. For data rather than conversation, it calls `service_status`, which returns `{ services: [...] }` as structured content.

**4. The clock.** Say `remind me in 10 minutes to check the logs`. The reminder is a one-shot job bound to the conversation you are in. In the terminal, it prints into your session. Over MCP, it lands in the chat session's outbox, which the agent's next `chat` call returns, and it is also sent at once as a log notification. The nightly report is a cron job with no conversation, and its text goes to the scheduler's `output` hook.

The [Ops Desk readme](https://github.com/howdyai/botkit/tree/main/packages/examples/ops-desk) has the full transcripts, the MCP configuration for other clients, and a CI snippet.

## How turns flow

Whatever the surface, every turn ends up in the same place: `controller.handleTurn()`. It runs the ingest and receive middleware, then interrupts, then the active dialog, then `hears()`, then `on()`, and finally saves the state.

**Command line.** The CLI adapter reads one line at a time and puts it in a queue, so turns never overlap.

1. A line becomes a message activity with `channelId: 'cli'`, the session's conversation id and the user id. If a menu is showing, a number or a choice title is replaced by the choice's value.
2. The adapter runs the turn through its own middleware and then `handleTurn()`, with a time limit (`turnTimeout`).
3. The replies are rendered as they are sent: `bot> text`, a numbered menu for quick replies, and summaries for cards and attachments.
4. After the turn, the adapter calls `controller.getPendingQuestion()`. If a question is waiting and an answer for its key is in `answers`, that answer is queued as the next line. In non-interactive mode, a missing answer ends the run with exit code 2.
5. `run({ dialog })` resolves when that dialog ends, with `completed`, `canceled` or `timeout` taken from `vars._status`.

**MCP.** The MCP adapter reads JSON-RPC messages from stdin and writes responses to stdout.

1. A `tools/call` for `chat` becomes a message activity with `channelId: 'mcp'`, the conversation `session:<session>` and the client's name as the user. Calls in the same session are queued. If the agent sent a choice's title, the choice's value is used instead.
2. The replies are collected while the turn runs. Then `getPendingQuestion()` fills in `awaitingInput`, `pendingQuestion` and the choices of the result.
3. A call to a declared tool becomes an event, `tool:<name>`, in a conversation of its own, with the arguments in `message.value`. The arguments are checked against the tool's `inputSchema` first. `bot.toolResult()` sets the structured result.
4. A handler that throws makes the call return `isError: true` with the error message. Thanks to Botkit 4.11, it never leaves the agent waiting.

**Scheduled jobs.** The scheduler's timer runs the jobs that are due.

1. A job bound to a conversation calls `continueConversation()` on the adapter that owns the conversation. That adapter is the CLI adapter for `cli` and the MCP adapter for `mcp`. The scheduler then replaces the activity with an event of the job's type, with the payload in `message.value`.
2. A clock job (with no reference) runs on the scheduler's own `ClockAdapter`, in the conversation `scheduler:<job id>`. What the bot says there goes to the `output` option.
3. Scheduled turns are delivered as interrupts. They run your `controller.on(event)` handlers and leave a dialog that is waiting for an answer untouched.
4. Neither adapter queues `continueConversation()` turns behind user input. A reminder can therefore arrive while a person is in the middle of a dialog, and a scheduled job never waits for a slow turn.

## Designing dialogs for non-chat surfaces

Dialogs written for chat usually work unchanged. These habits make them work well on every surface:

**Put answers in `text`.** BotkitConversation matches and stores only the text of an answer. If a message has no text, for example a form post that carries only `value`, the collected variable becomes the whole activity and no pattern matches. The CLI and MCP adapters always send the chosen value as `text`. Custom adapters should do the same.

**Use triple mustaches for anything that is not HTML.** `{{vars.url}}` is HTML-escaped, so `https://example.com/?a=1` renders as `https:&#x2F;&#x2F;example.com&#x2F;?a&#x3D;1`. Use `{{{vars.url}}}` in templates that hold URLs, quotes or code. The CLI and MCP adapters decode the entities that mustache adds, but other channels such as SMS, email or JSON do not. As of Botkit 4.11, strings inside arrays in `channelData`, `attachments` and `quick_replies` are rendered too, so templates such as `channelData: { tags: ['{{{vars.team}}}'] }` work.

**Give every `ask()` a key.** The key is how the outside world names a question. An answers file answers `service`, `--non-interactive` reports `Missing answer for "service"`, and an agent reads `pendingQuestion.key`. A question asked with a `null` key still works in chat, but it cannot be answered unattended or described to an agent.

```javascript
deploy.ask({ text: ['Which service?'], quick_replies: services.map((name) => ({ title: name, payload: name })) }, [
    { pattern: '^(api|billing|search)$', handler: async (answer, convo) => convo.setVar('service', answer.toLowerCase()) },
    { default: true, handler: async (answer, convo, bot) => { await bot.say(`Unknown service "${ answer }".`); await convo.repeat(); } }
], 'service');
```

Offer the valid answers as quick replies. The CLI shows them as a numbered menu, and agents receive them as `choices`. Validate with patterns and `convo.repeat()` anyway, because a person can type anything and an agent can send anything. Store the canonical value with `convo.setVar()` when patterns ignore case.

**Keep events away from pending questions.** While a dialog waits for an answer, any activity in that conversation is taken as the answer, events included, and the `on()` handlers for it do not fire. Two patterns avoid this:

* Use `controller.interrupts()` for events that must work mid-dialog. The scheduler does this for every job event, which is why a reminder can arrive during a deploy without answering the question.
* Send events to a conversation of their own. The MCP adapter runs each declared tool call in a unique conversation, `tool:<name>:<n>`, for this reason.

**Use `addAction('stop')` to cancel.** A thread that ends with `addAction('stop')` finishes the dialog with `vars._status` set to `'canceled'`. `addAction('complete')` sets `'completed'` and `addAction('timeout')` sets `'timeout'`. The CLI's `run()` turns these into `canceled` (exit code 1) and `completed` (exit code 0), and `controller.afterDialog()` handlers can check them. Calling `convo.stop()` inside a handler ends the dialog without setting `_status`.

```javascript
deploy.addMessage('Confirmation did not match. Deploy canceled.', 'canceled');
deploy.addAction('stop', 'canceled');

controller.afterDialog('deploy', async (bot, results) => {
    if (results._status === 'completed') {
        audit.push({ service: results.service, env: results.env, user: results.user });
    }
});
```

Give people and agents a way out as well. While a dialog waits for an answer, it takes every message, so commands such as `help` never reach `hears()`. Ops Desk lists a `cancel` handler first at every question, which sends the dialog to a thread that also ends with `addAction('stop')`:

```javascript
const cancel = { pattern: '^(cancel|stop)$', handler: async (answer, convo) => convo.gotoThread('aborted') };
deploy.ask({ text: ['Which service?'] }, [cancel, /* the other answers */], 'service');

deploy.addMessage('Deploy canceled.', 'aborted');
deploy.addAction('stop', 'aborted');
```

**Let handlers fail loudly.** With Botkit 4.11, an error thrown by a handler rejects the turn. The CLI prints it, or ends an unattended run with status `failed`. The MCP adapter returns it to the agent with `isError`, and the scheduler records it on the job and emits `scheduler_error`. Do not wrap handlers in try/catch just to keep the process alive. Catch only the errors you can explain to the user, as Ops Desk does when a reminder cannot be scheduled.

**Ask Botkit what it is waiting for.** If you build your own surface, such as a form, a kiosk or a queue consumer, call `controller.getPendingQuestion(context)` after each turn. Do not read dialog internals. It returns the dialog id, thread, key, the raw template (including its quick replies) and a copy of the dialog's variables, or null when no question is waiting. [How to build a new adapter](advanced.md#how-to-build-a-new-adapter) shows where it fits.

## Reference

* [Command Line (CLI) platform guide](platforms/cli.md) and [class reference](reference/cli.md)
* [AI Agents (MCP) platform guide](platforms/mcp.md) and [class reference](reference/mcp.md)
* [Botkit Scheduler Plugin guide](plugins/scheduler.md) and [class reference](reference/scheduler.md)
* [controller.getPendingQuestion()](reference/core.md#getPendingQuestion) and [BotkitPendingQuestion](reference/core.md#BotkitPendingQuestion)
* [Botkit Conversations](conversations.md)
* [How to build a new adapter](advanced.md#how-to-build-a-new-adapter)
* [Ops Desk example](https://github.com/howdyai/botkit/tree/main/packages/examples/ops-desk)
