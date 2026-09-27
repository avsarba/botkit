const { BotAdapter, TurnContext } = require('botbuilder');

/**
 * A controllable clock. Timers never fire on their own: tests read `timers` and call `fire()` or `timer.fn()`.
 */
class FakeClock {
    constructor(t) {
        this.t = t;
        this.timers = [];
    }

    now() {
        return this.t;
    }

    setTimeout(fn, ms) {
        const timer = { fn, ms, at: this.t + ms };
        this.timers.push(timer);
        return timer;
    }

    clearTimeout(timer) {
        this.timers = this.timers.filter((t) => t !== timer);
    }

    advance(ms) {
        this.t += ms;
        return this.t;
    }

    /**
     * Remove the next timer, move the clock to its time and run it. Resolves when the tick it started ends.
     */
    async fire() {
        const timer = this.timers.sort((a, b) => a.at - b.at).shift();
        if (!timer) {
            throw new Error('No timer is armed');
        }
        this.t = Math.max(this.t, timer.at);
        return timer.fn();
    }
}

/**
 * An in-memory adapter that runs turns through the full Botkit pipeline and records what the bot sends.
 */
class FakeAdapter extends BotAdapter {
    constructor(channelId = 'fake') {
        super();
        this.name = 'Fake Adapter';
        this.channelId = channelId;
        this.sent = [];
        this.continued = 0;
    }

    init(controller) {
        this.controller = controller;
    }

    async sendActivities(context, activities) {
        return activities.map((activity) => {
            this.sent.push({
                conversation: activity.conversation,
                recipient: activity.recipient,
                text: activity.text,
                type: activity.type
            });
            return { id: `fake-${ this.sent.length }` };
        });
    }

    async updateActivity() {
        // no-op
    }

    async deleteActivity() {
        // no-op
    }

    async continueConversation(reference, logic) {
        this.continued++;
        const request = TurnContext.applyConversationReference({ type: 'event', name: 'continueConversation' }, reference, true);
        await this.runMiddleware(new TurnContext(this, request), logic);
    }

    /**
     * Run a user turn. Defaults to a message from u1 in conversation c1.
     */
    async turn(partial) {
        const context = new TurnContext(this, {
            type: 'message',
            channelId: this.channelId,
            conversation: { id: 'c1' },
            from: { id: 'u1' },
            recipient: { id: 'bot' },
            timestamp: new Date(),
            ...partial
        });
        await this.runMiddleware(context, this.controller.handleTurn.bind(this.controller));
        return context;
    }

    texts() {
        return this.sent.map((activity) => activity.text);
    }
}

/**
 * An adapter whose continueConversation fails without running the logic, like botbuilder's TestAdapter.
 */
class RejectingAdapter extends FakeAdapter {
    async continueConversation() {
        this.continued++;
        throw new Error('not implemented');
    }
}

function deferred() {
    const d = {};
    d.promise = new Promise((resolve, reject) => {
        d.resolve = resolve;
        d.reject = reject;
    });
    return d;
}

/**
 * Replace console.error while `fn` runs, and return what it was called with.
 */
async function quietly(fn) {
    const calls = [];
    const original = console.error;
    console.error = (...args) => calls.push(args);
    try {
        await fn();
    } finally {
        console.error = original;
    }
    return calls;
}

module.exports = { FakeClock, FakeAdapter, RejectingAdapter, deferred, quietly };
