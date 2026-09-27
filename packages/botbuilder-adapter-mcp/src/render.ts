/**
 * @module botbuilder-adapter-mcp
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Activity } from 'botbuilder';
import { McpAttachment, McpChoice, McpReply } from './protocol';

const HTML_ENTITIES: { [entity: string]: string } = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': '\'',
    '&#x2F;': '/',
    '&#x60;': '`',
    '&#x3D;': '='
};
const HTML_ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39|#x2F|#x60|#x3D);/g;

/**
 * Card types whose content is passed on to the agent.
 */
const CARD_TYPES = [
    'application/vnd.microsoft.card.hero',
    'application/vnd.microsoft.card.thumbnail',
    'application/vnd.microsoft.card.adaptive'
];

/**
 * Card types whose buttons count as choices.
 */
const BUTTON_CARD_TYPES = [
    'application/vnd.microsoft.card.hero',
    'application/vnd.microsoft.card.thumbnail'
];

/**
 * Activity types that are never reported.
 */
const SILENT_TYPES = ['typing', 'delay', 'trace'];

/**
 * channelData fields left out of McpReply.data.
 */
const HIDDEN_DATA_FIELDS = ['quick_replies', 'botkitEventType'];

/**
 * Options for `renderRepliesText()`.
 */
export interface McpRenderOptions {
    /**
     * Messages that arrived while the agent was away. They are listed first, each marked `[message received while you were away]`.
     */
    proactive?: McpReply[];

    /**
     * True when a dialog is waiting for an answer. Adds a closing line that tells the agent how to answer.
     */
    awaitingInput?: boolean;

    /**
     * The variable the pending question stores its answer in, mentioned in the closing line.
     */
    key?: string;

    /**
     * The name of the chat tool, mentioned in the closing line. Defaults to `chat`.
     */
    toolName?: string;

    /**
     * The chat session, mentioned in the closing line. Defaults to `default`.
     */
    session?: string;

    /**
     * Decode HTML entities in card titles, subtitles and text. Defaults to true.
     */
    unescapeHtml?: boolean;

    /**
     * The text returned when there is nothing to show. Defaults to `(no reply)`.
     */
    empty?: string;
}

/**
 * Decode the HTML entities that [mustache](https://www.npmjs.com/package/mustache) adds when Botkit renders `{{vars.x}}` in a dialog template.
 * Exactly mustache's escape map is reversed, in a single pass, so `&amp;lt;` becomes `&lt;` and not `<`.
 *
 * ```javascript
 * const { unescapeHtml } = require('botbuilder-adapter-mcp');
 * unescapeHtml('O&#39;Neil &amp; co'); // "O'Neil & co"
 * unescapeHtml('https:&#x2F;&#x2F;example.com&#x2F;?a&#x3D;1'); // 'https://example.com/?a=1'
 * ```
 *
 * @param text Text that may contain HTML entities.
 * @returns The decoded text. Null or undefined becomes an empty string.
 */
export function unescapeHtml(text: string): string {
    if (text === undefined || text === null) {
        return '';
    }
    return String(text).replace(HTML_ENTITY_PATTERN, (entity) => HTML_ENTITIES[entity]);
}

/**
 * Turn one quick reply, suggested action or card button into a choice. Entries without a title or a value are skipped.
 */
function toChoice(title: any, value: any, fallback: any, decode: boolean): McpChoice | null {
    const label = (title !== undefined && title !== null) ? title : value;
    let result = (value !== undefined && value !== null) ? value : fallback;
    if (result === undefined || result === null) {
        result = title;
    }
    if (label === undefined || label === null || result === undefined || result === null) {
        return null;
    }
    const text = typeof label === 'object' ? JSON.stringify(label) : String(label);
    return {
        title: decode ? unescapeHtml(text) : text,
        value: typeof result === 'object' ? JSON.stringify(result) : String(result)
    };
}

/**
 * Map a list of entries, skipping null entries and entries that give no choice. A plain string or number is both title and value.
 */
function mapChoices(entries: any[], decode: boolean, map: (entry: any) => McpChoice | null): McpChoice[] {
    const choices: McpChoice[] = [];
    entries.forEach((entry) => {
        if (entry === undefined || entry === null) {
            return;
        }
        const choice = typeof entry === 'object' ? map(entry) : toChoice(entry, entry, undefined, decode);
        if (choice) {
            choices.push(choice);
        }
    });
    return choices;
}

