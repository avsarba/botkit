# Ops Desk

Ops Desk is a small operations bot. It handles deploys, fleet status, reminders, health watches and a nightly report for three fake services: `api`, `billing` and `search`.

It never touches a chat platform. The same Botkit features run three ways:

| Surface | Command | Adapter |
|--- |--- |---
| A person in a terminal | `node ops-desk/cli.js` | [botbuilder-adapter-cli](../../botbuilder-adapter-cli) |
| An unattended CI step | `node ops-desk/cli.js --run deploy --answers ops-desk/answers.json --non-interactive` | [botbuilder-adapter-cli](../../botbuilder-adapter-cli) |
| An AI agent, such as Claude Code | `node ops-desk/mcp.js` | [botbuilder-adapter-mcp](../../botbuilder-adapter-mcp) |

The clock is a fourth kind of user. [botkit-plugin-scheduler](../../botkit-plugin-scheduler) fires reminders and health checks as ordinary Botkit turns in whichever conversation asked for them. It also runs a nightly report that belongs to no conversation.

Everything runs offline. It needs no credentials and no network, and it uses no dependencies beyond the Botkit packages in this repository.

## Run it

From the root of the Botkit repository, install and build the packages once:

```bash
npm install
npm run build
cd packages/examples
```

### 1. In the terminal

```bash
node ops-desk/cli.js
```

Type commands, pick menu entries by number or title, and press Ctrl+D or type `/quit` to leave. Try `help`, then `/help` for the adapter's own commands. `/state` shows the question the bot is waiting on, and `cancel` at any question leaves the deploy dialog.

```text
bot> Ops Desk ready. Pick one or type "help".
     [1] Deploy  [2] Status  [3] Help
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
you> remind me in 2 seconds to check the logs
bot> OK, I will remind you in 2 seconds: check the logs.
you> watch
bot> Watching fleet health every 30s. Say "unwatch" to stop.
you> jobs
bot> job-1032720d  reminder  next 2026-09-27T20:13:57.328Z
     watch:cli-0ab14f4b:ann  health_check  next 2026-09-27T20:14:25.329Z
bot> Reminder: check the logs
you> break search
bot> Simulated an outage of search.
you> unwatch
bot> Stopped watching.
you> /quit
```

The reminder arrives on its own, two seconds after it was set. After `watch`, and while `search` is broken, `ALERT: search is unhealthy` appears every 30 seconds.

Commands can also be piped in, which is handy in scripts:

```bash
printf 'status\n/quit\n' | node ops-desk/cli.js
```

Add `--json` to get one JSON object per line, for other programs:

```bash
printf 'status\n' | node ops-desk/cli.js --json
```

```text
{"type":"message","text":"Ops Desk ready. Pick one or type \"help\".","choices":[{"title":"Deploy","value":"deploy"},{"title":"Status","value":"status"},{"title":"Help","value":"help"}],"to":"ann","conversation":"cli-482966b1"}
{"type":"message","text":"SERVICE  STAGING  PRODUCTION  HEALTH\napi      2.3.1    2.3.0       healthy\nbilling  1.4.2    1.4.1       healthy\nsearch   0.9.8    0.9.8       healthy","to":"ann","conversation":"cli-482966b1"}
```

All options:

| Option | Meaning
|--- |---
| `--run <dialog>` | Run one dialog, such as `deploy`, from start to finish, then exit with its status
| `--answers <file>` | Answer dialog questions from a JSON file, keyed by question key
| `--non-interactive` | Never wait for a person: fail with exit code 2 when an answer is missing
| `--json` | Write one JSON object per line instead of text
| `--user <name>` | The user id to talk as. Defaults to `$USER`
| `-h`, `--help` | Show the options

### 2. As an unattended CI step

Every question in the deploy dialog has a key: `service`, `env` and `confirm`. [answers.json](answers.json) answers them:

```json
{
  "service": "billing",
  "env": "production",
  "confirm": "billing"
}
```

The same wizard a person walks through then runs with nobody at the keyboard:

```bash
node ops-desk/cli.js --run deploy --answers ops-desk/answers.json --non-interactive
```

```text
bot> Which service?
     [1] api  [2] billing  [3] search
you> billing (from answers)
bot> Deploy billing to which environment?
     [1] Staging  [2] Production
you> production (from answers)
bot> Type the service name (billing) to confirm a PRODUCTION deploy.
you> billing (from answers)
bot> Deployed billing 1.4.2 to production.
```

The exit code tells the pipeline what happened:

