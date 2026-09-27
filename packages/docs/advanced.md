# Advanced topics

## What causes the error: `UnhandledPromiseRejectionWarning: TypeError: Cannot perform 'get' on a proxy that has been revoked`

This happens when a call to bot.say, bot.reply, or bot.beginDialog has been used without the `await` keyword.

Make sure you `await` all calls to these and similar functions! These functions return promises that have to be resolved
properly, otherwise you'll get the above error!

## Botkit 4.0 Goals:

These were the goals we set out to achieve in creating the new version of Botkit.

* Keep as much of the feature set, syntax and special sauce developers know and love
* Solve persistent and hard to solve problems in previous versions of Botkit
* Use modern JavaScript language features like async/await instead of callbacks
* Full Typescript support
* Break platform adapters (and their large dependency trees) into optional packages
* Reorganize some related projects into a monorepo
* Inherit much goodness from [Bot Framework SDK](https://github.com/microsoft/botbuilder-js)
* Provide a way for bots to be extended with plugins and modular features, and for those plugins to provide a consistent interface to administrators


## What's different between 0.7 and 4.0?

The [changelog](https://github.com/howdyai/botkit/blob/master/changelog.md#401) has lots of details on the new features.

In addition, here are some notes on the major changes:

* All of the major features now uses promises and the async/await pattern. Goodbye, nested callbacks!
* Everything has been rebuilt using Typescript classes. If you want types, you got 'em!
* The dialog system has been rearchitected to solve some long term issues - but much of the familiar syntax has been retained.
* The core Botkit library now contains just the platform-independent APIs for building bot features. Platform adapters are now separate modules.
* Botkit is now inherits core classes from [Bot Framework SDK](https://github.com/microsoft/botframework-sdk#readme) and as a result gains compatibility with all of the tools from Bot Framework - in particular [dialogs](https://npmjs.com/package/botbuilder-dialogs) and [Bot Framework Emulator](https://aka.ms/botframework-emulator)
* Botkit no longer provides a generic "storage" layer. Developers will need to build their own or use a hybrid approach (see below.)


## How to upgrade from 0.7 to 4.0

Though many things have changed in the latest version of Botkit, and it is not directly backwards compatible with previous versions,
many elements of the previous Botkit syntax are still present and the vast majority of features from the previous versions.
Experienced Botkit developers will recognize the familiar syntax of features like `hears()` and `ask()`.

The overall structure of the Botkit application is roughly the same, though the shape of some components have shifted.
Before upgrading your bot, use the yeoman generator to create a sample app -- if only to understand its structure.
In most cases, the best approach will be to create a new bot using the generator, then port existing "skill" files to the new syntax.

You may need to update your Node version because v4 of Botkit uses modern Javascript syntax. We suggest using the LTS version.

### Changes to how Botkit is installed and configured:

* Previous versions of Botkit contained all the adapters. Now the adapters are separate packages.
* Now have to separately configure Botkit and the adapter.
* If you previously used a starter kit,  the easiest way is to start with a new yeoman generator template, then copy over skill files, then make some syntax updates.

FROM:
```
var Botkit = require('botkit');

var controller = new Botkit.slackbot(options);
```

TO:
```
const { Botkit } = require('botkit');
const { SlackAdapter } = require('botbuilder-adapter-slack');

let adapter = new SlackAdapter(options);
let controller = new Botkit({
    adapter: adapter
});
```

### Syntax changes in your bot code:

* Everything has been promisified! Before all your "hears" or "on" handlers, add the "async" keyword to the function.
* Add "await" keyword in front of all calls to bot.reply or bot.say or similar functions.
* The name of the event for normal messages has changed.  Change any instance of 'message_received' to 'message'

FROM:
```
bot.hears('foo', 'message_received', function(bot, message) { 
    bot.reply(message,'bar');
});
```

TO:
```
bot.hears('foo', 'message', async(bot, message) => { 
    await bot.reply(message,'bar');
});
```

### Conversation changes:

* All conversations have to be constructed using `new BotkitConversation()` added using `controller.addDialog()` at startup (not inside handler or dynamically)
* Any call to startConversation (and related functions) has to be updated - these functions still exist but work differently, and must be paired with a call to `bot.beginDialog()`
* The new system no longer has support for modifying the conversation structure on the fly by doing additional calls to convo.say or convo.ask from inside callbacks. If your dialog requires sending ad hoc messages, it is still possible to do that using use `bot.say()` rather than `convo.say()`
* The syntax for convo.ask and convo.say remains mostly the same
* convo.ask handlers are now in the format `async(response, convo, bot)=>{}`. as a result of these being promises, it is no longer necessary to call convo.next
* Hook functions have changed a bit: convo.before takes a thread name, to fire before anything, set that to default.

FROM:
```
bot.hears('tacos', 'direct_message', function(bot, message) {
    bot.startConversation(function(err, convo) { 

        convo.say('SOMEONE SAID TACOS!');
        convo.ask('Do you want to eat a taco?', [
            {
                pattern: 'yes',
                default: true,
                callback: function(response, convo) {
                    convo.gotoThread('yes_tacos');
                }
            },
            {
                pattern: 'no',
                callback: function(response, convo) {
                    convo.gotoThread('no_tacos');
                }
            }
        ], {key: 'wants_taco'});

        convo.addMessage('Hooray for tacos!', 'yes_tacos');
        convo.addMessage('ERROR: Tacos missing!!', 'no_tacos');

        convo.on('end', function(convo) {
            var responses = convo.extractResponses();
            // responses.wants_tacos
        });
    });
});
```

TO:
```
const { BotkitConversation } = require('botkit');

let convo = new BotkitConversation('tacos', controller);
convo.say('SOMEONE SAID TACOS!');
convo.ask('Do you want to eat a taco?', [
    {
        pattern: 'yes',
        default: true,
        handler: async(response, convo, bot) => {
            await convo.gotoThread('yes_tacos');
        }
    },
    {
        pattern: 'no',
        handler: async(response, convo, bot) => {
            await convo.gotoThread('no_tacos');
        }
    }
], 'wants_taco');

convo.addMessage('Hooray for tacos!', 'yes_tacos');
convo.addMessage('ERROR: Tacos missing!!', 'no_tacos');

convo.after(async(results, bot) => {

    // results.wants_taco

})

// add to the controller to make it available for later.
controller.addDialog(convo);

controller.hears('tacos', 'direct_message', async(bot, message) => {
    await bot.beginDialog('tacos');
});
```

### Botkit Studio / Botkit CMS changes:

The functionality previously associated with Botkit Studio and now associated with Botkit CMS has been now been moved out of the core SDK
and into a plugin module.

To access dialog content build in Botkit CMS, install `botkit-plugin-cms`, and adjust calls to the CMS from `controller.studio.*` to `controller.plugins.cms.*`:

* `controller.studio.before('script', ...)` becomes `controller.plugins.cms.before('script', 'default', ...)`
* `controller.studio.beforeThread('script', 'thread')` becomes `controller.plugins.cms.before('script', 'thread', ...)`
* `controller.studio.after('script', ...)` becomes `controller.plugins.cms.after('script', ...)`
* `controller.studio.validate('script', 'variable', ...')` becomes `controller.plugins.cms.onChange('script', 'variable', ...)`

Read [more about using botkit-plugin-cms here](plugins/cms.html)

### Storage changes

In v4 of Botkit, the storage system is currently only used to store and retrieve the conversation state between turns.
Other than this, Botkit will no longer be providing an interface for connecting to or using databases. Developers
should build their own database abstractions.

However to reduce the complexity of the upgrade process, existing bots can continue to use storage adapters from 
previous versions of Botkit using [the technique discussed here](https://github.com/howdyai/botkit-storage-mongo/issues/42#issuecomment-489654424).


## Anatomy of a Botkit App

File structure:

* main app file (normally bot.js)
* features/ folder
* .env file
* package.json file

in bot.js:

* create adapter
* create botkit
* load any middlewares or plugins
* use `controller.loadModules()` to load features/ folder

in features/ folder:

modules in the form:

```javascript
module.exports = function(controller) {
    // some code here.
}
```
## Flow of activity as a message is processed

* Adapter receives incoming http request
* Activity object is created, passed off to Botkit
* Botkit turns the Activity object into a BotkitMessage
* Botkit runs ingest middleware
* Botkit evaluates for interrupts -> end if triggered
* Botkit passes to dialog stack -> end if active dialog 
* Botkit evaluates for hears -> end if triggered
* Botkit runs receive middleware
* Botkit emits an event based on the `type` field of the message
* Any handlers bound to event fire
* Adapter sends http response

When a message is sent:

* Botkit receives message from code
* Botkit runs send middleware
* Activity object is created, passed off to BotBuilder
* BotBuilder sends the message to the platform API

## How to use "Bot Inspector" mode

With Bot Inspector mode enabled, you can use [Bot Framework Emulator](https://aka.ms/botframework-emulator) to
connect to your bot _while it also sends and receives messages to the live platform of your choice._ Once activated,
you'll be able to inspect the JSON payloads of incoming and outgoing messages, as well as inspect your bot's state variables.

It is TRULY COOL AND USEFUL, like opening an access panel into your bot's brain and being able to poke around like they did with Data on Star Trek: The Next Generation.

To enable this in a Botkit app:

* Add [this module](https://gist.github.com/benbrown/d6fbf2c8aac37b60c746abc08b9b96e7) to your app.
* Download the latest [Bot Framework Emulator](https://aka.ms/botframework-emulator)
* Launch your bot app and make sure it is connected to the outside world with a tool like ngrok
* Launch Bot Framework emulator and enable inspector mode "View > Bot Inspector Mode" in the menu
* Connect to "http://localhost:3000/api/sidecar"
* Bot Framework emulator will display a command like "/INSPECT attach XYZ".  Copy paste this into the channel with your bot that you want to inspect.
* If successful, your bot should respond automatically.
* Watch the emulator for future messages between your bot and the channel being inspected.


## Typescript

coming 

## How to build a new adapter

An adapter connects Botkit to a surface: a messaging API, a web page, a terminal, a protocol or a queue. It is a subclass of BotBuilder's `BotAdapter` that turns input into `Activity` objects for Botkit, and turns the bot's outgoing activities into output. Botkit calls `usePlugin(adapter)` in its constructor, so an adapter is also a plugin, with a `name`, optional `middlewares` and an `init(botkit)` hook.

This adapter reads one JSON object per line from a stream and writes the bot's replies as JSON lines. It is complete and works as written:

```javascript
const readline = require('readline');
const { BotAdapter, TurnContext } = require('botbuilder');
const { BotWorker } = require('botkit');

class LinesBotWorker extends BotWorker {
    // helpers for handlers, such as startConversationWithUser(user) built on this.changeContext()
}

class LinesAdapter extends BotAdapter {
    constructor(options = {}) {
        super();
        this.name = 'Lines Adapter';         // required: Botkit ignores a plugin without a name
        this.botkit_worker = LinesBotWorker; // the class of the `bot` passed to handlers
        this.input = options.input || process.stdin;
        this.output = options.output || process.stdout;
    }

    init(botkit) {
        this.controller = botkit;
        // init() runs inside new Botkit(), before your handlers are registered: start later
        botkit.ready(() => setImmediate(() => this.start()));
        // controller.shutdown() does not touch adapters, so release streams, sockets and timers here
        botkit.on('shutdown', async () => this.rl && this.rl.close());
    }

    start() {
        this.rl = readline.createInterface({ input: this.input });
        let queue = Promise.resolve();
        this.rl.on('line', (line) => {
            // one turn at a time, so turns in a conversation never overlap
            queue = queue.then(() => this.receive(JSON.parse(line))).catch((err) => console.error(err));
        });
    }

    async receive(payload) {
        const activity = {
            type: payload.type === 'message' ? 'message' : 'event',
            channelId: 'lines',                                    // channelId, conversation.id and from.id are required:
            conversation: { id: payload.conversation || payload.user }, // they are the key of the dialog state
            from: { id: payload.user },
            recipient: { id: 'bot' },
            text: payload.text,                                    // dialogs match and store answers from text
            channelData: payload,
            timestamp: new Date(),
            id: String(Date.now())
        };
        if (activity.type === 'event') {
            activity.channelData.botkitEventType = payload.type;  // fires controller.on(payload.type)
        }
        const context = new TurnContext(this, activity);
        await this.runMiddleware(context, this.controller.handleTurn.bind(this.controller));

        const question = await this.controller.getPendingQuestion(context);
        if (question) {
            this.write({ type: 'waiting', key: question.key, conversation: activity.conversation.id });
        }
    }

    async sendActivities(context, activities) {
        return activities.map((activity, i) => {
            this.write({
                type: activity.type,
                text: activity.text,
                to: activity.recipient.id,                  // the user
                conversation: activity.conversation.id,
                quick_replies: activity.channelData && activity.channelData.quick_replies
            });
            return { id: `${ Date.now() }-${ i }` };
        });
    }

    async updateActivity(context, activity) { /* not supported by this surface */ }

    async deleteActivity(context, reference) { /* not supported by this surface */ }

    async continueConversation(reference, logic) {
        const request = TurnContext.applyConversationReference({ type: 'event', name: 'continueConversation' }, reference, true);
        await this.runMiddleware(new TurnContext(this, request), logic);
    }

    async processActivity(req, res, logic) {
        res.statusCode = 405; // not an HTTP adapter: answer Botkit's webhook route instead of throwing
        res.end(JSON.stringify({ error: 'This adapter does not accept HTTP requests' }));
    }

    write(message) {
        this.output.write(JSON.stringify(message) + '\n');
    }
}
```

Use it like any other adapter: `const controller = new Botkit({ adapter: new LinesAdapter(), disable_webserver: true })`.

Some parts of the example need a closer look:

* **The abstract methods.** `BotAdapter` requires `sendActivities`, `updateActivity`, `deleteActivity` and `continueConversation`. `updateActivity` and `deleteActivity` may do nothing when the surface cannot edit messages.
* **Receiving.** Every incoming activity needs `channelId`, `conversation.id` and `from.id`: Botkit uses them to key the conversation state, and throws without them. Pass the turn to `runMiddleware(context, controller.handleTurn.bind(controller))`, which runs the adapter's own middleware (`adapter.use()`) first. As of Botkit 4.11, `handleTurn()` rejects when a handler or middleware fails, so `runMiddleware()` rejects too, unless you set `adapter.onTurnError`. Report the error to the user in a way that fits your surface, and do not let it become an unhandled rejection.
* **Sending.** By the time `sendActivities` runs, `TurnContext` has applied the turn's reference. `activity.conversation.id` is the conversation and `activity.recipient.id` is the user. `bot.say()` moves any field that is not part of an Activity into `activity.channelData`, so read custom fields such as `quick_replies` from there. Dialog templates also set `suggestedActions`. Proactive messages, from `bot.changeContext(reference)` or `continueConversation()`, arrive here too, with no incoming request to reply to.
* **Continuing conversations.** `continueConversation()` is what [botkit-plugin-scheduler](plugins/scheduler.md) calls to run a job in a saved conversation. Do not queue these turns behind user input. If a handler awaits `scheduler.runNow(id)`, a queued job turn would wait for the handler's turn to end, while the handler waits for the job: a deadlock.
* **Synchronous HTTP.** An adapter behind Botkit's webhook route implements `processActivity(req, res, logic)`. It sets `context.turnState.set('httpStatus', 200)`, awaits `this.runMiddleware(context, logic)`, and then answers with `turnState.get('httpStatus')` and `turnState.get('httpBody')`. Handlers change these with `bot.httpStatus()` and `bot.httpBody()`, and `sendActivities` can append replies to `httpBody`, as the web adapter's webhook mode does.
* **Knowing what the bot is waiting for.** After a turn, [controller.getPendingQuestion(context)](reference/core.md#getPendingQuestion) says whether a BotkitConversation is waiting for an answer. It gives the question's `key`, the raw `template` with its `quick_replies`, and a copy of the dialog's `vars`. Surfaces without a chat window use it to show a prompt, fill a form field, or answer from a file, instead of reading dialog internals.
* **A custom worker.** Set `botkit_worker` to a `BotWorker` subclass to give handlers extra methods. Override `startConversationWithUser()` with `this.changeContext(reference)`, as the Twilio, CLI and MCP workers do.

**Testing.** Pass `PassThrough` streams (or fakes for an API client) to the adapter, create the controller with `new Botkit({ adapter, disable_webserver: true, disable_console: true })`, write input, and read what the adapter writes. Call `await controller.shutdown()` after each test, so the adapter releases its streams and timers and mocha can exit without `--exit`.

These adapters in the Botkit repository are complete references:

* [botbuilder-adapter-cli](platforms/cli.md) reads a stream line by line. It has a turn queue, turn timeouts, quick replies as numbered menus, a `run()` API for wizards, and automatic answers from `getPendingQuestion()`.
* [botbuilder-adapter-mcp](platforms/mcp.md) speaks JSON-RPC over stdio. It has per-session queues, tool calls as events in their own conversations, and an outbox for proactive messages.
* [botbuilder-adapter-web](platforms/web.md) handles HTTP webhooks and websockets, and answers synchronously with `httpStatus` and `httpBody`.
