const assert = require('assert');
const { unescapeHtml, getChoices, normalizeReply, renderRepliesText } = require('../');

describe('Render', function() {
    it('should reverse exactly mustache\'s escaping, in one pass', function() {
        assert.strictEqual(unescapeHtml('O&#39;Neil &amp; co'), 'O\'Neil & co');
        assert.strictEqual(unescapeHtml('&amp;lt;'), '&lt;');
        assert.strictEqual(unescapeHtml('https:&#x2F;&#x2F;a.b&#x2F;c?d&#x3D;1&amp;e&#x3D;2 &quot;q&quot; &#x60;x&#x60; &lt;b&gt;'), 'https://a.b/c?d=1&e=2 "q" `x` <b>');
        assert.strictEqual(unescapeHtml('&nbsp; &#40;'), '&nbsp; &#40;');
        assert.strictEqual(unescapeHtml(undefined), '');
    });

    it('should prefer quick replies over suggested actions', function() {
        const activity = {
            channelData: { quick_replies: [{ title: 'Red', payload: 'red' }, { title: 'Two', payload: 2 }] },
            suggestedActions: { actions: [{ title: 'Blue', value: 'blue' }] }
        };
        assert.deepStrictEqual(getChoices(activity), [{ title: 'Red', value: 'red' }, { title: 'Two', value: '2' }]);
        assert.deepStrictEqual(getChoices({ suggestedActions: { actions: [{ title: 'Blue', value: 'blue' }, { value: 'green' }] } }), [
            { title: 'Blue', value: 'blue' },
            { title: 'green', value: 'green' }
        ]);
        assert.deepStrictEqual(getChoices({ channelData: { quick_replies: [] } }), []);
        assert.deepStrictEqual(getChoices({}), []);
        assert.deepStrictEqual(getChoices({ channelData: { quick_replies: [{ title: 'Tom &amp; Jerry', payload: 'tj' }] } }), [{ title: 'Tom & Jerry', value: 'tj' }]);
    });

    it('should normalize messages', function() {
        const reply = normalizeReply({
            type: 'message',
            text: 'Visit https:&#x2F;&#x2F;a.b',
            channelData: { quick_replies: [{ title: 'Go', payload: 'go' }], botkitEventType: 'x', custom: 1 },
            attachments: [
                { contentType: 'image/png', name: 'map.png', contentUrl: 'http://x/map.png', content: { ignored: true } },
                { contentType: 'application/vnd.microsoft.card.hero', content: { title: 'T' } }
            ],
            recipient: { id: 'client' }
        });
        assert.deepStrictEqual(reply, {
            type: 'message',
            text: 'Visit https://a.b',
            choices: [{ title: 'Go', value: 'go' }],
            attachments: [
                { contentType: 'image/png', name: 'map.png', url: 'http://x/map.png' },
                { contentType: 'application/vnd.microsoft.card.hero', content: { title: 'T' } }
            ],
            data: { custom: 1 }
        });
        assert.strictEqual(normalizeReply({ type: 'message', text: 'a &amp; b' }, false).text, 'a &amp; b');
    });

    it('should use hero card buttons as choices only when there are no other choices', function() {
        const card = { contentType: 'application/vnd.microsoft.card.hero', content: { title: 'Pizza', buttons: [{ title: 'Order', value: 'order' }] } };
        assert.deepStrictEqual(normalizeReply({ type: 'message', attachments: [card] }).choices, [{ title: 'Order', value: 'order' }]);
        assert.deepStrictEqual(normalizeReply({ type: 'message', attachments: [card], channelData: { quick_replies: [{ title: 'No', payload: 'no' }] } }).choices, [{ title: 'No', value: 'no' }]);
    });

    it('should drop typing, delay and trace activities, and keep event names and values', function() {
        assert.strictEqual(normalizeReply({ type: 'typing' }), null);
        assert.strictEqual(normalizeReply({ type: 'delay', value: 100 }), null);
        assert.strictEqual(normalizeReply({ type: 'trace' }), null);
        assert.deepStrictEqual(normalizeReply({ type: 'event', name: 'deployed', value: { id: 1 } }), { type: 'event', name: 'deployed', value: { id: 1 } });
    });

    it('should render replies, choices, attachments and events as text', function() {
        const replies = [
            { type: 'message', text: 'Which size?', choices: [{ title: 'Small', value: 'small' }, { title: 'large', value: 'large' }] },
            { type: 'message', attachments: [{ contentType: 'image/png', name: 'x.png', url: 'http://x' }] },
            { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.hero', content: { title: 'Tom &amp; Jerry', subtitle: 'S', text: 'body', images: [{ url: 'http://i' }] } }] },
            { type: 'event', name: 'deploy_started', value: { id: 1 } },
            { type: 'endOfConversation' }
        ];
        const text = renderRepliesText(replies, { awaitingInput: true, key: 'size', toolName: 'chat', session: 's1' });
        assert.strictEqual(text, [
            'Which size?',
            'Choices: "Small" (send "small"), "large"',
            '[attachment image/png x.png http://x]',
            '[card] Tom & Jerry - S',
            'body',
            '[image] http://i',
            '[event deploy_started] {"id":1}',
            '[endOfConversation]',
            '(Waiting for your answer to "size". Call chat again with session "s1".)'
        ].join('\n'));
    });

    it('should mark proactive messages and say when there is nothing to show', function() {
        const text = renderRepliesText([{ type: 'message', text: 'Now' }], { proactive: [{ type: 'message', text: 'Earlier' }] });
        assert.strictEqual(text, '[message received while you were away] Earlier\nNow');
        assert.strictEqual(renderRepliesText([]), '(no reply)');
        assert.strictEqual(renderRepliesText([], { empty: '' }), '');
        assert.strictEqual(renderRepliesText([], { awaitingInput: true }), '(Waiting for your answer. Call chat again with session "default".)');
    });
});
