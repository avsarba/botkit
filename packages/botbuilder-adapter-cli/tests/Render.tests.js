const assert = require('assert');
const { unescapeHtml, getChoices, renderActivity, renderJson, progressBar, stripAnsi } = require('../');

const ESC = '\u001b';

const options = (extra = {}) => ({ botName: 'bot', currentUser: 'ann', color: false, verbose: false, unescapeHtml: true, ...extra });

const envQuestion = () => ({
    type: 'message',
    text: 'Which env?',
    channelData: { quick_replies: [{ title: 'Staging', payload: 'staging' }, { title: 'Production', payload: 'production' }] }
});

describe('Render', function() {
    describe('unescapeHtml', function() {
        it('should reverse exactly the entities mustache escapes', async function() {
            assert.strictEqual(
                unescapeHtml('O&#39;Neil &amp; co &lt;https:&#x2F;&#x2F;a.b&#x2F;c?d&#x3D;1&amp;e&#x3D;2&gt;'),
                'O\'Neil & co <https://a.b/c?d=1&e=2>'
            );
            assert.strictEqual(unescapeHtml('&quot;quoted&quot; &#x60;code&#x60;'), '"quoted" `code`');
        });

        it('should decode in a single pass', async function() {
            assert.strictEqual(unescapeHtml('&amp;lt;'), '&lt;');
            assert.strictEqual(unescapeHtml('&amp;amp;'), '&amp;');
        });

        it('should leave other entities and plain text alone', async function() {
            assert.strictEqual(unescapeHtml('&nbsp; &#40; 5 > 3'), '&nbsp; &#40; 5 > 3');
            assert.strictEqual(unescapeHtml(''), '');
            assert.strictEqual(unescapeHtml(null), '');
            assert.strictEqual(unescapeHtml(undefined), '');
        });
    });

    describe('stripAnsi', function() {
        it('should remove color sequences only', async function() {
            assert.strictEqual(stripAnsi(`${ ESC }[1;36mbot> ${ ESC }[0mHi ${ ESC }[1m[1]${ ESC }[0m`), 'bot> Hi [1]');
            assert.strictEqual(stripAnsi('plain [1] text'), 'plain [1] text');
        });
    });

    describe('progressBar', function() {
        it('should draw ten cells with a percentage and label', async function() {
            assert.strictEqual(progressBar(3, 10, 'Migrating'), '[###-------] 30% Migrating');
            assert.strictEqual(progressBar(1, 3), '[###-------] 33%');
            assert.strictEqual(progressBar(10, 10), '[##########] 100%');
        });

        it('should clamp and handle a zero or invalid total', async function() {
            assert.strictEqual(progressBar(0, 0), '[----------] 0%');
            assert.strictEqual(progressBar(12, 10), '[##########] 100%');
            assert.strictEqual(progressBar(-5, 10), '[----------] 0%');
            assert.strictEqual(progressBar(5, -1), '[----------] 0%');
            assert.strictEqual(progressBar(NaN, 10), '[----------] 0%');
        });
    });

    describe('getChoices', function() {
        it('should prefer channelData.quick_replies over suggestedActions', async function() {
            const choices = getChoices({
                channelData: { quick_replies: [{ title: 'Red', payload: 'red' }] },
                suggestedActions: { actions: [{ title: 'Blue', value: 'blue' }] }
            });
            assert.deepStrictEqual(choices, [{ title: 'Red', value: 'red' }]);
        });

        it('should fall back to suggestedActions and stringify values', async function() {
            const choices = getChoices({
                channelData: { quick_replies: [] },
                suggestedActions: { actions: [{ type: 'postBack', title: 'One', value: 1 }, { type: 'imBack', title: 'Two', value: 'two' }] }
            });
            assert.deepStrictEqual(choices, [{ title: 'One', value: '1' }, { title: 'Two', value: 'two' }]);
        });

        it('should stringify numeric payloads and fall back between title and payload', async function() {
            const choices = getChoices({ channelData: { quick_replies: [{ title: 'Port 80', payload: 80 }, { payload: 'only-payload' }, { title: 'only-title' }] } });
            assert.deepStrictEqual(choices, [
                { title: 'Port 80', value: '80' },
                { title: 'only-payload', value: 'only-payload' },
                { title: 'only-title', value: 'only-title' }
            ]);
        });

        it('should unescape titles but not values', async function() {
            const choices = getChoices({ channelData: { quick_replies: [{ title: 'O&#39;Neil', payload: 'a&amp;b' }] } });
            assert.deepStrictEqual(choices, [{ title: 'O\'Neil', value: 'a&amp;b' }]);
            assert.deepStrictEqual(getChoices({ channelData: { quick_replies: [{ title: 'O&#39;Neil', payload: 'x' }] } }, false), [{ title: 'O&#39;Neil', value: 'x' }]);
        });

        it('should skip empty entries and accept plain strings', async function() {
            const choices = getChoices({ channelData: { quick_replies: [null, 'yes', {}, { title: 'No', payload: 'no' }] } });
            assert.deepStrictEqual(choices, [{ title: 'yes', value: 'yes' }, { title: 'No', value: 'no' }]);
        });

        it('should return an empty array when there are no choices', async function() {
            assert.deepStrictEqual(getChoices({ type: 'message', text: 'hi' }), []);
            assert.deepStrictEqual(getChoices({ channelData: { quick_replies: 'nope' } }), []);
        });
    });

    describe('renderActivity', function() {
        it('should render quick replies as a numbered menu', async function() {
            const result = renderActivity(envQuestion(), options());
            assert.deepStrictEqual(result.lines, ['bot> Which env?', '     [1] Staging  [2] Production']);
            assert.deepStrictEqual(result.choices, [{ title: 'Staging', value: 'staging' }, { title: 'Production', value: 'production' }]);
            assert.strictEqual(result.defaultValue, undefined);
        });

        it('should indent continuation lines of multi-line text', async function() {
            assert.deepStrictEqual(renderActivity({ type: 'message', text: 'a\nb' }, options()).lines, ['bot> a', '     b']);
            assert.deepStrictEqual(renderActivity({ type: 'message', text: 'a\r\n\r\nb' }, options()).lines, ['bot> a', '', '     b']);
        });

        it('should show when a message is addressed to someone else', async function() {
            const lines = renderActivity({ type: 'message', text: 'hi', recipient: { id: 'bob' } }, options()).lines;
            assert.deepStrictEqual(lines, ['bot (to bob)> hi']);
            const own = renderActivity({ type: 'message', text: 'hi\nthere', recipient: { id: 'ann' } }, options()).lines;
            assert.deepStrictEqual(own, ['bot> hi', '     there']);
            const named = renderActivity({ type: 'message', text: 'a\nb', recipient: { id: 'bob' } }, options({ botName: 'ops' })).lines;
            assert.deepStrictEqual(named, ['ops (to bob)> a', ' '.repeat('ops (to bob)> '.length) + 'b']);
        });

        it('should mark the default choice', async function() {
            const result = renderActivity({
                type: 'message',
                text: 'Which database?',
                channelData: { default: 'sqlite', quick_replies: [{ title: 'PostgreSQL', payload: 'postgres' }, { title: 'SQLite', payload: 'sqlite' }] }
            }, options());
            assert.deepStrictEqual(result.lines, ['bot> Which database?', '     [1] PostgreSQL  [2] SQLite (default)']);
            assert.strictEqual(result.defaultValue, 'sqlite');
        });

        it('should show a default that matches no choice on its own line', async function() {
            const result = renderActivity({ type: 'message', text: 'Port?', channelData: { default: 8080 } }, options());
            assert.deepStrictEqual(result.lines, ['bot> Port?', '     (default: 8080)']);
            assert.strictEqual(result.defaultValue, '8080');
            const withChoices = renderActivity({ ...envQuestion(), channelData: { ...envQuestion().channelData, default: 'x' } }, options());
            assert.deepStrictEqual(withChoices.lines, ['bot> Which env?', '     [1] Staging  [2] Production', '     (default: x)']);
        });

        it('should summarize a hero card and offer its buttons as choices', async function() {
            const result = renderActivity({
                type: 'message',
                attachments: [{
                    contentType: 'application/vnd.microsoft.card.hero',
                    content: { title: 'T', subtitle: 'S', text: 'body', images: [{ url: 'http://i' }], buttons: [{ type: 'imBack', title: 'Go', value: 'go' }] }
                }]
            }, options());
            assert.deepStrictEqual(result.lines, ['bot> [card] T - S', '     body', '     [image] http://i', '     [1] Go']);
            assert.deepStrictEqual(result.choices, [{ title: 'Go', value: 'go' }]);
        });

        it('should ignore card buttons when the message has quick replies', async function() {
            const activity = envQuestion();
            activity.attachments = [{ contentType: 'application/vnd.microsoft.card.thumbnail', content: { title: 'Card', buttons: [{ title: 'Go', value: 'go' }] } }];
            const result = renderActivity(activity, options());
            assert.deepStrictEqual(result.lines, ['bot> Which env?', '     [card] Card', '     [1] Staging  [2] Production']);
        });

        it('should summarize media, adaptive cards and unknown attachments', async function() {
            const result = renderActivity({
                type: 'message',
                text: 'Files:',
                attachments: [
                    { contentType: 'image/png', name: 'x.png', contentUrl: 'http://x' },
                    { contentType: 'application/pdf', contentUrl: 'http://y.pdf' },
                    { contentType: 'application/vnd.microsoft.card.adaptive', content: { speak: 'Your order' } },
                    { contentType: 'application/vnd.microsoft.card.adaptive', content: {} },
                    { contentType: 'application/x-custom', name: 'thing' },
                    { content: {} }
                ]
            }, options());
            assert.deepStrictEqual(result.lines, [
                'bot> Files:',
                '     [image/png] x.png http://x',
                '     [application/pdf] http://y.pdf',
                '     [adaptive card] Your order',
                '     [adaptive card]',
                '     [application/x-custom] thing',
                '     [attachment]'
            ]);
        });

        it('should number the attachments of a carousel', async function() {
            const result = renderActivity({
                type: 'message',
                attachmentLayout: 'carousel',
                attachments: [
                    { contentType: 'application/vnd.microsoft.card.hero', content: { title: 'A', text: 'first' } },
                    { contentType: 'application/vnd.microsoft.card.hero', content: { title: 'B' } }
                ]
            }, options());
            assert.deepStrictEqual(result.lines, ['bot> (1/2) [card] A', '     first', '     (2/2) [card] B']);
        });

        it('should unescape text, card fields and choice titles', async function() {
            const result = renderActivity({
                type: 'message',
                text: 'Visit https:&#x2F;&#x2F;a.b&#x2F;c?d&#x3D;1',
                attachments: [{ contentType: 'application/vnd.microsoft.card.hero', content: { title: 'Tom &amp; Jerry', images: [{ url: 'http:&#x2F;&#x2F;i' }] } }],
                channelData: { quick_replies: [{ title: '&lt;ok&gt;', payload: 'ok' }] }
            }, options());
            assert.deepStrictEqual(result.lines, ['bot> Visit https://a.b/c?d=1', '     [card] Tom & Jerry', '     [image] http://i', '     [1] <ok>']);
            const raw = renderActivity({ type: 'message', text: 'a &amp; b' }, options({ unescapeHtml: false }));
            assert.deepStrictEqual(raw.lines, ['bot> a &amp; b']);
        });

        it('should render nothing for typing, delay, trace and empty messages', async function() {
            assert.deepStrictEqual(renderActivity({ type: 'typing' }, options()).lines, []);
            assert.deepStrictEqual(renderActivity({ type: 'delay', value: 1000 }, options()).lines, []);
            assert.deepStrictEqual(renderActivity({ type: 'trace', name: 'x', value: 1 }, options()).lines, []);
            assert.deepStrictEqual(renderActivity({ type: 'message', text: '', channelData: {} }, options()).lines, []);
            assert.deepStrictEqual(renderActivity({ type: 'message', channelData: { blocks: [] } }, options()).lines, []);
        });

        it('should render events, progress, end of conversation and other types', async function() {
            assert.deepStrictEqual(renderActivity({ type: 'event', name: 'deploy_started', value: { id: 1 } }, options()).lines, ['     [event deploy_started] {"id":1}']);
            assert.deepStrictEqual(renderActivity({ type: 'event', name: 'ping' }, options()).lines, ['     [event ping]']);
            assert.deepStrictEqual(renderActivity({ type: 'event', name: 'progress', value: { done: 3, total: 10, label: 'Migrating' } }, options()).lines, ['     [###-------] 30% Migrating']);
            assert.deepStrictEqual(renderActivity({ type: 'endOfConversation' }, options()).lines, ['     (end of conversation)']);
            assert.deepStrictEqual(renderActivity({ type: 'handoff' }, options()).lines, ['     [handoff]']);
        });

        it('should show leftover channelData in verbose mode only', async function() {
            const activity = { type: 'message', text: 'hi', channelData: { quick_replies: [{ title: 'A', payload: 'a' }], default: 'a', botkitEventType: 'x', attachments: [], priority: 'high' } };
            assert.deepStrictEqual(renderActivity(activity, options()).lines, ['bot> hi', '     [1] A (default)']);
            assert.deepStrictEqual(renderActivity(activity, options({ verbose: true })).lines, ['bot> hi', '     [1] A (default)', '     data: {"priority":"high"}']);
        });

        it('should add colors that strip back to the plain rendering', async function() {
            const activity = { ...envQuestion(), channelData: { ...envQuestion().channelData, default: 'staging' } };
            const plain = renderActivity(activity, options()).lines;
            const colored = renderActivity(activity, options({ color: true })).lines;
            assert.ok(colored[0].startsWith(`${ ESC }[1;36mbot> ${ ESC }[0m`));
            assert.ok(colored[1].includes(`${ ESC }[1m[1]${ ESC }[0m`));
            assert.deepStrictEqual(colored.map(stripAnsi), plain);
            const event = renderActivity({ type: 'event', name: 'x', value: 1 }, options({ color: true })).lines;
            assert.strictEqual(event[0], `     ${ ESC }[2m[event x] 1${ ESC }[0m`);
        });
    });

    describe('renderJson', function() {
        it('should render a message with choices as one JSON line', async function() {
            const activity = { ...envQuestion(), recipient: { id: 'ann' }, conversation: { id: 'c1' }, from: { id: 'bot' }, channelId: 'cli' };
            const json = renderJson(activity, options());
            assert.ok(!json.includes('\n'));
            assert.deepStrictEqual(JSON.parse(json), {
                type: 'message',
                text: 'Which env?',
                choices: [{ title: 'Staging', value: 'staging' }, { title: 'Production', value: 'production' }],
                to: 'ann',
                conversation: 'c1'
            });
        });

        it('should return null for typing, delay and trace', async function() {
            assert.strictEqual(renderJson({ type: 'typing' }, options()), null);
            assert.strictEqual(renderJson({ type: 'delay', value: 10 }, options()), null);
            assert.strictEqual(renderJson({ type: 'trace' }, options()), null);
        });

        it('should include attachments, data and event fields', async function() {
            const message = JSON.parse(renderJson({
                type: 'message',
                text: 'A &amp; B',
                attachments: [
                    { contentType: 'application/vnd.microsoft.card.hero', content: { title: 'T' } },
                    { contentType: 'image/png', name: 'x.png', contentUrl: 'http:&#x2F;&#x2F;x', content: { ignored: true } }
                ],
                channelData: { quick_replies: [], botkitEventType: 'x', priority: 'high' }
            }, options()));
            assert.deepStrictEqual(message, {
                type: 'message',
                text: 'A & B',
                attachments: [
                    { contentType: 'application/vnd.microsoft.card.hero', content: { title: 'T' } },
                    { contentType: 'image/png', name: 'x.png', url: 'http://x' }
                ],
                data: { priority: 'high' }
            });

            const event = JSON.parse(renderJson({ type: 'event', name: 'progress', value: { done: 1, total: 2 }, recipient: { id: 'ann' } }, options()));
            assert.deepStrictEqual(event, { type: 'event', name: 'progress', value: { done: 1, total: 2 }, to: 'ann' });
        });

        it('should leave out event fields on messages', async function() {
            const message = JSON.parse(renderJson({ type: 'message', text: 'hi', name: 'n', value: 'v' }, options()));
            assert.deepStrictEqual(message, { type: 'message', text: 'hi' });
        });
    });
});