| Exit code | Meaning
|--- |---
| 0 | The dialog completed: the deploy shipped
| 1 | The dialog was canceled (for example, the confirmation did not match), or the run failed with an error
| 2 | An answer was missing, and `--non-interactive` refused to wait. The missing key and its question are printed to stderr: `error: Missing answer for "env": Deploy billing to which environment?`

For example, as a GitHub Actions step:

```yaml
- name: Deploy billing to production
  working-directory: packages/examples
  run: node ops-desk/cli.js --run deploy --answers ops-desk/answers.json --non-interactive
```

Without `--non-interactive`, missing answers are asked for at the keyboard. The same file can therefore pre-fill some questions and leave the rest to a person.

### 3. As an MCP server for AI agents

`ops-desk/mcp.js` serves the bot over the [Model Context Protocol](https://modelcontextprotocol.io) on stdin and stdout. Register it with Claude Code from the root of the repository:

```bash
claude mcp add ops-desk -- node $(pwd)/packages/examples/ops-desk/mcp.js
```

Other MCP clients take the same command in their configuration file:

```json
{
  "mcpServers": {
    "ops-desk": {
      "command": "node",
      "args": ["/abs/path/to/botkit/packages/examples/ops-desk/mcp.js"]
    }
  }
}
```

The agent gets three tools:

* `chat` talks to the bot, exactly as a person does in the terminal. Each result lists the replies, the choices offered and `awaitingInput`. It also names the question the bot is waiting on (`pendingQuestion.key`), so the agent must walk the deploy dialog step by step and answer with the offered values.
* `service_status` (read-only) returns the fleet as structured data: `{ services: [{ name, staging, production, healthy }] }`.
* `list_jobs` (read-only) returns the scheduled jobs, optionally for one chat `session`.

Ask the agent to "deploy search to staging with ops-desk", and it makes calls like these (JSON-RPC over stdio, shortened):

```text
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"chat","arguments":{"message":"deploy"}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"Which service?\nChoices: \"api\", \"billing\", \"search\"\n(Waiting for your answer to \"service\". Call chat again with session \"default\".)"}],
   "structuredContent":{"session":"default","awaitingInput":true,"pendingQuestion":{"dialog":"deploy","thread":"default","key":"service"},"choices":[...],...}}}
→ {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"chat","arguments":{"message":"search"}}}
← ... "Deploy search to which environment?\nChoices: \"Staging\" (send \"staging\"), \"Production\" (send \"production\")" ... "pendingQuestion":{"dialog":"deploy","thread":"default","key":"env"} ...
→ {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"chat","arguments":{"message":"staging"}}}
← {"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"Deployed search 0.9.9 to staging."}],
   "structuredContent":{"session":"default","replies":[...],"proactive":[],"awaitingInput":false,"pendingQuestion":null,"choices":[]}}}
```

A production deploy still asks for the typed confirmation. The agent cannot skip it, because the dialog, not the agent, decides what happens next.

Only JSON-RPC is written to stdout. Anything else the bot or Botkit prints goes to stderr. Start the server with `node`, as above. The package script works too, but only as `npm run -s start:mcp`: without `-s`, npm writes its own banner to stdout before the server starts.

## How scheduled jobs reach each surface

[features/reminders.js](features/reminders.js) calls `bot.schedule({ in: ms, event: 'reminder', payload: { what } })`. The scheduler saves the job together with the conversation reference of the message that asked for it. When the job is due, the scheduler continues that conversation on the adapter that owns it, and `controller.on('reminder')` runs as an ordinary turn:

* **Terminal:** the CLI adapter prints the reminder into the running session, between your own commands.
* **MCP:** the MCP adapter keeps the reminder in the chat session's outbox. The agent's next `chat` call in that session returns it under `proactive` (call with `message: ""` to poll), and it is also sent at once as a `notifications/message` log notification:

  ```text
  ← {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","logger":"botkit","data":{"session":"s2","type":"message","text":"Reminder: rotate keys"}}}
  → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"chat","arguments":{"message":"","session":"s2"}}}
  ← ... "text":"[message received while you were away] Reminder: rotate keys" ... "proactive":[{"type":"message","text":"Reminder: rotate keys"}] ...
  ```
* **The clock itself:** the nightly report in [features/reports.js](features/reports.js) is a cron job with no conversation (a "clock job"). It runs on the scheduler's own clock channel, and what it says goes to the scheduler's `output` hook. Ops Desk writes it to stderr as `[nightly-report] Nightly report: 3/3 services healthy.`

The watch in [features/watch.js](features/watch.js) is a recurring job with the fixed id `watch:<conversation>:<user>`. Saying `watch` again updates the job instead of adding a second one, and `unwatch` cancels it by id.

Scheduled turns reach the bot as interrupts. A reminder that fires while the deploy dialog waits for an answer is delivered without being taken as that answer.

Ops Desk keeps its state in memory, so jobs and dialogs are forgotten when the process exits. To keep them, pass a Botkit storage adapter to `createOpsDesk(adapter, { storage })`, or to `createCli()` or `createMcpServer()`, which take the same options. The scheduler saves its jobs in the same storage as the dialogs.

Jobs and dialogs belong to a conversation, and after a restart the bot finds them only in the same conversation. An MCP chat session keeps its name across restarts (`default`, unless the agent picks another), so that works without extra steps. The CLI, however, starts every run in a new conversation with a random id such as `cli-0ab14f4b`. Give it a fixed conversation along with the storage:

```javascript
const { createCli } = require('./ops-desk/cli');

const cli = createCli({ storage: myStorage, conversation: 'ops-desk' });
```

Without a fixed conversation, a watch from an earlier run keeps printing alerts into the terminal. `jobs` and `unwatch` look only at the current conversation, so they cannot find it or stop it.

## How it is built

```text
                   ┌──────────── features/*.js ─────────────┐
                   │ welcome  deploy  status  reminders     │
                   │ watch    jobs    reports               │
                   └──────────────────┬─────────────────────┘
                               Botkit controller
                    (hears, on, interrupts, BotkitConversation)
          ┌─────────────────┬─────────┴─────────┬──────────────────┐
     CliAdapter         McpAdapter        BotkitScheduler       fleet.js
   (cli.js: stdin/    (mcp.js: JSON-RPC   (reminders, watches,  (fake services,
    stdout, answers)   over stdio)         nightly report)       in memory)
```

| File | What it does
|--- |---
| [opsdesk.js](opsdesk.js) | `createOpsDesk(adapter, options)`: creates the Botkit controller and the scheduler, and loads the features. It returns `{ controller, scheduler, fleet, ready }`.
| [fleet.js](fleet.js) | A deterministic, in-memory fleet: `names()`, `status()`, `table()`, `deploy(name, env)`, `setHealthy(name, healthy)` and an `audit` log
| [cli.js](cli.js) | The terminal entry point. It exports `createCli(options)` and `parseArgs(argv)`.
| [mcp.js](mcp.js) | The MCP entry point. It exports `createMcpServer(options)`, which declares the `service_status` and `list_jobs` tools.
| [answers.json](answers.json) | Answers for an unattended production deploy of billing
| [features/welcome.js](features/welcome.js) | A greeting with a menu when a session starts, `help`, and a reply to unknown commands
| [features/deploy.js](features/deploy.js) | The `deploy` dialog: service, then environment, then a typed confirmation for production, then ship or cancel
| [features/status.js](features/status.js) | `status`, and the `service_status` tool
| [features/reminders.js](features/reminders.js) | `remind me in <n> <seconds\|minutes> to <task>`
| [features/watch.js](features/watch.js) | `watch` and `unwatch`, plus `break <service>` and `fix <service>` to simulate outages
| [features/jobs.js](features/jobs.js) | `jobs`, and the `list_jobs` tool
| [features/reports.js](features/reports.js) | The nightly cron report at 02:00 UTC

A few choices in the deploy dialog make it work on surfaces that are not chat. The [Botkit Beyond Chat guide](../../docs/beyond-chat.md) explains each one:

* Every question has a key, so answers files and `pendingQuestion` can name it.
* Templates use triple mustaches, as in `{{{vars.service}}}`, so no text is HTML-escaped.
* The canceled path ends with `addAction('stop')`, so `run()` reports `canceled` and exit code 1.
* Every question accepts `cancel` (or `stop`) first, so a person or an agent can leave the dialog at any point. It ends with `addAction('stop')` too.
* Answer handlers store the canonical value with `convo.setVar()`, so `PRODUCTION` and `production` both deploy to `production`.

## Test it

```bash
npm test
```

[tests/OpsDesk.tests.js](../tests/OpsDesk.tests.js) drives the bot in-process on PassThrough streams with a fake clock. It covers every surface: the terminal, unattended runs, MCP tool calls, and reminders delivered by `scheduler.tick()`. [tests/Processes.tests.js](../tests/Processes.tests.js) runs `cli.js` and `mcp.js` as real child processes and checks their output and exit codes.