/**
 * Read the choices a message offers, with the same rules as the CLI adapter.
 * `channelData.quick_replies` (`[{ title, payload }]`, as sent by `bot.say()` and dialog templates) wins over
 * `suggestedActions.actions` (`[{ title, value }]`). Titles are decoded with `unescapeHtml()` and values are always strings.
 * Card buttons are not included: `normalizeReply()` uses them only when this returns no choices.
 *
 * ```javascript
 * const { getChoices } = require('botbuilder-adapter-mcp');
 * getChoices({ channelData: { quick_replies: [{ title: 'Yes', payload: 'yes' }] } }); // [{ title: 'Yes', value: 'yes' }]
 * ```
 *
 * @param activity An outgoing activity.
 * @param decode Decode HTML entities in titles. Defaults to true.
 * @returns The choices, or an empty array.
 */
export function getChoices(activity: Partial<Activity>, decode = true): McpChoice[] {
    if (!activity) {
        return [];
    }
    const quickReplies = activity.channelData && activity.channelData.quick_replies;
    if (Array.isArray(quickReplies) && quickReplies.length) {
        return mapChoices(quickReplies, decode, (q) => toChoice(q.title, q.payload, undefined, decode));
    }
    const actions = activity.suggestedActions && activity.suggestedActions.actions;
    if (Array.isArray(actions) && actions.length) {
        return mapChoices(actions, decode, (a) => toChoice(a.title, a.value, a.text, decode));
    }
    return [];
}

/**
 * Collect the buttons of every hero and thumbnail card in the activity, in order.
 */
function getCardButtons(activity: Partial<Activity>, decode: boolean): McpChoice[] {
    const buttons: McpChoice[] = [];
    (activity.attachments || []).forEach((attachment) => {
        if (attachment && BUTTON_CARD_TYPES.includes(attachment.contentType) && attachment.content && Array.isArray(attachment.content.buttons)) {
            buttons.push(...mapChoices(attachment.content.buttons, decode, (b) => toChoice(b.title, b.value, b.text, decode)));
        }
    });
    return buttons;
}

/**
 * A copy of channelData without the hidden fields, or undefined when nothing is left.
 */
function remainingData(channelData: any): { [key: string]: any } | undefined {
    if (!channelData || typeof channelData !== 'object') {
        return undefined;
    }
    const data = {};
    let found = false;
    Object.keys(channelData).forEach((key) => {
        if (!HIDDEN_DATA_FIELDS.includes(key) && channelData[key] !== undefined) {
            data[key] = channelData[key];
            found = true;
        }
    });
    return found ? data : undefined;
}

/**
 * Simplify an outgoing activity into an [McpReply](#McpReply) for an agent.
 *
 * * `typing`, `delay` and `trace` activities return null.
 * * `text` is decoded with `unescapeHtml()` when `unescape` is true, and left out when empty.
 * * `choices` come from `getChoices()`, or else from hero and thumbnail card buttons.
 * * `attachments` become `{ contentType, name, url, content }`, where `url` is the `contentUrl` and `content` is kept for hero, thumbnail and adaptive cards only.
 * * `data` is `channelData` without `quick_replies` and `botkitEventType`, when anything is left.
 * * Events keep their `name` and `value`.
 *
 * ```javascript
 * const { normalizeReply } = require('botbuilder-adapter-mcp');
 * normalizeReply({ type: 'message', text: 'Pick one', channelData: { quick_replies: [{ title: 'Red', payload: 'red' }] } });
 * // { type: 'message', text: 'Pick one', choices: [{ title: 'Red', value: 'red' }] }
 * ```
 *
 * @param activity An outgoing activity.
 * @param unescape Decode HTML entities in text, choice titles and attachment names and urls. Defaults to true.
 * @returns The simplified reply, or null if the activity is never shown.
 */
export function normalizeReply(activity: Partial<Activity>, unescape = true): McpReply | null {
    if (!activity) {
        return null;
    }
    const type = activity.type || 'message';
    if (SILENT_TYPES.includes(type)) {
        return null;
    }
    const decode = (value: any): string => unescape ? unescapeHtml(String(value)) : String(value);
    const reply: McpReply = { type: type };

    if (activity.text !== undefined && activity.text !== null && activity.text !== '') {
        reply.text = decode(activity.text);
    }

    const choices = getChoices(activity, unescape);
    const allChoices = choices.length ? choices : getCardButtons(activity, unescape);
    if (allChoices.length) {
        reply.choices = allChoices;
    }

    const attachments = (activity.attachments || []).filter((attachment) => attachment).map((attachment) => {
        const result: McpAttachment = { contentType: attachment.contentType };
        if (attachment.name !== undefined && attachment.name !== null) {
            result.name = decode(attachment.name);
        }
        if (attachment.contentUrl !== undefined && attachment.contentUrl !== null) {
            result.url = decode(attachment.contentUrl);
        }
        if (CARD_TYPES.includes(attachment.contentType) && attachment.content !== undefined) {
            result.content = attachment.content;
        }
        return result;
    });
    if (attachments.length) {
        reply.attachments = attachments;
    }

    const data = remainingData(activity.channelData);
    if (data) {
        reply.data = data;
    }

    if (type === 'event') {
        if (activity.name !== undefined) {
            reply.name = activity.name;
        }
        if (activity.value !== undefined) {
            reply.value = activity.value;
        }
    }

    return reply;
}

