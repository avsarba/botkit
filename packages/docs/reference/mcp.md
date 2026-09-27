# Botkit for AI Agents (MCP) Class Reference

[&larr; Botkit Documentation](../core.md) [&larr; Class Index](index.md) 

This is a class reference for all the methods exposed by the [botbuilder-adapter-mcp](https://github.com/howdyai/botkit/tree/master/packages/botbuilder-adapter-mcp) package.

## Classes


* <a href="#McpAdapter" aria-current="page">McpAdapter</a>
* <a href="#McpBotWorker" aria-current="page">McpBotWorker</a>
* <a href="#JsonRpcConnection" aria-current="page">JsonRpcConnection</a>

## Interfaces

* <a href="#McpAdapterOptions" aria-current="page">McpAdapterOptions</a>
* <a href="#McpRenderOptions" aria-current="page">McpRenderOptions</a>
* <a href="#McpAttachment" aria-current="page">McpAttachment</a>
* <a href="#McpCallMeta" aria-current="page">McpCallMeta</a>
* <a href="#McpCallToolResult" aria-current="page">McpCallToolResult</a>
* <a href="#McpChoice" aria-current="page">McpChoice</a>
* <a href="#McpReply" aria-current="page">McpReply</a>
* <a href="#McpToolAnnotations" aria-current="page">McpToolAnnotations</a>
* <a href="#McpToolDefinition" aria-current="page">McpToolDefinition</a>

---

<a name="McpAdapter"></a>
## McpAdapter
Connect [Botkit](https://www.npmjs.com/package/botkit) to AI agents through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).
The bot becomes an MCP server that talks JSON-RPC over stdin and stdout, so agents such as Claude Code can start it and use it as a set of tools:

* the **chat** tool sends a message through the full Botkit pipeline (middleware, `hears()`, `interrupts()`, `on()` and dialogs)
  and returns the bot's replies, the choices it offers, and whether a dialog is waiting for an answer.
  BotkitConversation dialogs become validated, step-by-step workflows the agent has to walk through.
* **declared tools**, created with [tool()](#tool), are handled by `controller.on('tool:<name>')` handlers.
  The arguments arrive in `message.value`, and the handler returns a structured result with `bot.toolResult()`.

Proactive messages, such as scheduled reminders, wait in a per-session outbox until the agent's next chat call,
and are also sent as log notifications. This adapter works with Botkit only.

To use this class in your application, first install the package:
```bash
npm install --save botbuilder-adapter-mcp
```

Then import this and other classes into your code:
```javascript
const { McpAdapter } = require('botbuilder-adapter-mcp');
```

This class includes the following methods:
* [callTool()](#callTool)
* [close()](#close)
* [continueConversation()](#continueConversation)
* [deleteActivity()](#deleteActivity)
* [getReference()](#getReference)
* [handleMessage()](#handleMessage)
* [init()](#init)
* [listen()](#listen)
* [log()](#log)
* [notify()](#notify)
* [processActivity()](#processActivity)
* [sendActivities()](#sendActivities)
* [tool()](#tool)
* [updateActivity()](#updateActivity)



### Create a new McpAdapter()
**Parameters**

| Argument | Type | Description
|--- |--- |---
| options | [McpAdapterOptions](#McpAdapterOptions) | An optional [McpAdapterOptions](#McpAdapterOptions) object.<br/>

Create an adapter that serves a Botkit bot over MCP. By default it reads requests from stdin and writes responses to stdout,
starts listening as soon as Botkit is ready, and shuts Botkit down when stdin closes.

```javascript
const { Botkit } = require('botkit');
const { McpAdapter } = require('botbuilder-adapter-mcp');

const adapter = new McpAdapter({
    serverInfo: { name: 'pizza-bot', version: '1.0.0' }
});

const controller = new Botkit({
    adapter: adapter,
    disable_webserver: true,
    disable_console: true
});

controller.hears('hello', 'message', async (bot, message) => {
    await bot.reply(message, 'Hi! Want to order a pizza?');
});
```

Because stdout carries the protocol, the constructor sends `console.log`, `console.info`, `console.debug` and `console.dir`
to stderr until the adapter is closed (see the `redirectConsole` option).



## Properties and Accessors

| Name | Type | Description
|--- |--- |---
| clientId | string | The user id of the client in Botkit (`message.user`): its `clientInfo.name` with characters other than letters, digits, `_`, `.` and `-` replaced by `-`, at most 64 characters, or `mcp-client` if it sent no name.
| clientInfo |  | The `clientInfo` the client sent with `initialize`, such as `{ name: 'claude-code', version: '2.0.0' }`, or null before that.
| initialized | boolean | True once the client has sent `notifications/initialized`.
| protocolVersion | string | The protocol version agreed with the client during `initialize`, or null before that.

## McpAdapter Class Methods
<a name="callTool"></a>
### callTool()
Call a tool directly, as the MCP method `tools/call` does: the chat tool, or a tool declared with [tool()](#tool).
Invalid arguments give a result with `isError: true` that tells the agent what to fix. An unknown tool throws an Error with `rpcCode` -32602.

**Parameters**

| Argument | Type | description
|--- |--- |---
| name| string | The tool name.
| args| any | The tool arguments. Defaults to `{}`.
| meta| [McpCallMeta](#McpCallMeta) | The progress token and request id of the call, if any.<br/>


**Returns**

The tool result, an [McpCallToolResult](#McpCallToolResult).




```javascript
const result = await adapter.callTool('chat', { message: 'order', session: 'test' });
console.log(result.content[0].text);
console.log(result.structuredContent.awaitingInput);
```

<a name="close"></a>
### close()
Stop serving: stop reading input, drop the responses of requests still in progress, and restore the console.
Botkit calls this on `controller.shutdown()`. It does not shut Botkit down. Calling it again does nothing.



```javascript
process.on('SIGTERM', async () => {
    await controller.shutdown(); // closes the adapter
});
```

<a name="continueConversation"></a>
### continueConversation()
Standard BotBuilder adapter method for continuing an existing conversation based on a conversation reference.
The turn runs immediately and is not queued behind chat calls, so a scheduled job can run while a chat turn is in progress
(in the rare case that both change the same session's dialog state at once, the later save wins).
Messages it sends go to the session's outbox.
[BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#continueconversation)

**Parameters**

| Argument | Type | description
|--- |--- |---
| reference| Partial&lt;ConversationReference&gt; | A conversation reference, such as one from [getReference()](#getReference).
| logic|  | A bot logic function that will perform continuing action in the form `async(context) => { ... }`<br/>



<a name="deleteActivity"></a>
### deleteActivity()
The MCP adapter does not support deleting messages: this does nothing.

**Parameters**

| Argument | Type | description
|--- |--- |---
| context| TurnContext | A TurnContext representing the current incoming message and environment.
| reference| Partial&lt;ConversationReference&gt; | A reference to the activity to delete.<br/>



<a name="getReference"></a>
### getReference()
Get the conversation reference of a chat session, for proactive messages with `bot.changeContext()`.
`bot.startConversationWithUser(session)` does this for you.

**Parameters**

| Argument | Type | description
|--- |--- |---
| session| string | The chat session. Defaults to `default`.<br/>


**Returns**

A conversation reference for the session and the current client.




```javascript
const bot = await controller.spawn({}, adapter);
await bot.changeContext(adapter.getReference('default'));
await bot.say('Your pizza is on its way.');
```

<a name="handleMessage"></a>
### handleMessage()
Handle one parsed JSON-RPC message, or a batch (an array of messages), and return the response to send.
The connection calls this for each line of input; call it directly to serve MCP over another transport, or in tests.
It never rejects: failures become JSON-RPC error responses.

**Parameters**

| Argument | Type | description
|--- |--- |---
| message| any | A JSON-RPC request, notification or response, or an array of them.<br/>


**Returns**

The response object, an array of responses for a batch, or null when there is nothing to send (notifications and client responses).




```javascript
const response = await adapter.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
console.log(response.result.tools.map((tool) => tool.name)); // ['chat', 'menu']
```

<a name="init"></a>
### init()
Botkit-only: called automatically by Botkit when the adapter is passed to `new Botkit({ adapter })` or `controller.usePlugin(adapter)`.
Makes the adapter available as `controller.plugins.mcp`, closes it on `controller.shutdown()`,
and, unless `autoStart` is false, calls [listen()](#listen) once Botkit is ready.

**Parameters**

| Argument | Type | description
|--- |--- |---
| botkit| [Botkit](core.md#Botkit) | The Botkit controller.<br/>



<a name="listen"></a>
### listen()
Start reading JSON-RPC messages from the input stream. Botkit calls this automatically unless `autoStart` is false.
Calling it again does nothing. When the input stream ends, the adapter finishes the requests in progress and,
if `shutdownOnClose` is set, calls `controller.shutdown()`.



```javascript
const adapter = new McpAdapter({ autoStart: false });
const controller = new Botkit({ adapter, disable_webserver: true, disable_console: true });
controller.ready(() => {
    // ...load features and declare tools first
    adapter.listen();
});
```

<a name="log"></a>
### log()
Send a log message to the client as a `notifications/message` notification, if `level` is at or above the level
the client set with `logging/setLevel` (default `info`). In handlers, use `bot.log()`, which calls this.

**Parameters**

| Argument | Type | description
|--- |--- |---
| level| McpLogLevel | One of `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert` or `emergency`.
| data| any | Anything that can be serialized as JSON.
| logger| string | The name of the logger. Defaults to `botkit`.<br/>




```javascript
adapter.log('warning', { job: 'nightly-report', message: 'Took longer than usual' }, 'scheduler');
```

<a name="notify"></a>
### notify()
Send a JSON-RPC notification to the client. Nothing is sent when the adapter is not listening.

**Parameters**

| Argument | Type | description
|--- |--- |---
| method| string | The notification method, such as `notifications/message`.
| params (optional)| any | The notification params.<br/>




```javascript
adapter.notify('notifications/message', { level: 'info', logger: 'deploy', data: 'Deploy finished' });
```

<a name="processActivity"></a>
### processActivity()
The MCP adapter does not accept HTTP requests: this answers any webhook request with status 405 and a JSON error,
so a Botkit webserver with this as its primary adapter never throws.

**Parameters**

| Argument | Type | description
|--- |--- |---
| req| any | A request object from Restify or Express
| res| any | A response object from Restify or Express
| logic| any | A bot logic function (not used)<br/>



<a name="sendActivities"></a>
### sendActivities()
Standard BotBuilder adapter method to send messages. During a tool call, messages are collected into the call's result.
Messages sent outside a tool call (proactive messages, or messages sent after a call timed out) go to the outbox of their
chat session, which the next chat call returns, and are also sent to the client as `notifications/message` log notifications.
[BotBuilder reference docs](https://docs.microsoft.com/en-us/javascript/api/botbuilder-core/botadapter?view=botbuilder-ts-latest#sendactivities).

**Parameters**

| Argument | Type | description
|--- |--- |---
| context| TurnContext | A TurnContext representing the current incoming message and environment.
| activities|  | An array of outgoing activities.<br/>


**Returns**

One `{ id }` per activity.



<a name="tool"></a>
### tool()
Declare a tool. Agents see it in `tools/list`, and each call fires the Botkit event `tool:<name>`,
with the arguments in `message.value`. The handler reports back with `bot.say()` (text for the agent),
[bot.toolResult()](#toolResult) (a structured result) and [bot.toolError()](#toolError).

**Parameters**

| Argument | Type | description
|--- |--- |---
| name| string | The tool name: 1 to 128 letters, digits, `_`, `-` or `.`. It must not be the chat tool's name.
| definition| [McpToolDefinition](#McpToolDefinition) | An [McpToolDefinition](#McpToolDefinition) with the description, schemas and annotations.<br/>


**Returns**

The adapter, so calls can be chained.



Each call runs in its own conversation, so tool calls never disturb chat sessions or each other, and they are not queued.
Tool handlers should not start dialogs: use the chat tool for conversations.
Declare tools before the client connects; the server does not announce changes to the list.

```javascript
adapter.tool('menu', {
    title: 'Pizza menu',
    description: 'List the pizzas on the menu, optionally filtered by a word such as "veg".',
    inputSchema: {
        type: 'object',
        properties: { filter: { type: 'string', description: 'A word to filter by' } }
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
});

controller.on('tool:menu', async (bot, message) => {
    const pizzas = menu.filter((pizza) => !message.value.filter || pizza.tags.includes(message.value.filter));
    bot.toolResult({ pizzas: pizzas });
});
```

<a name="updateActivity"></a>
### updateActivity()
The MCP adapter does not support updating messages: this does nothing.

**Parameters**

| Argument | Type | description
|--- |--- |---
| context| TurnContext | A TurnContext representing the current incoming message and environment.
| activity| Partial&lt;Activity&gt; | The activity to update.<br/>




<a name="McpBotWorker"></a>
## McpBotWorker
This is a specialized version of [Botkit's core BotWorker class](core.md#BotWorker) that includes additional methods for AI agents connected over MCP.
It includes all functionality from the base class, as well as the extension methods below.

When using the McpAdapter with Botkit, all `bot` objects passed to handler functions will include these extensions.

To use this class in your application, first install the package:
```bash
npm install --save botbuilder-adapter-mcp
```

Then import this and other classes into your code:
```javascript
const { McpBotWorker } = require('botbuilder-adapter-mcp');
```

This class includes the following methods:
* [log()](#log)
* [progress()](#progress)
* [startConversationWithUser()](#startConversationWithUser)
* [toolError()](#toolError)
* [toolResult()](#toolResult)



### Create a new McpBotWorker()
**Parameters**

| Argument | Type | Description
|--- |--- |---
| controller | [Botkit](core.md#Botkit) | A pointer to the main Botkit controller
| config | any | An object typically containing { dialogContext, reference, context, activity }<br/>

Create a new BotWorker instance. Do not call this directly - instead, use [controller.spawn()](core.md#spawn).



## McpBotWorker Class Methods
<a name="log"></a>
### log()
Send a log message to the client as an MCP `notifications/message` notification, if `level` is at or above the level
the client set with `logging/setLevel` (default `info`). This also works outside tool calls, for example from a scheduled job.

**Parameters**

| Argument | Type | description
|--- |--- |---
| level| McpLogLevel | One of `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert` or `emergency`.
| data| any | Anything that can be serialized as JSON: a string, or an object with details.
| logger| string | The name of the logger. Defaults to `botkit`.<br/>




```javascript
controller.on('tool:deploy', async (bot, message) => {
    bot.log('notice', { service: message.value.service, step: 'build started' }, 'deploy');
    // ...
});
```

<a name="progress"></a>
### progress()
Report progress on a long tool call with an MCP `notifications/progress` notification.
It is sent only when the client asked for progress by sending a progress token with the call; otherwise it does nothing.
`progress` must grow with each call.

**Parameters**

| Argument | Type | description
|--- |--- |---
| progress| number | The work done so far.
| total (optional)| number | The total amount of work, if known.
| message (optional)| string | A short description of the current step.<br/>




```javascript
controller.on('tool:migrate', async (bot, message) => {
    for (let batch = 1; batch <= 10; batch++) {
        await migrateBatch(batch);
        bot.progress(batch, 10, `Migrated batch ${ batch } of 10`);
    }
    bot.toolResult({ migrated: 10 });
});
```

<a name="startConversationWithUser"></a>
### startConversationWithUser()
Point this bot at a chat session, so that `bot.say()` sends proactive messages to it, for example from a timer or a scheduled job.
Proactive messages wait in the session's outbox until the agent's next call to the chat tool, and are also sent to the client
as `notifications/message` log notifications. `bot.beginDialog()` also works after this call.

**Parameters**

| Argument | Type | description
|--- |--- |---
| session (optional)| string | The chat session, as passed in the chat tool's `session` argument. Defaults to `default`.<br/>


**Returns**

This bot, with its context changed.




```javascript
const bot = await controller.spawn({}, adapter);
await bot.startConversationWithUser('default');
await bot.say('The nightly report is ready.');
```

<a name="toolError"></a>
### toolError()
Mark the current tool call as failed. The agent receives a result with `isError: true` and the message as text.
The handler keeps running; return after calling this if there is nothing more to do. Outside a tool call it does nothing.

**Parameters**

| Argument | Type | description
|--- |--- |---
| message (optional)| string | An explanation for the agent.<br/>




```javascript
controller.on('tool:refund', async (bot, message) => {
    const order = await orders.find(message.value.order_id);
    if (!order) {
        return bot.toolError(`There is no order ${ message.value.order_id }.`);
    }
    bot.toolResult(await orders.refund(order));
});
```

<a name="toolResult"></a>
### toolResult()
Set the structured result of a declared tool call. The agent receives it as `structuredContent` (protocol 2025-06-18 and later)
and as a JSON text item. The value is copied when this is called, so later changes to it are not sent.
Call it once per tool call; a later call replaces the earlier result. Outside a tool call it does nothing.

**Parameters**

| Argument | Type | description
|--- |--- |---
| result| any | A plain object that can be serialized as JSON.<br/>




```javascript
adapter.tool('menu', { description: 'List the pizzas on the menu', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } } });

controller.on('tool:menu', async (bot, message) => {
    const items = await menu.search(message.value.filter);
    bot.toolResult({ items: items });
});
```




<a name="JsonRpcConnection"></a>
## JsonRpcConnection
A newline-delimited JSON-RPC 2.0 connection over a pair of streams, as used by the MCP stdio transport.

* Each line of `input` is one JSON message. A trailing carriage return is removed and blank lines are skipped.
* A line that is not valid JSON is answered with the error `-32700 Parse error`.
* Every other message is passed to `handler` without waiting for earlier ones, so requests run concurrently.
  A result that is not null is written to `output` as one line of JSON. Nothing else is ever written to `output`.
* When `input` ends, the connection waits for every message in `pending` to be handled, then closes and calls the [onClose()](#onClose) listeners.
* An error on `output` (for example EPIPE because the client went away) or on `input` is treated like the end of `input`.

```javascript
const { JsonRpcConnection } = require('botbuilder-adapter-mcp');
const connection = new JsonRpcConnection(process.stdin, process.stdout, async (message) => {
    if (message.method === 'ping') {
        return { jsonrpc: '2.0', id: message.id, result: {} };
    }
    return null;
});
connection.onClose(() => console.error('The client went away.'));
connection.start();
```

To use this class in your application, first install the package:
```bash
npm install --save botbuilder-adapter-mcp
```

Then import this and other classes into your code:
```javascript
const { JsonRpcConnection } = require('botbuilder-adapter-mcp');
```

This class includes the following methods:
* [close()](#close)
* [onClose()](#onClose)
* [send()](#send)
* [start()](#start)



### Create a new JsonRpcConnection()
**Parameters**

| Argument | Type | Description
|--- |--- |---
| input | ReadableStream | The stream to read messages from, such as `process.stdin`.
| output | WritableStream | The stream to write responses and notifications to, such as `process.stdout`.
| handler |  | Handles one parsed message (an object, or an array for a batch) and resolves with the response to write, or null to write nothing.<br/>

Create a connection. Call [start()](#start) to begin reading.



## Properties and Accessors

| Name | Type | Description
|--- |--- |---
| pending | Set&lt;Promise&gt; | The messages that are being handled, as promises that settle when each one is done. They never reject.

## JsonRpcConnection Class Methods
<a name="close"></a>
### close()
Stop reading and writing now. Responses to requests that are still running are dropped, and the [onClose()](#onClose) listeners are not called.
Calling it again does nothing.



<a name="onClose"></a>
### onClose()
Register a function to call once the input stream has ended and every pending message has been handled.
It is not called when the connection is closed with [close()](#close).

**Parameters**

| Argument | Type | description
|--- |--- |---
| fn|  | The function to call.<br/>



<a name="send"></a>
### send()
Write one message to the output stream as a line of JSON. Messages sent after [close()](#close) are dropped.
A response that cannot be serialized is replaced by a `-32603 Internal error` response with the same id; any other such message is dropped.

**Parameters**

| Argument | Type | description
|--- |--- |---
| message| any | A JSON-RPC response, notification, or an array of responses.<br/>



<a name="start"></a>
### start()
Start reading messages from the input stream. Calling it again does nothing.





<a name="McpAdapterOptions"></a>
## Interface McpAdapterOptions
This interface defines the options that can be passed into the McpAdapter constructor function.

**Fields**

| Name | Type | Description
|--- |--- |---
| autoStart | boolean | Start listening as soon as Botkit is ready. Defaults to true. When false, call [listen()](#listen) yourself.<br/>
| chatTool |  | Configure the chat tool, or set to false to offer only declared tools. Defaults to `{ name: 'chat' }` with a generated description.<br/>
| input | ReadableStream | The stream to read JSON-RPC messages from. Defaults to `process.stdin`.<br/>
| instructions | string | Instructions for the agent, sent in the `initialize` result. Defaults to a short text that explains the chat tool and lists the declared tools.<br/>
| maxOutbox | number | The most proactive messages kept per chat session until the agent's next chat call. Older messages are dropped first. Defaults to 50.<br/>
| output | WritableStream | The stream to write JSON-RPC messages to. Defaults to `process.stdout`.<br/>
| redirectConsole | boolean | Send `console.log`, `console.info`, `console.debug` and `console.dir` to stderr until the adapter is closed, so they cannot corrupt the protocol stream.<br/>Defaults to true when `output` is `process.stdout`.<br/>
| serverInfo |  | The name and version the server reports to clients. Defaults to `{ name: 'botkit-mcp', version: <this package's version> }`.<br/>`title` is a human-readable name, sent to clients that negotiated protocol version 2025-06-18 or later.<br/>
| shutdownOnClose | boolean | Call `controller.shutdown()` when the input stream ends, so the process can exit when the client disconnects. Defaults to true.<br/>
| turnTimeout | number | The longest a tool call may take, in milliseconds, before it returns an error. The turn keeps running in the background. 0 means no limit. Defaults to 15000.<br/>
| unescapeHtml | boolean | Decode the HTML entities that mustache adds when dialog templates render `{{vars.x}}`. Defaults to true.<br/>

<a name="McpRenderOptions"></a>
## Interface McpRenderOptions
Options for `renderRepliesText()`.

**Fields**

| Name | Type | Description
|--- |--- |---
| awaitingInput | boolean | True when a dialog is waiting for an answer. Adds a closing line that tells the agent how to answer.<br/>
| empty | string | The text returned when there is nothing to show. Defaults to `(no reply)`.<br/>
| key | string | The variable the pending question stores its answer in, mentioned in the closing line.<br/>
| proactive |  | Messages that arrived while the agent was away. They are listed first, each marked `[message received while you were away]`.<br/>
| session | string | The chat session, mentioned in the closing line. Defaults to `default`.<br/>
| toolName | string | The name of the chat tool, mentioned in the closing line. Defaults to `chat`.<br/>
| unescapeHtml | boolean | Decode HTML entities in card titles, subtitles and text. Defaults to true.<br/>

<a name="McpAttachment"></a>
## Interface McpAttachment
An attachment of a bot message, as reported to the agent.

**Fields**

| Name | Type | Description
|--- |--- |---
| content | any | The card itself, for hero, thumbnail and adaptive cards only.<br/>
| contentType | string | The MIME type of the attachment, or a card type such as `application/vnd.microsoft.card.hero`.<br/>
| name | string | The name of the attachment, if it has one.<br/>
| url | string | The attachment's `contentUrl`, if it has one.<br/>

<a name="McpCallMeta"></a>
## Interface McpCallMeta
Options for [McpAdapter.callTool()](#callTool).

**Fields**

| Name | Type | Description
|--- |--- |---
| progressToken |  | The progress token the client sent in `params._meta.progressToken`. `bot.progress()` does nothing without one.<br/>
| requestId |  | The id of the JSON-RPC request, passed to handlers as `message.mcp.requestId`.<br/>

<a name="McpCallToolResult"></a>
## Interface McpCallToolResult
The result of an MCP `tools/call` request, as returned by [McpAdapter.callTool()](#callTool).

**Fields**

| Name | Type | Description
|--- |--- |---
| content |  | Text for the agent to read.<br/>
| isError | boolean | True when the call failed. The text explains why.<br/>
| structuredContent | any | A structured result. Only sent to clients that negotiated protocol version 2025-06-18 or later.<br/>

<a name="McpChoice"></a>
## Interface McpChoice
One choice offered by a bot message, from its quick replies, suggested actions or card buttons.

**Fields**

| Name | Type | Description
|--- |--- |---
| title | string | The label of the choice.<br/>
| value | string | The value to send to choose it.<br/>

<a name="McpReply"></a>
## Interface McpReply
One activity the bot sent, simplified for an agent. `typing`, `delay` and `trace` activities are never reported.

**Fields**

| Name | Type | Description
|--- |--- |---
| attachments |  | The attachments of the message.<br/>
| choices |  | The choices the message offers: quick replies or suggested actions, or else hero and thumbnail card buttons.<br/>
| data |  | The message's `channelData`, without `quick_replies` and `botkitEventType`. Only present when something is left.<br/>
| name | string | The name of an event activity.<br/>
| text | string | The text of the message, with the HTML entities that mustache adds decoded (unless the `unescapeHtml` option is false).<br/>
| type | string | The activity type, usually `message` or `event`.<br/>
| value | any | The value of an event activity.<br/>

<a name="McpToolAnnotations"></a>
## Interface McpToolAnnotations
Hints that describe how a tool behaves. Clients use them to decide, for example, whether to ask the user before calling a tool.
They are hints only: clients must not rely on them for security.

**Fields**

| Name | Type | Description
|--- |--- |---
| destructiveHint | boolean | True if the tool may delete or overwrite data, false if it only adds. Only meaningful when readOnlyHint is false. Default true.<br/>
| idempotentHint | boolean | True if calling the tool again with the same arguments has no further effect. Only meaningful when readOnlyHint is false. Default false.<br/>
| openWorldHint | boolean | True if the tool reaches systems outside the bot, such as the web or a third-party API. Default true.<br/>
| readOnlyHint | boolean | True if the tool does not change anything. Default false.<br/>
| title | string | A human-readable title for the tool.<br/>

<a name="McpToolDefinition"></a>
## Interface McpToolDefinition
Describes a tool declared with [McpAdapter.tool()](#tool). The tool's handler is `controller.on('tool:<name>', handler)`.

**Fields**

| Name | Type | Description
|--- |--- |---
| annotations | [McpToolAnnotations](#McpToolAnnotations) | Hints that describe how the tool behaves.<br/>
| description | string | What the tool does and when to use it. Agents read this to decide when to call the tool, so be specific.<br/>
| inputSchema |  | A JSON Schema for the tool's arguments. It must have `type: 'object'`. Defaults to `{ type: 'object', properties: {} }`.<br/>Arguments are checked with `validateArguments()` before the handler runs.<br/>
| outputSchema |  | A JSON Schema for the structured result the handler passes to `bot.toolResult()`. It must have `type: 'object'`.<br/>Sent to clients that negotiated protocol version 2025-06-18 or later.<br/>A tool with an outputSchema whose handler does not call `bot.toolResult()` returns an error.<br/>
| title | string | A human-readable name for the tool. Sent to clients that negotiated protocol version 2025-06-18 or later.<br/>
