const assert = require('assert');
const { BotAdapter } = require('botbuilder');
const { Botkit, BotkitConversation } = require('botkit');
const { McpAdapter, McpBotWorker, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } = require('../');
const { setup, deferred, sleep, texts } = require('./shared');

/**
 * The pizza dialog from the spec: a size question with choices and validation, an address question, and a summary.
 */
function addOrderDialog(controller) {
    const convo = new BotkitConversation('order', controller);
    convo.ask({ text: ['Which size?'], quick_replies: [{ title: 'Small', payload: 'small' }, { title: 'Large', payload: 'large' }] }, [
        {
            pattern: '^(small|large)$',
            handler: async () => {
                // accepted
            }
        },
        {
            default: true,
            handler: async (answer, dialog, bot) => {
                await bot.say('Only small or large.');
                await dialog.repeat();
            }
        }
    ], 'size');
    convo.ask({ text: ['Delivery address?'] }, [], 'address');
    convo.say({ text: ['Ordered a {{vars.size}} pizza to {{{vars.address}}}.'] });
    controller.addDialog(convo);
    controller.hears('order', 'message', async (bot) => {
        await bot.beginDialog('order');
    });
}

/**
 * Wait until the adapter has answered every request it has received.
 */
async function settled(t) {
    await sleep(0);
    while (t.adapter.connection && t.adapter.connection.pending.size) {
        await Promise.all(Array.from(t.adapter.connection.pending));
    }
}