/**
 * JSON for a value in a text line. Values that cannot be serialized are shown with String().
 */
function toJson(value: any): string {
    try {
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
    } catch (err) {
        return String(value);
    }
}

/**
 * The text lines for one reply.
 */
function renderReply(reply: McpReply, decode: (text: any) => string): string[] {
    const lines: string[] = [];
    if (reply.type === 'event') {
        lines.push(`[event ${ reply.name }]` + (reply.value === undefined ? '' : ' ' + toJson(reply.value)));
        return lines;
    }
    if (reply.type !== 'message') {
        lines.push(`[${ reply.type }]`);
    }
    if (reply.text) {
        lines.push(reply.text);
    }
    (reply.attachments || []).forEach((attachment) => {
        const content = attachment.content;
        if (BUTTON_CARD_TYPES.includes(attachment.contentType) && content && typeof content === 'object') {
            lines.push('[card]' + (content.title ? ' ' + decode(content.title) : '') + (content.subtitle ? ' - ' + decode(content.subtitle) : ''));
            if (content.text) {
                lines.push(decode(content.text));
            }
            (Array.isArray(content.images) ? content.images : []).forEach((image) => {
                if (image && image.url) {
                    lines.push('[image] ' + decode(image.url));
                }
            });
        } else {
            lines.push('[attachment' + (attachment.contentType ? ' ' + attachment.contentType : '') +
                (attachment.name ? ' ' + attachment.name : '') + (attachment.url ? ' ' + attachment.url : '') + ']');
        }
    });
    if (reply.choices && reply.choices.length) {
        lines.push('Choices: ' + reply.choices.map((choice) => choice.title === choice.value ? `"${ choice.value }"` : `"${ choice.title }" (send "${ choice.value }")`).join(', '));
    }
    return lines;
}

/**
 * Render replies as the text an agent reads in a tool result.
 *
 * * Messages that arrived while the agent was away come first, marked `[message received while you were away]`.
 * * Each reply adds its text, then one line per attachment (`[card] Title - Subtitle` and the card text for hero and thumbnail cards,
 *   `[attachment <contentType> <name> <url>]` for anything else), then a `Choices:` line such as `Choices: "Small" (send "small"), "large"`.
 * * Events render as `[event <name>] <json value>`.
 * * When `awaitingInput` is set, a last line tells the agent to answer: `(Waiting for your answer to "size". Call chat again with session "s1".)`.
 *
 * ```javascript
 * const { renderRepliesText } = require('botbuilder-adapter-mcp');
 * renderRepliesText([{ type: 'message', text: 'Which size?', choices: [{ title: 'Small', value: 'small' }] }], {
 *     awaitingInput: true, key: 'size', toolName: 'chat', session: 's1'
 * });
 * // 'Which size?\nChoices: "Small" (send "small")\n(Waiting for your answer to "size". Call chat again with session "s1".)'
 * ```
 *
 * @param replies The replies to render.
 * @param options What else to include.
 * @returns The text, one line per item. When there is nothing to show, `options.empty`, which defaults to `(no reply)`.
 */
export function renderRepliesText(replies: McpReply[], options: McpRenderOptions = {}): string {
    const unescape = options.unescapeHtml !== false;
    const decode = (text: any): string => unescape ? unescapeHtml(String(text)) : String(text);
    const lines: string[] = [];

    (options.proactive || []).forEach((reply) => {
        const replyLines = renderReply(reply, decode);
        if (replyLines.length) {
            replyLines[0] = '[message received while you were away] ' + replyLines[0];
            lines.push(...replyLines);
        }
    });
    (replies || []).forEach((reply) => {
        lines.push(...renderReply(reply, decode));
    });

    if (options.awaitingInput) {
        const toolName = options.toolName || 'chat';
        const session = options.session || 'default';
        lines.push('(Waiting for your answer' + (options.key ? ` to "${ options.key }"` : '') + `. Call ${ toolName } again with session "${ session }".)`);
    }

    if (!lines.length) {
        return options.empty !== undefined ? options.empty : '(no reply)';
    }
    return lines.join('\n');
}
