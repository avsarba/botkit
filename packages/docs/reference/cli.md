# Botkit for the Command Line Class Reference

[&larr; Botkit Documentation](../core.md) [&larr; Class Index](index.md) 

This is a class reference for all the methods exposed by the [botbuilder-adapter-cli](https://github.com/howdyai/botkit/tree/master/packages/botbuilder-adapter-cli) package.

## Classes


* <a href="#CliAdapter" aria-current="page">CliAdapter</a>
* <a href="#CliBotWorker" aria-current="page">CliBotWorker</a>

## Interfaces

* <a href="#CliAdapterOptions" aria-current="page">CliAdapterOptions</a>
* <a href="#CliChoice" aria-current="page">CliChoice</a>
* <a href="#CliRunOptions" aria-current="page">CliRunOptions</a>
* <a href="#CliRunResult" aria-current="page">CliRunResult</a>
* <a href="#RenderOptions" aria-current="page">RenderOptions</a>
* <a href="#RenderedActivity" aria-current="page">RenderedActivity</a>

---

<a name="CliAdapter"></a>
## CliAdapter
Connect [Botkit](https://www.npmjs.com/package/botkit) to the command line.
Every line typed (or piped) becomes a message that runs through the full Botkit pipeline: middleware, `hears()`, `interrupts()`,
`on()` handlers and BotkitConversation dialogs. Replies are printed as `bot> ...`, quick replies become numbered menus,
and slash-commands send events, switch users or conversations and show state.

The same bot can run as an interactive REPL, as a wizard or installer ([run()](#run) with a dialog),
as a scripted CI step (`answers` and `nonInteractive`), or as a Unix filter (`format: 'json'`).
This adapter works with Botkit only: pass it to `new Botkit({ adapter })`.

To use this class in your application, first install the package:
```bash
npm install --save botbuilder-adapter-cli
```

Then import this and other classes into your code:
```javascript
const { CliAdapter } = require('botbuilder-adapter-cli');
```

This class includes the following methods:
* [close()](#close)
* [continueConversation()](#continueConversation)
* [deleteActivity()](#deleteActivity)
* [getReference()](#getReference)
* [idle()](#idle)
* [init()](#init)
* [processActivity()](#processActivity)
* [run()](#run)
* [sendActivities()](#sendActivities)
* [start()](#start)
* [submit()](#submit)
* [updateActivity()](#updateActivity)



### Create a new CliAdapter()
**Parameters**

| Argument | Type | Description
|--- |--- |---
| options | [CliAdapterOptions](#CliAdapterOptions) | An optional [CliAdapterOptions](#CliAdapterOptions) object.<br/>

Create an adapter that reads messages from a stream (stdin by default) and writes the bot's replies to another (stdout by default).

An interactive terminal bot:
```javascript
const { Botkit } = require('botkit');
const { CliAdapter } = require('botbuilder-adapter-cli');

const adapter = new CliAdapter();
const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });

controller.hears('hello', 'message', async (bot, message) => {
    await bot.reply(message, 'Hi there!');
});
```

A scripted installer that fails fast in CI:
```javascript
const adapter = new CliAdapter({ answers: require('./answers.json'), nonInteractive: !process.stdin.isTTY });
const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
controller.addDialog(setupDialog);
adapter.run({ dialog: 'setup' }).then((result) => { process.exitCode = result.exitCode; });
```



## Properties and Accessors

| Name | Type | Description
|--- |--- |---
| conversationId | string | The id of the current conversation, sent as `conversation.id` (`message.channel`). `/new` changes it.
| user | string | The id of the user at the keyboard, sent as `from.id` (`message.user`). `/as <user>` changes it.

## CliAdapter Class Methods
<a name="close"></a>
### close()
End the session: stop reading input, drop queued lines (their `submit()` promises reject), restore the console,
and resolve an active [run()](#run) with status `quit`. It does not call `controller.shutdown()`; Botkit calls this method on shutdown.



```javascript
controller.hears('bye', 'message', async (bot, message) => {
    await bot.reply(message, 'Goodbye!');
    bot.cli.close();
});
```

<a name="continueConversation"></a>
### continueConversation()
Standard BotBuilder adapter method for continuing an existing conversation based on a conversation reference.
The turn runs immediately and is not queued behind typed input, so a scheduler can fire jobs while a turn is running.
Its messages are printed as they are sent.
[BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#continueconversation)

**Parameters**

| Argument | Type | description
|--- |--- |---
| reference| Partial&lt;ConversationReference&gt; | A conversation reference to be applied to future messages.
| logic|  | A bot logic function that will perform continuing action in the form `async(context) => { ... }`<br/>



<a name="deleteActivity"></a>
### deleteActivity()
Standard BotBuilder adapter method to delete a previous message. The CLI prints `(deleted message <id>)`.

**Parameters**

| Argument | Type | description
|--- |--- |---
| context| TurnContext | A TurnContext representing the current incoming message and environment.
| reference| Partial&lt;ConversationReference&gt; | A reference to the deleted activity.<br/>



<a name="getReference"></a>
### getReference()
Build a conversation reference for the terminal session, for use with `bot.changeContext()`.
[CliBotWorker.startConversationWithUser()](#startConversationWithUser) uses it.

**Parameters**

| Argument | Type | description
|--- |--- |---
| user (optional)| string | The user id to address. Defaults to the current user.<br/>


**Returns**

A reference with `channelId: 'cli'`, the current conversation, the user and the bot.




```javascript
const bot = await controller.spawn();
await bot.changeContext(adapter.getReference());
await bot.say('Background job finished.');
```

<a name="idle"></a>
### idle()
Wait until every queued line and turn, including answers that turns queue, has been processed.


**Returns**

A promise that resolves when the input queue is empty and no turn is running.




```javascript
input.write('hello\n');
await adapter.idle();
```

<a name="init"></a>
### init()
Botkit-only: called automatically by Botkit when the adapter is passed to `new Botkit({ adapter })`.
Registers the `cli_run` interrupt used by [run()](#run), closes the session on `controller.shutdown()`,
and, unless `autoStart` is false, calls [start()](#start) once Botkit is ready.

**Parameters**

| Argument | Type | description
|--- |--- |---
| botkit| Botkit | The Botkit controller.<br/>



<a name="processActivity"></a>
### processActivity()
The CLI adapter does not accept HTTP requests: this answers any webhook request with status 405 and a JSON error,
so a Botkit webserver never throws.

**Parameters**

| Argument | Type | description
|--- |--- |---
| req| any | A request object from Restify or Express
| res| any | A response object from Restify or Express
| logic| any | A bot logic function (not used)<br/>



<a name="run"></a>
### run()
Run the session, or run one dialog from start to finish, and resolve with how it ended.

**Parameters**

| Argument | Type | description
|--- |--- |---
| options (optional)| [CliRunOptions](#CliRunOptions) | An optional [CliRunOptions](#CliRunOptions) object.<br/>


**Returns**

A [CliRunResult](#CliRunResult). Rejects if a run is already in progress, the session is closed or the dialog is unknown.




With a `dialog`, any dialog pending in the conversation is canceled and the dialog begins fresh with `vars`.
Its questions are answered by the person at the keyboard, by the `answers` option, or, when `nonInteractive` is set, by their defaults.
The run resolves when the dialog ends (`completed`, `canceled` or `timeout`), and then, unless `closeOnComplete` is false, the session ends too.
It also resolves if the session ends first (`eof`, `quit`, `interrupted` or `failed`).
The `answers` are reset at the start of each run with a dialog.

Without a `dialog`, the promise resolves when the session ends. Starts the session if needed; the greeting is sent only without a dialog.
If your code awaits I/O before calling `run()`, create the adapter with `autoStart: false`, or the session may start (and greet) first.

```javascript
// An installer that also runs unattended in CI:
// node install.js --answers answers.json --non-interactive
const result = await adapter.run({ dialog: 'setup', vars: { app: 'acme' } });
if (result.status === 'completed') {
    writeConfig(result.vars);
}
process.exitCode = result.exitCode;
```

<a name="sendActivities"></a>
### sendActivities()
Standard BotBuilder adapter method to send messages from the bot. Messages are rendered and written to the output;
`typing` and `trace` activities are not shown, and `delay` activities pause when `honorDelays` is set.
[BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#sendactivities).

**Parameters**

| Argument | Type | description
|--- |--- |---
| context| TurnContext | A TurnContext representing the current incoming message and environment.
| activities|  | An array of outgoing activities to be written to the terminal.<br/>


**Returns**

One `{ id: 'cli-out-<n>' }` for each activity.



<a name="start"></a>
### start()
Start reading input. Each line becomes a turn, processed strictly one at a time.
Called automatically unless `autoStart` is false; calling it again does nothing.
When the input ends, the queued turns (including answers they trigger) finish first, then the session ends with status `eof`.

**Parameters**

| Argument | Type | description
|--- |--- |---
| options (optional)|  | Set `greeting` to override the adapter's `greeting` option for this start.<br/>



```javascript
const adapter = new CliAdapter({ autoStart: false });
const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
// ... register handlers ...
adapter.start();
```

<a name="submit"></a>
### submit()
Process one line exactly as if it had been typed, after any lines already queued.
Commands, choice numbers and titles, defaults and backslash escapes all apply.
Resolves with the lines this input produced (bot replies and command output, with ANSI colors removed),
which are also written to the output. Messages the bot sends outside the turn (proactive messages) are not included.
In JSON format, each line is a JSON string.

**Parameters**

| Argument | Type | description
|--- |--- |---
| line| string | The text of the line.<br/>


**Returns**

The output lines. Rejects if the turn fails or the session is closed.




Do not await `submit()` inside a bot handler or a custom command: it waits for the queue, which is waiting for that handler.

```javascript
const lines = await adapter.submit('hello');
assert.deepStrictEqual(lines, ['bot> Hi Ann!']);
```

<a name="updateActivity"></a>
### updateActivity()
Standard BotBuilder adapter method to update a previous message. The CLI prints the new text as `bot> (edited) <text>`.

**Parameters**

| Argument | Type | description
|--- |--- |---
| context| TurnContext | A TurnContext representing the current incoming message and environment.
| activity| Partial&lt;Activity&gt; | The updated activity.<br/>




<a name="CliBotWorker"></a>
## CliBotWorker
This is a specialized version of [Botkit's core BotWorker class](core.md#BotWorker) that includes additional methods for the command line.
It includes all functionality from the base class, as well as the extension methods below.

When using the CliAdapter with Botkit, all `bot` objects passed to handler functions will include these extensions.

To use this class in your application, first install the package:
```bash
npm install --save botbuilder-adapter-cli
```

Then import this and other classes into your code:
```javascript
const { CliBotWorker } = require('botbuilder-adapter-cli');
```

This class includes the following methods:
* [progress()](#progress)
* [startConversationWithUser()](#startConversationWithUser)



### Create a new CliBotWorker()
**Parameters**

| Argument | Type | Description
|--- |--- |---
| controller | [Botkit](core.md#Botkit) | A pointer to the main Botkit controller
| config | any | An object typically containing { dialogContext, reference, context, activity }<br/>

Create a new BotWorker instance. Do not call this directly - instead, use [controller.spawn()](core.md#spawn).



## Properties and Accessors

| Name | Type | Description
|--- |--- |---
| cli | [CliAdapter](#CliAdapter) | The CliAdapter this bot talks through. Use it to read the current user and conversation, or to submit input from code.

## CliBotWorker Class Methods
<a name="progress"></a>
### progress()
Show a progress bar in the terminal, such as `[###-------] 30% Migrating`.
This sends an event activity `{ type: 'event', name: 'progress', value: { done, total, label } }`,
which the text format renders as a progress bar and the JSON format passes through as an event.

**Parameters**

| Argument | Type | description
|--- |--- |---
| done| number | The amount of work finished.
| total| number | The total amount of work.
| label (optional)| string | An optional label shown after the percentage.<br/>


**Returns**

The result of `bot.say()`.




```javascript
controller.hears('migrate', 'message', async (bot, message) => {
    for (let done = 0; done <= 10; done++) {
        await bot.progress(done, 10, 'Migrating');
        await migrateBatch(done);
    }
    await bot.reply(message, 'Migration complete.');
});
```

<a name="startConversationWithUser"></a>
### startConversationWithUser()
Point this bot at the terminal session, so that `bot.say()` prints into it from outside a turn,
for example from a timer or a scheduled job. Messages to a user other than the current one are shown as `bot (to <user>)> ...`.

**Parameters**

| Argument | Type | description
|--- |--- |---
| user (optional)| string | The id of the user to address. Defaults to the current user of the session.<br/>


**Returns**

This bot, with its context changed.




```javascript
const bot = await controller.spawn();
await bot.startConversationWithUser();
await bot.say('The build finished.');
```




<a name="CliAdapterOptions"></a>
## Interface CliAdapterOptions
Options passed to the CliAdapter constructor. Every option is optional.

**Fields**

| Name | Type | Description
|--- |--- |---
| answers |  | Answers for dialog questions, keyed by the question's `key`. A string answers once; an array answers several times in order.<br/>The value may be a choice's value, its title or its number. Used after every turn in which a question is waiting.<br/>
| autoStart | boolean | Start reading input automatically once Botkit is ready. Defaults to true. Set to false to call [start()](#start) or [run()](#run) yourself.<br/>
| botName | string | The name in front of bot messages, as in `bot> Hello`. Defaults to `'bot'`.<br/>
| color | boolean | Use ANSI colors. Defaults to true when the output is a TTY and the `NO_COLOR` environment variable is not set.<br/>
| commands |  | Custom slash-commands, keyed by name without the slash. Each is a function `(args, adapter) => result` or an object `{ description, run }`;<br/>a returned string or array of strings is printed, and `/help` lists the descriptions.<br/>
| conversation | string | The conversation id (`message.channel`). Defaults to a random id such as `cli-1a2b3c4d`, so every session starts fresh. Change it later with `/new`.<br/>
| errorOutput | WritableStream | The stream errors are written to. Defaults to `process.stderr`.<br/>
| format |  | `'text'` for people, or `'json'` to write one JSON object per line for programs. Defaults to `'text'`.<br/>
| greeting | boolean | Send a `conversationUpdate` activity with `membersAdded: [{ id: user }]` when the session starts. Defaults to true.<br/>
| honorDelays | boolean | Pause for `delay` activities. Defaults to true when the output is a TTY.<br/>
| input | ReadableStream | The stream to read user input from, one line per message. Defaults to `process.stdin`.<br/>
| maxDelay | number | The longest pause for a `delay` activity, in milliseconds. Defaults to 3000.<br/>
| nonInteractive | boolean | Never wait for a person: when a question has no answer in `answers` (and no more input is queued), use its `channelData.default`<br/>or end the session with status `failed` and exit code 2. Turn errors also end the session. Defaults to false.<br/>
| output | WritableStream | The stream the bot's messages are written to. Defaults to `process.stdout`.<br/>
| prompt | string | The prompt shown in terminal mode and used to echo input. Defaults to `'you> '`.<br/>
| redirectConsole | boolean | Send `console.log`, `console.info`, `console.debug` and `console.dir` to `errorOutput` until the session closes,<br/>so they cannot corrupt the output. Defaults to true when `format` is `'json'` and the output is `process.stdout`.<br/>
| shutdownOnClose | boolean | Call `controller.shutdown()` when the session ends (end of input, `/quit`, Ctrl+C, a finished run or a failure), so timers and plugins stop<br/>and the process can exit. Defaults to true.<br/>
| terminal | boolean | Run readline in terminal mode, with a prompt, line editing, history, Tab completion of commands and Ctrl+C handling.<br/>Defaults to true when both input and output are TTYs. When false, each line read is echoed as `you> <line>`.<br/>
| turnTimeout | number | The longest a turn may take, in milliseconds, before it fails with a `TurnTimeoutError`. Defaults to 30000; 0 disables the limit.<br/>
| unescapeHtml | boolean | Decode the HTML entities mustache adds to `{{vars.x}}` in dialog templates, such as `&#x2F;` in URLs. Defaults to true.<br/>
| user | string | The id of the user at the keyboard (`message.user`). Defaults to `$USER`, `$USERNAME` or `'user'`. Change it later with `/as <user>`.<br/>
| verbose | boolean | Show extra `channelData` fields as `data: <json>` and print error stacks. Defaults to false.<br/>
<a name="CliChoice"></a>
## Interface CliChoice
One entry of a numbered menu, as offered by quick replies, suggested actions or card buttons.

**Fields**

| Name | Type | Description
|--- |--- |---
| title | string | The label shown to the user.<br/>
| value | string | The value sent to the bot when the user picks this choice.<br/>
<a name="CliRunOptions"></a>
## Interface CliRunOptions
Options for [run()](#run).

**Fields**

| Name | Type | Description
|--- |--- |---
| closeOnComplete | boolean | End the session when the dialog finishes. Defaults to true when `dialog` is set.<br/>
| dialog | string | The id of a BotkitConversation, added with `controller.addDialog()`, to run from the start. Omit it to run an interactive session.<br/>
| vars |  | Initial variables for the dialog, available as `{{vars.x}}` and in the result.<br/>
<a name="CliRunResult"></a>
## Interface CliRunResult
The result of [run()](#run).

**Fields**

| Name | Type | Description
|--- |--- |---
| error | Error | The error that ended the run, when the status is `failed` because of an error.<br/>
| exitCode | number | A suggested process exit code: 0 for success, 1 for a canceled, timed out, unfinished or failed dialog, 2 for a missing answer and 130 for Ctrl+C.<br/>
| status | CliRunStatus | How the run ended: `completed`, `canceled` or `timeout` (the dialog ended with that status), `eof` (the input ended),<br/>`quit` (`/quit`, `/exit` or `close()`), `interrupted` (Ctrl+C) or `failed` (an error, or a missing answer in non-interactive mode).<br/>
| vars |  | The dialog's variables, including the collected answers, when the dialog ended or an answer was missing.<br/>
<a name="RenderOptions"></a>
## Interface RenderOptions
Options for renderActivity() and renderJson().

**Fields**

| Name | Type | Description
|--- |--- |---
| botName | string | The name shown in front of bot messages, as in `bot> Hello`.<br/>
| color | boolean | Add ANSI colors and bold text to the output.<br/>
| currentUser | string | The id of the user at the keyboard. Messages sent to anyone else are prefixed with `bot (to <id>)> `.<br/>
| unescapeHtml | boolean | Decode the HTML entities that mustache adds to `{{vars.x}}` tokens.<br/>
| verbose | boolean | Show extra `channelData` fields as a `data: <json>` line.<br/>
<a name="RenderedActivity"></a>
## Interface RenderedActivity
The result of renderActivity().

**Fields**

| Name | Type | Description
|--- |--- |---
| choices |  | The choices the message offers, in menu order.<br/>
| defaultValue | string | The value of `channelData.default`, if the message sets one.<br/>
| lines |  | The lines to print, without trailing newlines. May be empty.<br/>
