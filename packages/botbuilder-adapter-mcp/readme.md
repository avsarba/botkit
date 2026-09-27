# botbuilder-adapter-mcp
Connect [Botkit](https://www.npmjs.com/package/botkit) to AI agents with the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

This package contains an adapter that serves any Botkit bot as an MCP server over stdio, so agents such as Claude Code can start the bot and use it as a set of tools. It has no dependencies beyond Botkit and needs no tokens, webserver or network. The bot offers two kinds of tools:

* **The chat tool** sends a message through the full Botkit pipeline (middleware, `hears()`, `interrupts()`, `on()` and dialogs) and returns the bot's replies, the choices it offers, and whether a dialog is waiting for an answer. BotkitConversation dialogs, such as intake forms, approvals, deploys or troubleshooting trees, become validated workflows that an agent has to walk through one step at a time, with the same checks a person gets.
* **Declared tools** are defined with `adapter.tool()` and handled by ordinary `controller.on('tool:<name>')` handlers. The arguments arrive in `message.value`, and the handler returns a structured result with `bot.toolResult()`.

Proactive messages, such as scheduled reminders, wait in a per-session outbox until the agent's next chat call. The same bot can serve people on the web and agents over MCP at the same time.

## Install Package

Add this package to your project using npm:

```bash
npm install --save botbuilder-adapter-mcp
```

Import the adapter class into your code:

```javascript
const { McpAdapter } = require('botbuilder-adapter-mcp');
```

This adapter requires Botkit 4.11 or later.

## Use McpAdapter in your App

McpAdapter works with Botkit only. Pass it to the Botkit constructor, then write handlers and dialogs as usual.

### Quick start

Save this as `bot.js`:

```javascript
const { Botkit, BotkitConversation } = require('botkit');
const { McpAdapter } = require('botbuilder-adapter-mcp');

// Create the adapter before the controller, so that anything Botkit logs goes to stderr.
const adapter = new McpAdapter({
    serverInfo: { name: 'pizza-bot', version: '1.0.0' }
});

const controller = new Botkit({
    adapter: adapter,
    disable_webserver: true,
    disable_console: true
});

// A dialog the agent has to walk through, one question at a time.
const order = new BotkitConversation('order', controller);
order.ask({
    text: ['Which size?'],
    quick_replies: [{ title: 'Small', payload: 'small' }, { title: 'Large', payload: 'large' }]
}, async (answer, convo, bot) => {
    if (answer !== 'small' && answer !== 'large') {
        await bot.say('Only small or large.');
        await convo.repeat();
    }
}, 'size');
order.ask('Delivery address?', [], 'address');
order.say('Ordered a {{vars.size}} pizza to {{vars.address}}.');
controller.addDialog(order);

controller.hears('order', 'message', async (bot, message) => {
    await bot.beginDialog('order');
});

// A tool the agent can call directly.
adapter.tool('menu', {
    description: 'List the pizzas on the menu.',
    inputSchema: {
        type: 'object',
        properties: { vegetarian: { type: 'boolean', description: 'Only list vegetarian pizzas' } }
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
});

controller.on('tool:menu', async (bot, message) => {
    const pizzas = [{ name: 'Margherita', vegetarian: true }, { name: 'Pepperoni', vegetarian: false }];
    bot.toolResult({ pizzas: pizzas.filter((pizza) => !message.value.vegetarian || pizza.vegetarian) });
});
```

### Connect an agent

MCP clients start the bot as a child process and talk to it over stdin and stdout. To add it to Claude Code:

```bash
claude mcp add pizza-bot -- node /absolute/path/to/bot.js
```

Most other MCP clients use a JSON configuration like this one:

```json
{
  "mcpServers": {
    "pizza-bot": {
      "command": "node",
      "args": ["/absolute/path/to/bot.js"]
    }
  }
}
```

The client sees the tools `chat` and `menu`. When it closes the bot's stdin, the adapter finishes the requests in progress, calls `controller.shutdown()` and the process exits.

### The chat tool

The chat tool takes these arguments:

| Argument | Type | Description
|--- |--- |---
| message | string | Required. What to say to the bot. Send an empty string to collect waiting messages and check for a pending question without running a turn.
| session | string | The conversation to talk in. Reuse it to continue a conversation, use a new one to start fresh. 1 to 128 letters, digits, `_`, `.`, `:`, `@` or `-`. Defaults to `default`.
| reset | boolean | Cancel whatever the bot is waiting for in this session before handling the message.

A call returns the bot's replies as text:

```
Which size?
Choices: "Small" (send "small"), "Large" (send "large")
(Waiting for your answer to "size". Call chat again with session "s1".)
```

Clients that negotiated protocol version 2025-06-18 or later also receive `structuredContent`, which matches the tool's `outputSchema`:

```json
{
  "session": "s1",
  "replies": [
    { "type": "message", "text": "Which size?", "choices": [{ "title": "Small", "value": "small" }, { "title": "Large", "value": "large" }] }
  ],
  "proactive": [],
  "awaitingInput": true,
  "pendingQuestion": { "dialog": "order", "thread": "default", "key": "size" },
  "choices": [{ "title": "Small", "value": "small" }, { "title": "Large", "value": "large" }]
}
```

| Field | Description
|--- |---
| session | The session the call ran in.
| replies | What the bot sent during this call, as [McpReply](../docs/reference/mcp.md#McpReply) objects: `type`, `text`, `choices`, `attachments`, `data` (other `channelData`), and `name` and `value` for events. Typing, delay and trace activities are left out.
| proactive | Messages that arrived in this session since the last call, such as reminders, in the same format.
| awaitingInput | True when a dialog is waiting for an answer. The agent should answer with another call in the same session.
| pendingQuestion | `{ dialog, thread, key }` of the waiting question, or null. `key` is the variable the answer is stored in.
| choices | The choices the bot is offering, `[{ title, value }]`, from quick replies, suggested actions or hero card buttons.

Things to know about the chat tool:

* **Choices.** An agent should answer with a choice's `value`. If it sends a choice's title instead (ignoring case), the adapter sends the value, and `message.value` holds it too. The choices are forgotten once the question they belong to is answered.
* **Sessions.** Calls in one session run one at a time, in order. Calls in different sessions, and declared tool calls, run at the same time. The session's messages have `message.channel` set to `session:<session>` and `message.user` set to the client's name (see [clientId](../docs/reference/mcp.md#McpAdapter)).
* **Errors.** When a handler throws, the call returns `isError: true` with the text `The bot failed to handle this message: <error>`, plus any replies sent before the failure. The state of a failed turn is not saved, so a dialog that was waiting still waits. A call that takes longer than `turnTimeout` (15 seconds by default) returns `Turn timed out after 15000ms`; the turn keeps running, and anything it sends later goes to the session's outbox.
* **Escaping.** Dialog templates escape `{{vars.x}}` for HTML. The adapter decodes these entities, so `{{vars.url}}` reaches the agent as a plain URL. Set `unescapeHtml: false` to turn this off.
* Handlers can call `bot.toolError(message)` during a chat turn to mark the call as failed.

### Declared tools

Declare a tool with `adapter.tool(name, definition)` and handle it with `controller.on('tool:<name>')`:

```javascript
adapter.tool('track_order', {
    title: 'Track an order',
    description: 'Get the delivery status of a pizza order.',
    inputSchema: {
        type: 'object',
        properties: { order_id: { type: 'string', description: 'The order number, such as "A-1234"' } },
        required: ['order_id'],
        additionalProperties: false
    },
    outputSchema: {
        type: 'object',
        properties: { status: { type: 'string' }, eta_minutes: { type: 'number' } },
        required: ['status']
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
});

controller.on('tool:track_order', async (bot, message) => {
    const order = await orders.find(message.value.order_id);
    if (!order) {
        return bot.toolError(`There is no order ${ message.value.order_id }.`);
    }
    bot.toolResult({ status: order.status, eta_minutes: order.eta });
});
```

* The arguments are checked against `inputSchema` before the handler runs. Invalid arguments return a tool error that tells the agent what to fix, such as `Invalid arguments for tool "track_order": missing required property "order_id"`. The check covers `type`, `enum`, `required`, `properties`, `additionalProperties` and `items`; validate other constraints in the handler.
* `message.value` holds the arguments, and `message.mcp` is `{ requestId, tool }`.
* Text sent with `bot.say()` is returned as a text item. `bot.toolResult(object)` sets the structured result, which is also returned as JSON text for older clients. `bot.toolError(message)` marks the call as failed. A handler that throws also fails the call.
* A tool with an `outputSchema` must call `bot.toolResult()`, or the call fails.
* Every call runs in a conversation of its own, which is deleted from storage afterwards. So tool calls never disturb a dialog waiting in a chat session, and they are not queued. Tool handlers should not start dialogs: use the chat tool for conversations.
* Declare tools before the client connects. The server tells clients that its tool list does not change.

### Proactive messages

A bot pointed at a session with `bot.startConversationWithUser(session)` can send messages at any time, for example from a timer or a scheduled job:

```javascript
const bot = await controller.spawn({}, adapter);
await bot.startConversationWithUser('s1');
await bot.say('Your pizza is on its way.');
```

Messages sent outside a tool call go to the session's outbox. The next chat call in that session returns them in `proactive` and at the top of its text, marked `[message received while you were away]`. The adapter also sends each one to the client right away as a `notifications/message` log notification with `data.session` set. Up to `maxOutbox` messages (50 by default) are kept per session, and older ones are dropped first. A proactive bot can also start a dialog in a session with `bot.beginDialog()`; the agent then sees the question on its next chat call.

`adapter.continueConversation(reference, logic)` works the same way. Its turns are not queued behind chat calls, so a scheduled job never waits for a slow chat turn. In the rare case that a job and a chat call change the same session's dialog at the same moment, the later save wins.

### Logging and progress

`bot.log(level, data, logger)` sends a `notifications/message` log notification to the client, if the level is at or above the level the client set with `logging/setLevel` (`info` by default). It also works outside tool calls.

`bot.progress(progress, total, message)` sends a `notifications/progress` notification during a tool call, but only when the client asked for progress by sending a progress token with the call.

```javascript
controller.on('tool:bake', async (bot, message) => {
    bot.log('info', { order: message.value.order_id, step: 'oven preheating' }, 'kitchen');
    for (let minute = 1; minute <= 10; minute++) {
        await bake(minute);
        bot.progress(minute, 10, `Baking: ${ minute } of 10 minutes`);
    }
    bot.toolResult({ baked: true });
});
```

### Protocol support

The adapter speaks MCP protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`, and answers any other requested version with `2025-11-25`. Tool titles, output schemas and `structuredContent` are sent only to clients that negotiated `2025-06-18` or later.

It implements the stdio transport and this subset of the protocol, with no dependencies:

* requests `initialize`, `ping`, `tools/list`, `tools/call` and `logging/setLevel`, with the capabilities `tools` and `logging`;
* notifications `notifications/initialized` and `notifications/cancelled` from the client, and `notifications/message` and `notifications/progress` to the client;
* JSON-RPC batches.

Resources, prompts, sampling, elicitation, completions and the Streamable HTTP transport are not supported. A cancelled request gets no response, but its handler keeps running.

### Keep stdout clean

stdout carries the protocol, so anything else written to it corrupts the stream and breaks the connection.

* While the adapter is open, it sends `console.log`, `console.info`, `console.debug` and `console.dir` to stderr (see the `redirectConsole` option). Create the adapter before the Botkit controller, so this also covers Botkit's own start-up messages.
* Never call `process.stdout.write()` in your code, and do not use libraries that print to stdout.
* Pass `disable_console: true` and `disable_webserver: true` to Botkit, unless you also serve the web (see below).
* `debug` logging, such as `DEBUG=botkit:*`, goes to stderr and is safe.

### Serve people and agents together

Add the adapter to a bot that already has a primary adapter with `controller.usePlugin()`. People reach the bot through the web adapter, and agents through MCP on stdio:

```javascript
const { Botkit } = require('botkit');
const { WebAdapter } = require('botbuilder-adapter-web');
const { McpAdapter, McpBotWorker } = require('botbuilder-adapter-mcp');

const mcp = new McpAdapter({ serverInfo: { name: 'pizza-bot', version: '1.0.0' } });
const controller = new Botkit({ adapter: new WebAdapter() });
controller.usePlugin(mcp);

controller.hears('hello', 'message', async (bot, message) => {
    const who = bot instanceof McpBotWorker ? 'agent' : 'human';
    await bot.reply(message, `Hello, ${ who }!`);
});
```

For proactive messages to agents, spawn the bot for the MCP adapter: `await controller.spawn({}, mcp)`. Messages from agents have `message.incoming_message.channelId` set to `mcp`. Webhook requests still go to the primary adapter only.

By default the whole bot shuts down when the agent closes stdin. Pass `shutdownOnClose: false` to keep serving the web after the agent disconnects.

### Options

| Option | Default | Description
|--- |--- |---
| input | `process.stdin` | The stream to read JSON-RPC messages from.
| output | `process.stdout` | The stream to write JSON-RPC messages to.
| serverInfo | `{ name: 'botkit-mcp', version: <package version> }` | The name, version and optional `title` reported to clients.
| instructions | a description of the chat tool | Instructions for the agent, sent in the `initialize` result.
| chatTool | `{ name: 'chat' }` | The chat tool's `name`, `title` and `description`, or `false` to offer only declared tools.
| turnTimeout | `15000` | The longest a tool call may take, in milliseconds. 0 means no limit.
| redirectConsole | `true` when output is `process.stdout` | Send console output to stderr until the adapter is closed.
| autoStart | `true` | Start listening when Botkit is ready. Otherwise call `adapter.listen()`.
| shutdownOnClose | `true` | Call `controller.shutdown()` when stdin closes.
| maxOutbox | `50` | The most proactive messages kept per session.
| unescapeHtml | `true` | Decode the HTML entities that dialog templates add.

### Security

* Any client that can start your bot can call every tool, and do whatever your handlers do. Only give the command to agents you trust with those actions.
* Tool annotations such as `readOnlyHint` and `destructiveHint` are hints that help clients decide when to ask the user for confirmation. They are not enforced. Describe tools accurately, and put actions that are hard to undo behind a dialog that asks for explicit confirmation.
* `message.user` comes from the name the client reports and is not authenticated. Do not use it to authorize anything.
* Handlers should validate arguments beyond what the schema check covers, and should not pass them to shells, file paths or queries unchecked.
* Log notifications and tool results go to the agent, and often to the model behind it. Do not log secrets.
* The adapter opens no network ports. The bot runs with the permissions of the process that starts it.

### Things to know

* A dialog that is waiting in a session treats any activity sent to that session as its answer, including events. Declared tools avoid this by using a conversation of their own. If you send events into a chat session, for example from a scheduled job, handle them with `controller.interrupts()`.
* With the default MemoryStorage, sessions are lost when the process exits. Use a persistent storage adapter to keep them.
* An error thrown in a handler fails the call instead of hanging it. This relies on Botkit 4.11.

## Class Reference

* [McpAdapter](../docs/reference/mcp.md#McpAdapter)
* [McpBotWorker](../docs/reference/mcp.md#McpBotWorker)
* [McpAdapterOptions](../docs/reference/mcp.md#McpAdapterOptions)
* [McpToolDefinition](../docs/reference/mcp.md#McpToolDefinition)
* [McpReply](../docs/reference/mcp.md#McpReply)

## Event List

| Event | Description
|--- |---
| message | a chat tool call. `message.text` is the agent's message, or the value of the choice whose title it sent (then `message.value` holds the value too). `message.mcp` is `{ requestId, tool, session }`
| tool:_name_ | a call of a tool declared with `adapter.tool(name)`. `message.value` holds the arguments and `message.mcp` is `{ requestId, tool }`

## Botkit Extensions

In Botkit handlers, the `bot` worker for MCP contains [all of the base methods](../docs/reference/core.md) as well as the following platform-specific extensions:

### [bot.toolResult()](../docs/reference/mcp.md#toolResult)

Set the structured result of a declared tool call.

```javascript
controller.on('tool:menu', async (bot, message) => {
    bot.toolResult({ pizzas: ['Margherita', 'Pepperoni'] });
});
```

### [bot.toolError()](../docs/reference/mcp.md#toolError)

Mark the current tool call as failed, with a message for the agent.

```javascript
controller.on('tool:refund', async (bot, message) => {
    bot.toolError('Refunds must be approved by a manager.');
});
```

### [bot.log()](../docs/reference/mcp.md#McpBotWorker)

Send a log message to the client.

```javascript
bot.log('warning', { order: 'A-1234', message: 'The oven is running late' }, 'kitchen');
```

### [bot.progress()](../docs/reference/mcp.md#progress)

Report progress on a long tool call, when the client asked for it.

```javascript
bot.progress(3, 10, 'Baking');
```

### [bot.startConversationWithUser()](../docs/reference/mcp.md#startConversationWithUser)

Point a bot at a chat session to send proactive messages.

```javascript
const bot = await controller.spawn({}, adapter);
await bot.startConversationWithUser('s1');
await bot.say('Your pizza is on its way.');
```

### controller.plugins.mcp

The McpAdapter, for example to read `controller.plugins.mcp.clientInfo`.

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
