[&larr; Botkit Documentation](../core.md)  [&larr; Platform Index](index.md) 

# botbuilder-adapter-cli
Connect [Botkit](https://www.npmjs.com/package/botkit) to the command line.

This package contains an adapter that runs a Botkit bot in a terminal, with no tokens, browser or webserver.
Every line typed or piped in runs through the full Botkit pipeline (middleware, `hears()`, `interrupts()`, `on()` and dialogs),
and the bot's replies are printed back. Use it three ways:

* **as a REPL** to try out and demo a bot, with numbered menus for quick replies and slash-commands to send events, switch users and inspect state;
* **as a wizard or installer runtime**: `adapter.run({ dialog })` runs one BotkitConversation from start to finish and resolves with the answers;
* **as a scriptable Unix tool**: the same dialog runs unattended in CI from an answers file, and `format: 'json'` writes one JSON object per line for other programs.

## Install Package

Add this package to your project using npm:

```bash
npm install --save botbuilder-adapter-cli
```

Import the adapter class into your code:

```javascript
const { CliAdapter } = require('botbuilder-adapter-cli');
```

## Use CliAdapter in your App

CliAdapter works with Botkit only. Pass it to the Botkit constructor with `disable_webserver: true`, since a terminal app needs no webserver,
and `disable_console: true`, so Botkit's startup messages do not appear in the conversation.
By default the adapter reads `process.stdin` as soon as Botkit is ready, and it shuts Botkit down when the input ends or the user types `/quit`, so the process exits by itself.

[A full description of the CliAdapter options and example code can be found in the class reference docs.](../reference/cli.md#create-a-new-cliadapter)

### A terminal REPL

```javascript
const { Botkit } = require('botkit');
const { CliAdapter } = require('botbuilder-adapter-cli');

const adapter = new CliAdapter();
const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });

controller.on('conversationUpdate', async (bot, message) => {
    await bot.reply(message, 'Welcome! Type "deploy" to start, or /help for commands.');
});

controller.hears('deploy', 'message', async (bot, message) => {
    await bot.reply(message, {
        text: 'Which environment?',
        quick_replies: [{ title: 'Staging', payload: 'staging' }, { title: 'Production', payload: 'production' }]
    });
});
```

```text
$ node bot.js
bot> Welcome! Type "deploy" to start, or /help for commands.
you> deploy
bot> Which environment?
     [1] Staging  [2] Production
you> 2
```

Typing `2` (or `production`, ignoring case) sends the choice's value, `production`, as the message text, so dialogs and `hears()` patterns work unchanged.

### A wizard with run()

`adapter.run({ dialog })` starts a [BotkitConversation](../conversations.md) from the beginning (canceling any dialog left pending in the conversation) and resolves when it ends.
By default the session then ends too. The result holds the dialog's variables and a suggested exit code:

```javascript
const { Botkit, BotkitConversation } = require('botkit');
const { CliAdapter } = require('botbuilder-adapter-cli');

const adapter = new CliAdapter();
const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });

const setup = new BotkitConversation('setup', controller);
setup.ask({
    text: ['Which database?'],
    quick_replies: [{ title: 'PostgreSQL', payload: 'postgres' }, { title: 'SQLite', payload: 'sqlite' }],
    channelData: { default: 'sqlite' }
}, [], 'db');
setup.ask('Admin password (8+ chars)?', async (answer, convo, bot) => {
    if (answer.length < 8) {
        await bot.say('Too short.');
        await convo.repeat();
    }
}, 'password');
setup.say('Setting up {{{vars.app}}} with {{vars.db}}.');
controller.addDialog(setup);

adapter.run({ dialog: 'setup', vars: { app: 'acme' } }).then((result) => {
    // result = { status: 'completed', exitCode: 0, vars: { app: 'acme', db: 'sqlite', password: '...', ... } }
    process.exitCode = result.exitCode;
});
```

`channelData.default` marks a choice as `(default)`; pressing Enter on an empty line picks it.

If your code awaits I/O (such as loading a config file) before it calls `run()`, create the adapter with `autoStart: false`,
so that the session does not start and send its greeting before `run()` is called.

### Unattended in CI

The same wizard runs without a person when you pass `answers`, keyed by each question's `key`.
A string answers once; an array answers the same question several times, in order (for example when a validation handler calls `convo.repeat()`).
An answer may be a choice's value, its title or its number, and an empty string asks for the question's default.

With `nonInteractive: true`, a question that has no answer (and no more queued input) uses its default, or the run fails with exit code 2 and
`error: Missing answer for "<key>": <question>` on stderr. Because a string answer is used only once, a bad answer in a validation loop ends the run instead of looping forever.
Turn errors also end a non-interactive session with status `failed`.

```javascript
const adapter = new CliAdapter({
    answers: JSON.parse(fs.readFileSync('answers.json', 'utf8')), // { "db": "sqlite", "password": "hunter2222" }
    nonInteractive: !process.stdin.isTTY
});
```

```text
$ node install.js < /dev/null
bot> Which database?
     [1] PostgreSQL  [2] SQLite (default)
you> sqlite (from answers)
bot> Admin password (8+ chars)?
you> hunter2222 (from answers)
bot> Setting up acme with sqlite.
$ echo $?
0
```

| Status | Meaning | exitCode
|--- |--- |---
| completed | The dialog finished | 0
| canceled | The dialog stopped (`addAction('stop')`) | 1
| timeout | The dialog timed out (`addAction('timeout')`) | 1
| eof | The input ended | 0, or 1 if the requested dialog had not finished
| quit | `/quit`, `/exit` or `adapter.close()` | 0, or 1 if the requested dialog had not finished
| interrupted | Ctrl+C in terminal mode | 130
| failed | A turn failed (`error` is set), or an answer was missing | 1, or 2 for a missing answer

### Piping JSON

With `format: 'json'`, each message the bot sends is written as one line of JSON, and no prompts or echoes are written.
For the REPL example above, started with `new CliAdapter({ format: process.argv.includes('--json') ? 'json' : 'text' })`:

```text
$ echo "deploy" | node bot.js --json
{"type":"message","text":"Welcome! Type \"deploy\" to start, or /help for commands.","to":"ann","conversation":"cli-5f2c9a1b"}
{"type":"message","text":"Which environment?","choices":[{"title":"Staging","value":"staging"},{"title":"Production","value":"production"}],"to":"ann","conversation":"cli-5f2c9a1b"}
```

Each object has `type`, `text`, `choices`, `attachments` (`[{ contentType, name, url, content }]`), `data` (other `channelData` fields),
`name` and `value` (events only), `to` and `conversation`; fields without a value are left out. Command output is written as `{"type":"cli","command":"<name>","lines":[...]}`,
and errors still go to stderr as plain text. When the output is `process.stdout`, `console.log()` and friends are sent to stderr so they cannot corrupt the stream.

### Testing with submit()

`adapter.submit(line)` processes one line as if it had been typed and resolves with the lines it printed, which makes offline tests easy:

```javascript
const { PassThrough } = require('stream');
const adapter = new CliAdapter({ input: new PassThrough(), output: new PassThrough(), autoStart: false, color: false, user: 'ann' });
const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
controller.hears('hello', 'message', async (bot, message) => { await bot.reply(message, 'Hi Ann!'); });

assert.deepStrictEqual(await adapter.submit('hello'), ['bot> Hi Ann!']);
```

### Commands

| Command | Description
|--- |---
| `/help` | List the commands, including custom ones
| `/quit`, `/exit` | End the session (status `quit`)
| `/event <name> [json]` | Send an event. A JSON object payload is also spread into the message, so `/event build_finished {"build":"#412"}` fires `controller.on('build_finished')` with `message.build` and `message.value.build`
| `/as <user>` | Continue as another user. Each user has their own dialog state
| `/new [id]` | Start a new conversation, with a random id if none is given
| `/state` | Show the question the bot is waiting on and the variables collected so far
| `/raw` | Show the last activity the bot sent, as JSON
| `/json <activity>` | Send an activity written as JSON, such as `/json {"text":"hi","value":{"x":1}}`
| `\<text>` | Send the text exactly as typed: `\2` sends `2` even when a menu is showing, and `\/help` sends `/help`

Add your own with the `commands` option. A command returns a string or an array of strings to print:

```javascript
const adapter = new CliAdapter({
    commands: {
        deploy: { description: 'Show deploy status', run: async (args, cli) => `deploys for ${ args || 'all services' }: none running` },
        whoami: (args, cli) => cli.user
    }
});
```

A `/word` that is not a command is sent to the bot as text. In terminal mode, Tab completes command names.

### How messages are shown

* A message starts with `bot> ` (the `botName` option), or `bot (to bob)> ` when it is addressed to someone other than the current user. Following lines are indented to match.
* Quick replies (`channelData.quick_replies`, as used by `bot.reply()` and dialog templates) or suggested actions become one numbered menu line: `[1] Staging  [2] Production`.
  Hero and thumbnail card buttons become the menu when there are no quick replies.
* Hero and thumbnail cards show as `[card] Title - Subtitle`, their text and `[image] <url>`; adaptive cards as `[adaptive card]`; files as `[image/png] name <url>`.
  A carousel numbers its attachments `(1/3)`.
* `typing`, `delay` and `trace` activities are not shown. Delays pause the output when `honorDelays` is set (by default, when the output is a terminal), up to `maxDelay`.
* A `progress` event, as sent by `bot.progress(3, 10, 'Migrating')`, shows as `[###-------] 30% Migrating`. Other events show as `[event <name>] <json value>`.
* Mustache escapes `{{vars.x}}` as HTML (`https:&#x2F;&#x2F;...`). The adapter decodes these entities in what it prints, but other adapters do not,
  so prefer `{{{vars.x}}}` (triple braces) for URLs and text with quotes in templates that other platforms also use.

### Options

| Option | Default | Description
|--- |--- |---
| input | `process.stdin` | Stream to read lines from
| output | `process.stdout` | Stream to write the bot's messages to
| errorOutput | `process.stderr` | Stream to write errors to
| user | `$USER`, `$USERNAME` or `'user'` | The user id (`message.user`)
| conversation | random `cli-xxxxxxxx` | The conversation id (`message.channel`)
| prompt | `'you> '` | The prompt, also used to echo input
| botName | `'bot'` | The name in front of bot messages
| format | `'text'` | `'text'` or `'json'`
| color | output is a TTY and `NO_COLOR` is not set | ANSI colors
| terminal | input and output are TTYs | Readline terminal mode: prompt, line editing, history, Tab completion of commands and Ctrl+C. When false, each line read is echoed as `you> <line>`
| greeting | `true` | Send `conversationUpdate` with `membersAdded: [{ id: user }]` when the session starts (not for `run({ dialog })`)
| answers | `{}` | Answers for dialog questions, keyed by question key
| nonInteractive | `false` | Never wait for a person: use defaults or fail
| honorDelays | output is a TTY | Pause for `delay` activities
| maxDelay | `3000` | Longest pause in milliseconds
| turnTimeout | `30000` | Longest turn in milliseconds before it fails with `TurnTimeoutError`; 0 disables it
| commands | `{}` | Custom slash-commands
| autoStart | `true` | Start reading input when Botkit is ready
| shutdownOnClose | `true` | Call `controller.shutdown()` when the session ends
| unescapeHtml | `true` | Decode the HTML entities mustache adds
| verbose | `false` | Show extra `channelData` as `data: <json>`, and error stacks
| redirectConsole | `format` is `'json'` and output is `process.stdout` | Send `console.log`, `info`, `debug` and `dir` to `errorOutput` until the session closes

### Things to know

* **Events and pending questions.** While a dialog is waiting for an answer, any activity in that conversation, including an event sent with `/event`, is taken as the answer
  (with no text), and `controller.on()` handlers for it do not fire. `/event` warns you when this will happen. Handle events that must work mid-dialog with `controller.interrupts()`,
  or send them to another conversation.
* **Turns run one at a time.** Lines are queued and processed strictly in order, so piped input never produces overlapping turns.
  Turns started by `adapter.continueConversation()` (for example by a scheduler) are not queued and run immediately.
* **Turns time out.** A turn that takes longer than `turnTimeout` fails with a `TurnTimeoutError`, and the next line is processed. The slow handler keeps running in the background.
* **Errors do not end an interactive session.** A failing handler prints `error: <message>` and the session carries on. In non-interactive mode or during `run({ dialog })`, the run ends with status `failed`.
* **Proactive messages** from `bot.startConversationWithUser()` or `bot.changeContext(adapter.getReference())` are printed straight away; in terminal mode the prompt and any half-typed line are redrawn below them.

## Class Reference

* [CliAdapter](../reference/cli.md#CliAdapter)
* [CliBotWorker](../reference/cli.md#CliBotWorker)
* [CliAdapterOptions](../reference/cli.md#CliAdapterOptions)
* [CliRunOptions](../reference/cli.md#CliRunOptions)
* [CliRunResult](../reference/cli.md#CliRunResult)

## Event List

| Event | Description
|--- |---
| message | a line of text typed by the user. When the line picks a menu choice, `message.text` and `message.value` hold the choice's value and `message.cli_choice` is `{ index, title, value }` (index counts from 0)
| conversationUpdate | sent once when the session starts, unless `greeting` is false. `message.incoming_message.membersAdded[0].id` is the user
| cli_run | sent by `adapter.run({ dialog })` and handled by the adapter with an interrupt that cancels any pending dialog and begins the requested one
| _any name_ | a custom event sent with `/event <name> [json]` or `/json`

## Botkit Extensions

In Botkit handlers, the `bot` worker for the command line contains [all of the base methods](../reference/core.md) as well as the following platform-specific extensions:

### [bot.progress()](../reference/cli.md#progress)

Show a progress bar such as `[###-------] 30% Migrating`.

```javascript
controller.hears('migrate', 'message', async (bot, message) => {
    for (let done = 0; done <= 10; done++) {
        await bot.progress(done, 10, 'Migrating');
    }
});
```

### [bot.startConversationWithUser()](../reference/cli.md#startConversationWithUser)

Point a bot at the terminal session to print messages from outside a turn, for example from a timer:

```javascript
const bot = await controller.spawn();
await bot.startConversationWithUser();
await bot.say('The nightly build finished.');
```

### [bot.cli](../reference/cli.md#CliBotWorker)

The CliAdapter, to read `bot.cli.user` and `bot.cli.conversationId`.

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