describe('McpAdapter', function() {
    let t;

    afterEach(async function() {
        if (t) {
            await t.close();
            t = null;
        }
    });

    describe('construction', function() {
        it('should use the documented defaults', function() {
            const adapter = new McpAdapter({ redirectConsole: false, autoStart: false });
            assert.strictEqual(adapter.name, 'MCP Adapter');
            assert.strictEqual(adapter.botkit_worker, McpBotWorker);
            assert.strictEqual(adapter.protocolVersion, null);
            assert.strictEqual(adapter.clientInfo, null);
            assert.strictEqual(adapter.clientId, 'mcp-client');
            assert.strictEqual(adapter.initialized, false);
            adapter.close();
        });

        it('should reject invalid options', function() {
            assert.throws(() => new McpAdapter({ redirectConsole: false, turnTimeout: -1 }), /turnTimeout/);
            assert.throws(() => new McpAdapter({ redirectConsole: false, maxOutbox: 1.5 }), /maxOutbox/);
            assert.throws(() => new McpAdapter({ redirectConsole: false, chatTool: { name: 'no spaces' } }), /Invalid chat tool name/);
        });

        it('should validate tool declarations', function() {
            t = setup();
            t.adapter.tool('menu', { description: 'The menu' });
            assert.throws(() => t.adapter.tool('menu'), /already declared/);
            assert.throws(() => t.adapter.tool('chat'), /used by the chat tool/);
            assert.throws(() => t.adapter.tool('bad name'), /Invalid MCP tool name/);
            assert.throws(() => t.adapter.tool('x'.repeat(129)), /Invalid MCP tool name/);
            assert.throws(() => t.adapter.tool('arr', { inputSchema: { type: 'array' } }), /inputSchema .* type: 'object'/);
            assert.throws(() => t.adapter.tool('out', { outputSchema: { type: 'string' } }), /outputSchema .* type: 'object'/);
            assert.strictEqual(t.adapter.tool('a.b-c_d'), t.adapter);
        });

        it('should register itself as controller.plugins.mcp', function() {
            t = setup();
            assert.strictEqual(t.controller.plugins.mcp, t.adapter);
        });

        it('should reject callTool() when it is not used with Botkit', async function() {
            const adapter = new McpAdapter({ redirectConsole: false, autoStart: false });
            await assert.rejects(adapter.callTool('chat', { message: 'hi' }), /not connected to Botkit/);
        });
    });

    describe('initialize, ping and tools/list', function() {
        beforeEach(function() {
            t = setup();
            t.adapter.tool('menu', {
                title: 'Menu',
                description: 'List the pizzas',
                inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
                outputSchema: { type: 'object', properties: { items: { type: 'array' } } },
                annotations: { readOnlyHint: true }
            });
        });

        it('should echo a supported protocol version', async function() {
            const response = await t.initialize('2025-06-18', { name: 'Claude Code', version: '2.0.0' });
            const result = response.result;
            assert.strictEqual(result.protocolVersion, '2025-06-18');
            assert.strictEqual(result.serverInfo.name, 'test-bot');
            assert.strictEqual(result.serverInfo.version, '0.0.1');
            assert.deepStrictEqual(result.capabilities, { tools: { listChanged: false }, logging: {} });
            assert.ok(result.instructions.includes('"chat"'));
            assert.ok(result.instructions.includes('It also offers these tools: menu.'));
            assert.strictEqual(t.adapter.protocolVersion, '2025-06-18');
            assert.deepStrictEqual(t.adapter.clientInfo, { name: 'Claude Code', version: '2.0.0' });
            assert.strictEqual(t.adapter.clientId, 'Claude-Code');
            await t.rpc('ping');
            assert.strictEqual(t.adapter.initialized, true);
        });

        it('should answer an unsupported protocol version with the latest', async function() {
            const response = await t.initialize('1999-01-01');
            assert.strictEqual(response.result.protocolVersion, '2025-11-25');
            assert.strictEqual(LATEST_PROTOCOL_VERSION, '2025-11-25');
            assert.deepStrictEqual(SUPPORTED_PROTOCOL_VERSIONS, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
        });

        it('should derive a safe client id', async function() {
            await t.initialize(undefined, { name: 'a/b c'.repeat(20) });
            assert.strictEqual(t.adapter.clientId, 'a-b-c'.repeat(20).slice(0, 64));
            await t.initialize(undefined, { name: '' });
            assert.strictEqual(t.adapter.clientId, 'mcp-client');
            await t.rpc('initialize', { protocolVersion: '2025-11-25' });
            assert.strictEqual(t.adapter.clientId, 'mcp-client');
            assert.strictEqual(t.adapter.clientInfo, null);
        });

        it('should answer ping with an empty object', async function() {
            const response = await t.rpc('ping');
            assert.deepStrictEqual(response, { jsonrpc: '2.0', id: response.id, result: {} });
        });

        it('should list the chat tool first, then declared tools', async function() {
            await t.initialize();
            const { tools } = (await t.rpc('tools/list', { cursor: 'ignored' })).result;
            assert.deepStrictEqual(tools.map((tool) => tool.name), ['chat', 'menu']);
            assert.deepStrictEqual(tools[0].inputSchema.required, ['message']);
            assert.strictEqual(tools[0].inputSchema.additionalProperties, false);
            assert.ok(tools[0].description.startsWith('Talk to the test-bot bot.'));
            assert.strictEqual(tools[1].annotations.readOnlyHint, true);
            assert.strictEqual(tools[1].description, 'List the pizzas');
        });

        it('should leave out titles and output schemas before protocol 2025-06-18', async function() {
            await t.initialize('2025-03-26');
            const old = (await t.rpc('tools/list')).result.tools;
            assert.ok(old.every((tool) => tool.outputSchema === undefined && tool.title === undefined));
            assert.strictEqual(old[1].annotations.readOnlyHint, true);

            await t.initialize('2025-06-18');
            const current = (await t.rpc('tools/list')).result.tools;
            assert.strictEqual(current[0].outputSchema.type, 'object');
            assert.deepStrictEqual(current[0].outputSchema.required, ['session', 'replies', 'awaitingInput']);
            assert.strictEqual(current[1].title, 'Menu');
            assert.strictEqual(current[1].outputSchema.type, 'object');
        });

        it('should give every declared tool an input schema', async function() {
            t.adapter.tool('status');
            const { tools } = (await t.rpc('tools/list')).result;
            assert.deepStrictEqual(tools[2], { name: 'status', inputSchema: { type: 'object', properties: {} } });
        });
    });

    describe('chatTool and instructions options', function() {
        it('should rename and describe the chat tool', async function() {
            t = setup({ chatTool: { name: 'talk', title: 'Talk', description: 'Talk to the pizza bot.' }, instructions: 'Be nice.' });
            const init = await t.initialize();
            assert.strictEqual(init.result.instructions, 'Be nice.');
            const { tools } = (await t.rpc('tools/list')).result;
            assert.deepStrictEqual([tools[0].name, tools[0].title, tools[0].description], ['talk', 'Talk', 'Talk to the pizza bot.']);
            t.controller.hears('hello', 'message', async (bot) => bot.say('Hi!'));
            const result = await t.callTool('talk', { message: 'hello' });
            assert.strictEqual(result.content[0].text, 'Hi!');
        });

        it('should offer only declared tools when chatTool is false', async function() {
            t = setup({ chatTool: false });
            t.adapter.tool('chat', { description: 'Not the chat tool' });
            const init = await t.initialize();
            assert.strictEqual(init.result.instructions, 'This server is a Botkit bot. It offers these tools: chat.');
            const { tools } = (await t.rpc('tools/list')).result;
            assert.deepStrictEqual(tools.map((tool) => tool.description), ['Not the chat tool']);
            const unknown = await t.rpc('tools/call', { name: 'talk', arguments: {} });
            assert.strictEqual(unknown.error.code, -32602);
        });
    });

    describe('chat tool', function() {
        beforeEach(async function() {
            t = setup();
            addOrderDialog(t.controller);
            t.controller.hears('hello', 'message', async (bot) => {
                await bot.say('Hi!');
            });
            await t.initialize();
        });

        it('should return the bot\'s replies', async function() {
            const result = await t.chat('hello', 's1');
            assert.strictEqual(result.content[0].text, 'Hi!');
            assert.strictEqual(result.isError, undefined);
            assert.strictEqual(result.structuredContent.session, 's1');
            assert.strictEqual(result.structuredContent.replies[0].text, 'Hi!');
            assert.strictEqual(result.structuredContent.awaitingInput, false);
            assert.strictEqual(result.structuredContent.pendingQuestion, null);
            assert.deepStrictEqual(result.structuredContent.proactive, []);
            assert.deepStrictEqual(result.structuredContent.choices, []);
        });

        it('should use the default session', async function() {
            const result = await t.chat('order');
            assert.strictEqual(result.structuredContent.session, 'default');
            assert.match(result.content[0].text, /Call chat again with session "default"/);
        });

        it('should walk a dialog step by step', async function() {
            const first = await t.chat('order', 's1');
            assert.strictEqual(first.structuredContent.awaitingInput, true);
            assert.deepStrictEqual(first.structuredContent.pendingQuestion, { dialog: 'order', thread: 'default', key: 'size' });
            assert.deepStrictEqual(first.structuredContent.choices, [{ title: 'Small', value: 'small' }, { title: 'Large', value: 'large' }]);
            assert.ok(first.content[0].text.includes('Choices: "Small" (send "small")'));
            assert.ok(first.content[0].text.includes('(Waiting for your answer to "size". Call chat again with session "s1".)'));

            const second = await t.chat('Large', 's1');
            assert.strictEqual(second.structuredContent.pendingQuestion.key, 'address');
            assert.strictEqual(second.content[0].text, 'Delivery address?\n(Waiting for your answer to "address". Call chat again with session "s1".)');

            const third = await t.chat('1 Main St.', 's1');
            assert.ok(third.content[0].text.includes('Ordered a large pizza to 1 Main St.'));
            assert.strictEqual(third.structuredContent.awaitingInput, false);
            assert.strictEqual(third.structuredContent.pendingQuestion, null);
        });

        it('should keep asking when an answer does not pass validation', async function() {
            await t.chat('order', 's1');
            const result = await t.chat('huge', 's1');
            assert.ok(result.content[0].text.includes('Only small or large.'));
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'size');
            assert.strictEqual(result.structuredContent.choices.length, 2);
        });

        it('should keep sessions apart', async function() {
            await t.chat('order', 's1');
            const other = await t.chat('hello', 's2');
            assert.strictEqual(other.content[0].text, 'Hi!');
            assert.strictEqual(other.structuredContent.awaitingInput, false);
            const back = await t.chat('Large', 's1');
            assert.strictEqual(back.structuredContent.pendingQuestion.key, 'address');
        });

        it('should send the value of a choice when the agent sends its title', async function() {
            let seen;
            t.controller.middleware.receive.use(async (bot, message) => {
                seen = message;
            });
            await t.chat('order', 's1');
            await t.chat('  lArGe ', 's1');
            assert.strictEqual(seen.text, 'large');
            assert.strictEqual(seen.value, 'large');
        });

        it('should not offer the choices of an answered question', async function() {
            await t.chat('order', 's1');
            const result = await t.chat('Large', 's1');
            assert.deepStrictEqual(result.structuredContent.choices, []);
            let seen;
            t.controller.middleware.receive.use(async (bot, message) => {
                seen = message;
            });
            await t.chat('Small', 's1');
            assert.strictEqual(seen.text, 'Small');
            assert.strictEqual(seen.value, undefined);
        });

        it('should keep the choices while the same question is waiting', async function() {
            t.controller.interrupts('help', 'message', async (bot) => {
                await bot.say('Pick a size for your pizza.');
            });
            await t.chat('order', 's1');
            const help = await t.chat('help', 's1');
            assert.strictEqual(help.content[0].text.split('\n')[0], 'Pick a size for your pizza.');
            assert.strictEqual(help.structuredContent.pendingQuestion.key, 'size');
            assert.strictEqual(help.structuredContent.choices.length, 2);
            const next = await t.chat('Small', 's1');
            assert.strictEqual(next.structuredContent.pendingQuestion.key, 'address');
        });

        it('should pass MCP details to handlers', async function() {
            let seen;
            t.controller.hears('who', 'message', async (bot, message) => {
                seen = message;
                await bot.say('you');
            });
            const response = await t.rpc('tools/call', { name: 'chat', arguments: { message: 'who', session: 'me@x' } });
            assert.deepStrictEqual(seen.mcp, { requestId: response.id, tool: 'chat', session: 'me@x' });
            assert.strictEqual(seen.user, 'test-client');
            assert.strictEqual(seen.channel, 'session:me@x');
            assert.strictEqual(seen.incoming_message.channelId, 'mcp');
            assert.strictEqual(seen.incoming_message.from.name, 'test-client');
            assert.strictEqual(seen.reference.bot.id, 'bot');
        });

        it('should give handlers an McpBotWorker', async function() {
            let worker;
            t.controller.hears('worker', 'message', async (bot) => {
                worker = bot;
            });
            await t.chat('worker', 's1');
            assert.ok(worker instanceof McpBotWorker);
        });

        it('should cancel a waiting dialog on reset', async function() {
            await t.chat('order', 's1');
            const result = await t.chat('', 's1', { reset: true });
            assert.strictEqual(result.structuredContent.awaitingInput, false);
            assert.strictEqual(result.structuredContent.pendingQuestion, null);
            assert.deepStrictEqual(result.structuredContent.choices, []);
            assert.strictEqual(result.content[0].text, '(no reply)');
            const fresh = await t.chat('hello', 's1', { reset: true });
            assert.strictEqual(fresh.content[0].text, 'Hi!');
        });

        it('should report the waiting question without running a turn for an empty message', async function() {
            await t.chat('order', 's1');
            let turns = 0;
            t.controller.middleware.receive.use(async () => {
                turns++;
            });
            const result = await t.chat('', 's1');
            assert.strictEqual(turns, 0);
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'size');
            assert.deepStrictEqual(result.structuredContent.replies, []);
            assert.strictEqual(result.content[0].text, '(Waiting for your answer to "size". Call chat again with session "s1".)');
        });

        it('should decode the HTML entities mustache adds', async function() {
            const greet = new BotkitConversation('greet', t.controller);
            greet.say('{{vars.name}}');
            t.controller.addDialog(greet);
            t.controller.hears('greet', 'message', async (bot) => {
                await bot.beginDialog('greet', { name: 'O\'Neil & co' });
            });
            const result = await t.chat('greet', 's1');
            assert.strictEqual(result.structuredContent.replies[0].text, 'O\'Neil & co');
            assert.strictEqual(result.content[0].text, 'O\'Neil & co');
        });

        it('should reject invalid arguments with a tool error', async function() {
            const missing = await t.callTool('chat', { session: 's1' });
            assert.strictEqual(missing.isError, true);
            assert.strictEqual(missing.content[0].text, 'Invalid arguments for tool "chat": missing required property "message"');
            const badSession = await t.chat('hello', 'no spaces allowed');
            assert.strictEqual(badSession.isError, true);
            assert.match(badSession.content[0].text, /property "session" must be 1 to 128/);
            const extra = await t.callTool('chat', { message: 'hi', mood: 'happy' });
            assert.match(extra.content[0].text, /unexpected property "mood"/);
            const wrongType = await t.callTool('chat', { message: 42 });
            assert.match(wrongType.content[0].text, /property "message" must be string/);
        });

        it('should report bot.toolError() and ignore bot.toolResult() in a chat handler', async function() {
            t.controller.hears('pay', 'message', async (bot) => {
                await bot.say('Trying to pay...');
                bot.toolResult({ ignored: true });
                bot.toolError('The payment service is down.');
            });
            const result = await t.chat('pay', 's1');
            assert.strictEqual(result.isError, true);
            assert.deepStrictEqual(texts(result), ['Trying to pay...', 'The payment service is down.']);
            assert.strictEqual(result.structuredContent.ignored, undefined);
            assert.strictEqual(result.structuredContent.replies.length, 1);
        });

        it('should turn a failing handler into a tool error and keep serving', async function() {
            t.controller.hears('boom', 'message', async (bot) => {
                await bot.say('about to fail');
                throw new Error('boom');
            });
            const result = await t.chat('boom', 's1');
            assert.strictEqual(result.isError, true);
            assert.strictEqual(result.content[0].text, 'The bot failed to handle this message: boom\nabout to fail');
            assert.strictEqual(result.structuredContent.replies[0].text, 'about to fail');
            assert.strictEqual(result.structuredContent.awaitingInput, false);
            assert.deepStrictEqual((await t.rpc('ping')).result, {});
            assert.strictEqual((await t.chat('hello', 's1')).content[0].text, 'Hi!');
        });

        it('should report a failed turn even when adapter.onTurnError handles it', async function() {
            t.adapter.onTurnError = async (context, err) => {
                await context.sendActivity(`Sorry, that did not work (${ err.message }).`);
            };
            t.controller.interrupts('crash', 'message', async (bot) => {
                await bot.cancelAllDialogs();
                throw new Error('crashed');
            });
            await t.chat('order', 's1');
            const result = await t.chat('crash', 's1');
            assert.strictEqual(result.isError, true);
            assert.strictEqual(result.structuredContent.replies[0].text, 'Sorry, that did not work (crashed).');
            // the cancellation was never saved, so the dialog is still waiting
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'size');
        });

        it('should keep a dialog waiting after a failed turn', async function() {
            t.controller.interrupts('crash', 'message', async () => {
                throw new Error('crashed');
            });
            await t.chat('order', 's1');
            const result = await t.chat('crash', 's1');
            assert.strictEqual(result.isError, true);
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'size');
            assert.match(result.content[0].text, /\(Waiting for your answer to "size"/);
        });

        it('should run the calls of one session one at a time', async function() {
            const order = [];
            t.controller.hears('first', 'message', async (bot) => {
                order.push('first:start');
                await sleep(50);
                order.push('first:end');
                await bot.say('1');
            });
            t.controller.hears('second', 'message', async (bot) => {
                order.push('second');
                await bot.say('2');
            });
            const results = await Promise.all([t.chat('first', 's1'), t.chat('second', 's1')]);
            assert.deepStrictEqual(order, ['first:start', 'first:end', 'second']);
            assert.deepStrictEqual(results.map((result) => result.content[0].text), ['1', '2']);
        });

        it('should run calls of different sessions at the same time', async function() {
            const s2Started = deferred();
            t.controller.hears('slow', 'message', async (bot, message) => {
                if (message.channel === 'session:s2') {
                    s2Started.resolve();
                } else {
                    // s1 can only finish because s2 started while s1 was still running
                    await s2Started.promise;
                }
                await sleep(50);
                await bot.say('done');
            });
            const start = Date.now();
            await Promise.all([t.chat('slow', 's1'), t.chat('slow', 's2')]);
            assert.ok(Date.now() - start < 90, `took ${ Date.now() - start }ms`);
        });

        it('should leave out structuredContent before protocol 2025-06-18', async function() {
            await t.initialize('2025-03-26');
            const result = await t.chat('hello', 's1');
            assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'Hi!' }] });
        });

        it('should accept calls before initialize', async function() {
            const u = setup();
            try {
                u.controller.hears('hello', 'message', async (bot, message) => {
                    await bot.say(`Hi ${ message.user }!`);
                });
                const result = await u.chat('hello');
                assert.strictEqual(result.content[0].text, 'Hi mcp-client!');
                assert.ok(result.structuredContent);
            } finally {
                await u.close();
            }
        });
    });

    describe('chat turn timeout', function() {
        it('should return an error when a turn takes too long, and deliver its late replies later', async function() {
            t = setup({ turnTimeout: 100 });
            const release = deferred();
            t.controller.hears('hang', 'message', async (bot) => {
                await release.promise;
                await bot.say('finally done');
            });
            await t.initialize();
            const start = Date.now();
            const result = await t.chat('hang', 's1');
            assert.ok(Date.now() - start < 1000);
            assert.strictEqual(result.isError, true);
            assert.match(result.content[0].text, /timed out after 100ms/);

            release.resolve();
            const note = await t.waitFor((m) => m.method === 'notifications/message');
            assert.strictEqual(note.params.data.text, 'finally done');
            const next = await t.chat('', 's1');
            assert.strictEqual(next.structuredContent.proactive[0].text, 'finally done');
        });

        it('should time out a handler that never finishes', async function() {
            t = setup({ turnTimeout: 100 });
            t.controller.hears('never', 'message', () => new Promise(() => {
                // never settles
            }));
            const start = Date.now();
            const result = await t.chat('never', 's1');
            assert.ok(Date.now() - start < 1000);
            assert.strictEqual(result.isError, true);
            assert.match(result.content[0].text, /timed out after 100ms/);
            assert.deepStrictEqual((await t.rpc('ping')).result, {});
        });
    });

    describe('declared tools', function() {
        beforeEach(async function() {
            t = setup();
            addOrderDialog(t.controller);
            t.adapter.tool('menu', {
                description: 'List the pizzas',
                inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'] },
                annotations: { readOnlyHint: true }
            });
            t.controller.on('tool:menu', async (bot, message) => {
                await bot.say('Margherita $9');
                bot.toolResult({ items: [message.value.filter] });
            });
            await t.initialize();
        });

        it('should call the tool handler with the arguments', async function() {
            const result = await t.callTool('menu', { filter: 'veg' });
            assert.deepStrictEqual(result.structuredContent, { items: ['veg'] });
            assert.deepStrictEqual(texts(result), ['Margherita $9', '{"items":["veg"]}']);
            assert.strictEqual(result.isError, undefined);
        });

        it('should not disturb a dialog waiting in a chat session', async function() {
            await t.chat('order', 's1');
            await t.callTool('menu', { filter: 'veg' });
            const result = await t.chat('small', 's1');
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'address');
        });

        it('should pass MCP details to the handler', async function() {
            let seen;
            t.adapter.tool('inspect');
            t.controller.on('tool:inspect', async (bot, message) => {
                seen = message;
            });
            const response = await t.rpc('tools/call', { name: 'inspect', arguments: { a: 1 } });
            assert.strictEqual(seen.type, 'tool:inspect');
            assert.deepStrictEqual(seen.value, { a: 1 });
            assert.deepStrictEqual(seen.mcp, { requestId: response.id, tool: 'inspect' });
            assert.strictEqual(seen.user, 'test-client');
            assert.match(seen.channel, /^tool:inspect:\d+$/);
            assert.deepStrictEqual(response.result, { content: [{ type: 'text', text: '(no output)' }] });
        });

        it('should remove the conversation state of each call from storage', async function() {
            await t.callTool('menu', { filter: 'veg' });
            await t.callTool('menu', { filter: 'meat' });
            const memory = t.controller.storage.memory;
            const kept = Object.keys(memory).filter((key) => key.includes('/conversations/tool:') && memory[key] !== undefined);
            assert.deepStrictEqual(kept, []);
        });

        it('should return a tool error for invalid arguments', async function() {
            const result = await t.callTool('menu', {});
            assert.strictEqual(result.isError, true);
            assert.match(result.content[0].text, /Invalid arguments for tool "menu": missing required property "filter"/);
        });

        it('should answer an unknown tool with -32602', async function() {
            const response = await t.rpc('tools/call', { name: 'nope', arguments: {} });
            assert.strictEqual(response.error.code, -32602);
            assert.match(response.error.message, /Unknown tool: nope/);
        });

        it('should fail when a tool with an outputSchema does not call toolResult()', async function() {
            t.adapter.tool('strict', { outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } });
            t.controller.on('tool:strict', async (bot) => {
                await bot.say('forgot the result');
            });
            const result = await t.callTool('strict', {});
            assert.strictEqual(result.isError, true);
            assert.deepStrictEqual(texts(result), ['forgot the result', 'Tool "strict" declared an outputSchema but its handler did not call bot.toolResult()']);
        });

        it('should report bot.toolError()', async function() {
            t.adapter.tool('broken');
            t.controller.on('tool:broken', async (bot) => {
                bot.toolError('nope');
            });
            const result = await t.callTool('broken', {});
            assert.strictEqual(result.isError, true);
            assert.ok(texts(result).includes('nope'));

            t.adapter.tool('silent');
            t.controller.on('tool:silent', async (bot) => {
                bot.toolError();
            });
            const silent = await t.callTool('silent', {});
            assert.deepStrictEqual(silent, { content: [{ type: 'text', text: 'Tool "silent" reported an error.' }], isError: true });
        });

        it('should report a handler that throws', async function() {
            t.adapter.tool('crash');
            t.controller.on('tool:crash', async () => {
                throw new Error('kaboom');
            });
            const result = await t.callTool('crash', {});
            assert.strictEqual(result.isError, true);
            assert.deepStrictEqual(texts(result), ['Tool "crash" failed: kaboom']);
        });

        it('should reject results that are not plain JSON objects', async function() {
            t.adapter.tool('bad');
            t.controller.on('tool:bad', async (bot, message) => {
                if (message.value.kind === 'array') {
                    bot.toolResult([1, 2]);
                } else if (message.value.kind === 'date') {
                    bot.toolResult(new Date(0));
                } else {
                    const circular = {};
                    circular.self = circular;
                    bot.toolResult(circular);
                }
            });
            const array = await t.callTool('bad', { kind: 'array' });
            assert.strictEqual(array.isError, true);
            assert.match(array.content[0].text, /expects a plain object/);
            const date = await t.callTool('bad', { kind: 'date' });
            assert.strictEqual(date.isError, true);
            assert.match(date.content[0].text, /expects a plain object/);
            const circular = await t.callTool('bad', { kind: 'circular' });
            assert.strictEqual(circular.isError, true);
            assert.match(circular.content[0].text, /serialized as JSON/);
        });

        it('should snapshot the result when toolResult() is called', async function() {
            t.adapter.tool('snap');
            t.controller.on('tool:snap', async (bot) => {
                const result = { count: 1, at: new Date(0) };
                bot.toolResult(result);
                result.count = 2;
            });
            const result = await t.callTool('snap', {});
            assert.deepStrictEqual(result.structuredContent, { count: 1, at: '1970-01-01T00:00:00.000Z' });
        });

        it('should only send the result as text before protocol 2025-06-18', async function() {
            await t.initialize('2025-03-26');
            const result = await t.callTool('menu', { filter: 'veg' });
            assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'Margherita $9' }, { type: 'text', text: '{"items":["veg"]}' }] });
        });

        it('should run tool calls at the same time', async function() {
            const gate = deferred();
            t.adapter.tool('wait');
            t.adapter.tool('open');
            t.controller.on('tool:wait', async (bot) => {
                await gate.promise;
                bot.toolResult({ waited: true });
            });
            t.controller.on('tool:open', async (bot) => {
                gate.resolve();
                bot.toolResult({ opened: true });
            });
            const results = await Promise.all([t.callTool('wait', {}), t.callTool('open', {})]);
            assert.deepStrictEqual(results.map((result) => result.structuredContent), [{ waited: true }, { opened: true }]);
        });
    });

    describe('proactive messages', function() {
        beforeEach(async function() {
            t = setup();
            await t.initialize();
        });

        it('should notify the client and deliver on the next chat call', async function() {
            let turns = 0;
            t.controller.middleware.receive.use(async () => {
                turns++;
            });
            const bot = await t.controller.spawn({}, t.adapter);
            assert.ok(bot instanceof McpBotWorker);
            await bot.startConversationWithUser('s1');
            await bot.say('ping from timer');

            const note = await t.waitFor((m) => m.method === 'notifications/message');
            assert.deepStrictEqual(note.params, { level: 'info', logger: 'botkit', data: { session: 's1', type: 'message', text: 'ping from timer' } });

            const result = await t.chat('', 's1');
            assert.strictEqual(result.structuredContent.proactive[0].text, 'ping from timer');
            assert.strictEqual(result.content[0].text, '[message received while you were away] ping from timer');
            assert.strictEqual(turns, 0);

            const again = await t.chat('', 's1');
            assert.deepStrictEqual(again.structuredContent.proactive, []);
        });

        it('should deliver waiting messages before the replies of a turn', async function() {
            t.controller.hears('hello', 'message', async (bot) => {
                await bot.say('Hi!');
            });
            const bot = await t.controller.spawn({}, t.adapter);
            await bot.startConversationWithUser('s1');
            await bot.say('reminder');
            const result = await t.chat('hello', 's1');
            assert.strictEqual(result.content[0].text, '[message received while you were away] reminder\nHi!');
        });

        it('should keep at most maxOutbox messages per session', async function() {
            await t.close();
            t = setup({ maxOutbox: 2 });
            const bot = await t.controller.spawn({}, t.adapter);
            await bot.startConversationWithUser('s1');
            await bot.say('one');
            await bot.say('two');
            await bot.say('three');
            const result = await t.chat('', 's1');
            assert.deepStrictEqual(result.structuredContent.proactive.map((reply) => reply.text), ['two', 'three']);
        });

        it('should map the titles of choices offered by a proactive message', async function() {
            let seen;
            t.controller.hears('^5$', 'message', async (bot, message) => {
                seen = message;
                await bot.say('Thanks!');
            });
            const bot = await t.controller.spawn({}, t.adapter);
            await bot.startConversationWithUser('s1');
            await bot.say({ text: 'How was your pizza?', quick_replies: [{ title: 'Great', payload: '5' }, { title: 'Bad', payload: '1' }] });
            const result = await t.chat('great', 's1');
            assert.strictEqual(seen.text, '5');
            assert.strictEqual(result.structuredContent.proactive[0].choices.length, 2);
            assert.ok(result.content[0].text.endsWith('Thanks!'));
        });

        it('should deliver messages from continueConversation', async function() {
            await t.adapter.continueConversation(t.adapter.getReference('s9'), async (context) => {
                await context.sendActivity('continued');
            });
            const result = await t.chat('', 's9');
            assert.strictEqual(result.structuredContent.proactive[0].text, 'continued');
        });

        it('should let a proactive bot start a dialog in a session', async function() {
            addOrderDialog(t.controller);
            const bot = await t.controller.spawn({}, t.adapter);
            await bot.startConversationWithUser('s1');
            await bot.beginDialog('order');
            const result = await t.chat('', 's1');
            assert.strictEqual(result.structuredContent.proactive[0].text, 'Which size?');
            assert.strictEqual(result.structuredContent.pendingQuestion.key, 'size');
            const next = await t.chat('Small', 's1');
            assert.strictEqual(next.structuredContent.pendingQuestion.key, 'address');
        });

        it('should validate sessions in getReference()', function() {
            assert.deepStrictEqual(t.adapter.getReference(), {
                channelId: 'mcp',
                conversation: { id: 'session:default' },
                user: { id: 'test-client' },
                bot: { id: 'bot', name: 'test-bot' }
            });
            assert.throws(() => t.adapter.getReference('bad session'), /Invalid MCP session/);
        });
    });

    describe('progress and logging', function() {
        beforeEach(async function() {
            t = setup();
            t.adapter.tool('work');
            t.controller.on('tool:work', async (bot) => {
                bot.progress(1, 2, 'half');
                bot.toolResult({ ok: true });
            });
            await t.initialize();
        });

        it('should send progress notifications before the response', async function() {
            const response = await t.rpc('tools/call', { name: 'work', arguments: {} }, { progressToken: 'tok' });
            const messages = t.lines.map((line) => JSON.parse(line));
            const progressIndex = messages.findIndex((m) => m.method === 'notifications/progress');
            const responseIndex = messages.findIndex((m) => m.id === response.id);
            assert.ok(progressIndex >= 0 && progressIndex < responseIndex);
            assert.deepStrictEqual(messages[progressIndex].params, { progressToken: 'tok', progress: 1, total: 2, message: 'half' });
        });

        it('should not send progress without a progress token', async function() {
            await t.callTool('work', {});
            assert.strictEqual(t.notifications.filter((m) => m.method === 'notifications/progress').length, 0);
        });

        it('should filter log messages by the level the client sets', async function() {
            t.adapter.tool('logs');
            t.controller.on('tool:logs', async (bot) => {
                bot.log('info', 'x');
                bot.log('error', { e: 1 });
                bot.log('critical', 'y', 'custom');
            });
            const set = await t.rpc('logging/setLevel', { level: 'warning' });
            assert.deepStrictEqual(set.result, {});
            await t.callTool('logs', {});
            const logs = t.notifications.filter((m) => m.method === 'notifications/message');
            assert.deepStrictEqual(logs.map((m) => m.params), [
                { level: 'error', logger: 'botkit', data: { e: 1 } },
                { level: 'critical', logger: 'custom', data: 'y' }
            ]);
        });

        it('should reject an unknown log level', async function() {
            const response = await t.rpc('logging/setLevel', { level: 'loud' });
            assert.strictEqual(response.error.code, -32602);
            assert.throws(() => t.adapter.log('loud', 'x'), /Unknown MCP log level/);
        });

        it('should apply the log level to proactive notifications', async function() {
            await t.rpc('logging/setLevel', { level: 'error' });
            const bot = await t.controller.spawn({}, t.adapter);
            await bot.startConversationWithUser('s1');
            await bot.say('quiet');
            bot.log('error', 'loud');
            await t.waitFor((m) => m.method === 'notifications/message');
            assert.deepStrictEqual(t.notifications.map((m) => m.params.data), ['loud']);
            const result = await t.chat('', 's1');
            assert.strictEqual(result.structuredContent.proactive[0].text, 'quiet');
        });

        it('should ignore tool helpers outside a tool call', async function() {
            const bot = await t.controller.spawn({}, t.adapter);
            bot.toolResult({ ignored: true });
            bot.toolError('ignored');
            bot.progress(1);
            await t.rpc('ping');
            assert.deepStrictEqual(t.notifications, []);
        });
    });

    describe('cancellation', function() {
        it('should drop the response of a cancelled request', async function() {
            t = setup();
            const gate = deferred();
            t.adapter.tool('slow');
            t.controller.on('tool:slow', async (bot) => {
                await gate.promise;
                bot.toolResult({ finished: true });
            });
            t.raw(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow', arguments: {} } }) + '\n');
            t.notify('notifications/cancelled', { requestId: 7, reason: 'The user pressed Esc' });
            const ping = await t.rpc('ping');
            assert.deepStrictEqual(ping.result, {});
            gate.resolve();
            await settled(t);
            await t.rpc('ping');
            assert.strictEqual(t.responses.filter((m) => m.id === 7).length, 0);
        });

        it('should skip a queued chat call that was cancelled', async function() {
            t = setup();
            const gate = deferred();
            const heard = [];
            t.controller.hears('.*', 'message', async (bot, message) => {
                heard.push(message.text);
                if (message.text === 'first') {
                    await gate.promise;
                }
            });
            t.raw(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'chat', arguments: { message: 'first' } } }) + '\n');
            t.raw(JSON.stringify({ jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'chat', arguments: { message: 'second' } } }) + '\n');
            t.notify('notifications/cancelled', { requestId: 'b' });
            await t.rpc('ping');
            gate.resolve();
            await t.waitFor((m) => m.id === 'a');
            await settled(t);
            assert.deepStrictEqual(heard, ['first']);
            assert.strictEqual(t.responses.filter((m) => m.id === 'b').length, 0);
        });

        it('should ignore cancellation of requests that are not running', async function() {
            t = setup();
            t.notify('notifications/cancelled', { requestId: 1 });
            const response = await t.rpc('ping');
            assert.strictEqual(response.id, 1);
            assert.deepStrictEqual(response.result, {});
        });
    });

    describe('lifecycle', function() {
        it('should shut Botkit down when the input ends', async function() {
            t = setup();
            const shutdown = deferred();
            t.controller.on('shutdown', async () => {
                shutdown.resolve();
            });
            await t.rpc('ping');
            t.input.end();
            await shutdown.promise;
        });

        it('should answer requests in progress before shutting down', async function() {
            t = setup();
            const gate = deferred();
            const shutdown = deferred();
            t.adapter.tool('slow');
            t.controller.on('tool:slow', async (bot) => {
                await gate.promise;
                bot.toolResult({ done: true });
            });
            t.controller.on('shutdown', async () => {
                shutdown.resolve(t.responses.slice());
            });
            t.raw(JSON.stringify({ jsonrpc: '2.0', id: 'last', method: 'tools/call', params: { name: 'slow', arguments: {} } }) + '\n');
            t.input.end();
            await sleep(10);
            gate.resolve();
            const responses = await shutdown.promise;
            assert.deepStrictEqual(responses.map((m) => m.id), ['last']);
            assert.deepStrictEqual(responses[0].result.structuredContent, { done: true });
        });

        it('should not shut Botkit down when shutdownOnClose is false', async function() {
            t = setup({ shutdownOnClose: false });
            let shutdowns = 0;
            t.controller.on('shutdown', async () => {
                shutdowns++;
            });
            await t.rpc('ping');
            t.input.end();
            await sleep(20);
            assert.strictEqual(shutdowns, 0);
            assert.throws(() => t.adapter.listen(), /closed/);
        });

        it('should stop answering after controller.shutdown()', async function() {
            t = setup();
            await t.rpc('ping');
            await t.controller.shutdown();
            t.raw(JSON.stringify({ jsonrpc: '2.0', id: 'after', method: 'ping' }) + '\n');
            t.adapter.notify('notifications/message', { level: 'info', data: 'dropped' });
            await sleep(20);
            assert.strictEqual(t.lines.length, 1);
            assert.throws(() => t.adapter.listen(), /closed/);
        });

        it('should not start listening when shut down before it is ready', async function() {
            t = setup();
            await t.controller.shutdown();
            t.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
            await sleep(20);
            assert.strictEqual(t.lines.length, 0);
        });

        it('should listen only when asked when autoStart is false', async function() {
            t = setup({ autoStart: false });
            t.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
            await sleep(20);
            assert.strictEqual(t.lines.length, 0);
            t.adapter.listen();
            t.adapter.listen();
            const response = await t.waitFor((m) => m.id === 1);
            assert.deepStrictEqual(response.result, {});
        });

        it('should answer HTTP requests with 405', async function() {
            t = setup();
            const res = {
                headers: {},
                setHeader(name, value) {
                    this.headers[name] = value;
                },
                end(body) {
                    this.body = body;
                }
            };
            await t.adapter.processActivity({ body: {} }, res, async () => {
                throw new Error('should not run');
            });
            assert.strictEqual(res.statusCode, 405);
            assert.strictEqual(res.headers['Content-Type'], 'application/json');
            assert.deepStrictEqual(JSON.parse(res.body), { error: 'The MCP adapter speaks JSON-RPC over stdio; HTTP is not supported' });
        });

        it('should treat update and delete as no-ops', async function() {
            t = setup();
            await t.adapter.updateActivity(null, { id: 'x' });
            await t.adapter.deleteActivity(null, { activityId: 'x' });
        });

        it('should send console output to stderr while redirected', function() {
            const writes = [];
            const originalWrite = process.stderr.write;
            const originalLog = console.log;
            const adapter = new McpAdapter({ redirectConsole: true, autoStart: false });
            const second = new McpAdapter({ redirectConsole: true, autoStart: false });
            try {
                process.stderr.write = (chunk) => {
                    writes.push(String(chunk));
                    return true;
                };
                console.log('hello %s', 'stderr');
                console.info('info');
                console.dir({ a: 1 });
                adapter.close();
                console.debug('still redirected');
            } finally {
                process.stderr.write = originalWrite;
                second.close();
            }
            assert.deepStrictEqual(writes, ['hello stderr\n', 'info\n', '{ a: 1 }\n', 'still redirected\n']);
            assert.strictEqual(console.log, originalLog);
        });

        it('should redirect the console by default when writing to stdout', function() {
            const originalLog = console.log;
            const adapter = new McpAdapter({ autoStart: false });
            const redirected = console.log !== originalLog;
            adapter.close();
            assert.strictEqual(redirected, true);
            assert.strictEqual(console.log, originalLog);
            const quiet = new McpAdapter({ output: new (require('stream').PassThrough)(), autoStart: false });
            assert.strictEqual(console.log, originalLog);
            quiet.close();
        });
    });

    describe('alongside another adapter', function() {
        it('should serve MCP when added with usePlugin()', async function() {
            class OtherAdapter extends BotAdapter {
                constructor() {
                    super();
                    this.name = 'Other Adapter';
                }

                async sendActivities(context, activities) {
                    return activities.map(() => ({ id: 'other' }));
                }

                async updateActivity() {
                    // not used
                }

                async deleteActivity() {
                    // not used
                }

                async continueConversation() {
                    // not used
                }
            }
            const { PassThrough } = require('stream');
            const input = new PassThrough();
            const output = new PassThrough();
            const mcp = new McpAdapter({ input, output, autoStart: false });
            const controller = new Botkit({ adapter: new OtherAdapter(), disable_webserver: true, disable_console: true });
            try {
                controller.usePlugin(mcp);
                controller.hears('hello', 'message', async (bot) => {
                    await bot.say(bot instanceof McpBotWorker ? 'Hi agent!' : 'Hi human!');
                });
                const result = await mcp.callTool('chat', { message: 'hello' });
                assert.strictEqual(result.content[0].text, 'Hi agent!');
                assert.strictEqual(controller.plugins.mcp, mcp);
            } finally {
                await controller.shutdown();
            }
        });
    });
});
