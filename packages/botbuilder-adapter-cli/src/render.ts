/**
 * @module botbuilder-adapter-cli
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { Activity } from 'botbuilder';

/**
 * One entry of a numbered menu, as offered by quick replies, suggested actions or card buttons.
 */
export interface CliChoice {
    /**
     * The label shown to the user.
     */
    title: string;

    /**
     * The value sent to the bot when the user picks this choice.
     */
    value: string;
}

/**
 * Options for `renderActivity()` and `renderJson()`.
 */
export interface RenderOptions {
    /**
     * The name shown in front of bot messages, as in `bot> Hello`.
     */
    botName: string;

    /**
     * The id of the user at the keyboard. Messages sent to anyone else are prefixed with `bot (to <id>)> `.
     */
    currentUser: string;

    /**
     * Add ANSI colors and bold text to the output.
     */
    color: boolean;

    /**
     * Show extra `channelData` fields as a `data: <json>` line.
     */
    verbose: boolean;

    /**
     * Decode the HTML entities that mustache adds to `{{vars.x}}` tokens.
     */
    unescapeHtml: boolean;
}

/**
 * The result of `renderActivity()`.
 */
export interface RenderedActivity {
    /**
     * The lines to print, without trailing newlines. May be empty.
     */
    lines: string[];

    /**
     * The choices the message offers, in menu order.
     */
    choices: CliChoice[];

    /**
     * The value of `channelData.default`, if the message sets one.
     */
    defaultValue?: string;
}

const ESC = '\u001b';
const RESET = `${ ESC }[0m`;
const BOLD = `${ ESC }[1m`;
const BOLD_CYAN = `${ ESC }[1;36m`;
const DIM = `${ ESC }[2m`;
const ANSI_PATTERN = new RegExp(`${ ESC }\\[[0-9;]*m`, 'g');

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

const CARD_TYPES = [
    'application/vnd.microsoft.card.hero',
    'application/vnd.microsoft.card.thumbnail',
    'application/vnd.microsoft.card.adaptive'
];
const BUTTON_CARD_TYPES = [
    'application/vnd.microsoft.card.hero',
    'application/vnd.microsoft.card.thumbnail'
];

/**
 * Activity types that are never shown to the user.
 */
const SILENT_TYPES = ['typing', 'delay', 'trace'];

/**
 * channelData fields that the text renderer already shows, and so leaves out of the verbose `data:` line.
 */
const RENDERED_DATA_FIELDS = ['quick_replies', 'default', 'botkitEventType', 'attachments'];

/**
 * channelData fields left out of the `data` field of the JSON format.
 */
const JSON_HIDDEN_DATA_FIELDS = ['quick_replies', 'botkitEventType'];

/**
 * Decode the HTML entities that [mustache](https://www.npmjs.com/package/mustache) adds when Botkit renders `{{vars.x}}` in a dialog template.
 * Exactly mustache's escape map is reversed, in a single pass, so `&amp;lt;` becomes `&lt;` and not `<`.
 *
 * ```javascript
 * const { unescapeHtml } = require('botbuilder-adapter-cli');
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
 * Remove ANSI color and style sequences (`ESC[...m`) from a string.
 *
 * ```javascript
 * const { stripAnsi } = require('botbuilder-adapter-cli');
 * stripAnsi('\u001b[1;36mbot>\u001b[0m Hi'); // 'bot> Hi'
 * ```
 *
 * @param text Text that may contain ANSI sequences.
 * @returns The text without them.
 */
export function stripAnsi(text: string): string {
    return String(text).replace(ANSI_PATTERN, '');
}

/**
 * Draw a 10-cell text progress bar with a percentage and an optional label.
 * The ratio `done / total` is clamped between 0 and 1, and a `total` of 0 or less counts as 0%.
 *
 * ```javascript
 * const { progressBar } = require('botbuilder-adapter-cli');
 * progressBar(3, 10, 'Migrating'); // '[###-------] 30% Migrating'
 * ```
 *
 * @param done The amount of work finished.
 * @param total The total amount of work.
 * @param label An optional label printed after the percentage.
 * @returns The progress bar.
 */
export function progressBar(done: number, total: number, label?: string): string {
    const d = Number(done);
    const t = Number(total);
    let ratio = t > 0 ? d / t : 0;
    if (!isFinite(ratio) || ratio < 0) {
        ratio = 0;
    } else if (ratio > 1) {
        ratio = 1;
    }
    const filled = Math.round(ratio * 10);
    const bar = '[' + '#'.repeat(filled) + '-'.repeat(10 - filled) + '] ' + Math.round(ratio * 100) + '%';
    return (label !== undefined && label !== null && label !== '') ? `${ bar } ${ label }` : bar;
}

/**
 * Turn one quick reply, suggested action or card button into a choice. Entries without a title or a value are skipped.
 */
function toChoice(title: any, value: any, fallback: any, decode: boolean): CliChoice | null {
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
function mapChoices(entries: any[], decode: boolean, map: (entry: any) => CliChoice | null): CliChoice[] {
    const choices: CliChoice[] = [];
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
 * Read the choices a message offers.
 * `channelData.quick_replies` (`[{ title, payload }]`, as sent by `bot.say()` and dialog templates) wins over
 * `suggestedActions.actions` (`[{ title, value }]`). Titles are decoded with `unescapeHtml()` and values are always strings.
 * Card buttons are not included here: `renderActivity()` uses them only when this returns no choices.
 *
 * ```javascript
 * const { getChoices } = require('botbuilder-adapter-cli');
 * getChoices({ channelData: { quick_replies: [{ title: 'Yes', payload: 'yes' }] } }); // [{ title: 'Yes', value: 'yes' }]
 * ```
 *
 * @param activity An outgoing activity.
 * @param decode Decode HTML entities in titles. Defaults to true.
 * @returns The choices, or an empty array.
 */
export function getChoices(activity: Partial<Activity>, decode = true): CliChoice[] {
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
function getCardButtons(activity: Partial<Activity>, decode: boolean): CliChoice[] {
    const buttons: CliChoice[] = [];
    (activity.attachments || []).forEach((attachment) => {
        if (attachment && BUTTON_CARD_TYPES.includes(attachment.contentType) && attachment.content && Array.isArray(attachment.content.buttons)) {
            buttons.push(...mapChoices(attachment.content.buttons, decode, (b) => toChoice(b.title, b.value, b.text, decode)));
        }
    });
    return buttons;
}

/**
 * All choices an activity offers: quick replies or suggested actions, otherwise card buttons.
 */
function getAllChoices(activity: Partial<Activity>, decode: boolean): CliChoice[] {
    const choices = getChoices(activity, decode);
    return choices.length ? choices : getCardButtons(activity, decode);
}

/**
 * A copy of channelData without the given fields, or undefined when nothing is left.
 */
function remainingData(channelData: any, hidden: string[]): any {
    if (!channelData || typeof channelData !== 'object') {
        return undefined;
    }
    const data = {};
    let found = false;
    Object.keys(channelData).forEach((key) => {
        if (!hidden.includes(key) && channelData[key] !== undefined) {
            data[key] = channelData[key];
            found = true;
        }
    });
    return found ? data : undefined;
}

/**
 * Render the lines for one attachment. The first line may get a carousel position prefix.
 */
function renderAttachment(attachment: any, decode: (text: any) => string): string[] {
    const contentType = attachment.contentType;
    const content = attachment.content || {};
    const lines: string[] = [];
    if (BUTTON_CARD_TYPES.includes(contentType)) {
        let header = '[card]';
        if (content.title) {
            header = header + ' ' + decode(content.title);
        }
        if (content.subtitle) {
            header = header + ' - ' + decode(content.subtitle);
        }
        lines.push(header);
        if (content.text) {
            lines.push(...decode(content.text).split(/\r?\n/));
        }
        (Array.isArray(content.images) ? content.images : []).forEach((image) => {
            if (image && image.url) {
                lines.push('[image] ' + decode(image.url));
            }
        });
    } else if (contentType === 'application/vnd.microsoft.card.adaptive') {
        lines.push('[adaptive card]' + (content.speak ? ' ' + decode(content.speak) : ''));
    } else if (attachment.contentUrl) {
        lines.push(`[${ contentType || 'attachment' }] ` + (attachment.name ? decode(attachment.name) + ' ' : '') + decode(attachment.contentUrl));
    } else {
        lines.push(`[${ contentType || 'attachment' }]` + (attachment.name ? ' ' + decode(attachment.name) : ''));
    }
    return lines;
}

/**
 * Render an outgoing activity as the lines a person sees in the terminal.
 *
 * * A message starts with `bot> ` (or `bot (to <user>)> ` when it is addressed to someone other than `currentUser`),
 *   and continuation lines are indented to match.
 * * Attachments are summarized: `[card] Title - Subtitle`, `[image] <url>`, `[adaptive card]`, `[image/png] name <url>`.
 * * Choices become one numbered menu line, such as `[1] Staging  [2] Production`, and `channelData.default` is marked `(default)`.
 * * `typing`, `delay` and `trace` activities render nothing; `progress` events render a progress bar and other events render `[event <name>] <value>`.
 *
 * ```javascript
 * const { renderActivity } = require('botbuilder-adapter-cli');
 * const { lines } = renderActivity({
 *     type: 'message',
 *     text: 'Which env?',
 *     channelData: { quick_replies: [{ title: 'Staging', payload: 'staging' }, { title: 'Production', payload: 'production' }] }
 * }, { botName: 'bot', currentUser: 'ann', color: false, verbose: false, unescapeHtml: true });
 * // ['bot> Which env?', '     [1] Staging  [2] Production']
 * ```
 *
 * @param activity An outgoing activity.
 * @param options How to render it.
 * @returns The lines to print, the choices offered and the default value, if any.
 */
export function renderActivity(activity: Partial<Activity>, options: RenderOptions): RenderedActivity {
    const type = activity.type || 'message';
    const channelData = activity.channelData || {};
    const decode = (text: any): string => {
        const value = (text === undefined || text === null) ? '' : String(text);
        return options.unescapeHtml ? unescapeHtml(value) : value;
    };
    const paint = (code: string, text: string): string => options.color ? code + text + RESET : text;

    const recipient = activity.recipient && activity.recipient.id;
    const prefix = (recipient && recipient !== options.currentUser) ? `${ options.botName } (to ${ recipient })> ` : `${ options.botName }> `;
    const indent = ' '.repeat(prefix.length);

    if (SILENT_TYPES.includes(type)) {
        return { lines: [], choices: [] };
    }

    if (type === 'event') {
        const value: any = activity.value;
        if (activity.name === 'progress' && value && typeof value === 'object') {
            return { lines: [indent + paint(DIM, progressBar(value.done, value.total, value.label))], choices: [] };
        }
        const json = value === undefined ? '' : ' ' + JSON.stringify(value);
        return { lines: [indent + paint(DIM, `[event ${ activity.name }]${ json }`)], choices: [] };
    }

    if (type === 'endOfConversation') {
        return { lines: [indent + paint(DIM, '(end of conversation)')], choices: [] };
    }

    if (type !== 'message') {
        return { lines: [indent + paint(DIM, `[${ type }]`)], choices: [] };
    }

    const content: string[] = [];
    if (activity.text !== undefined && activity.text !== null && activity.text !== '') {
        content.push(...decode(activity.text).split(/\r?\n/));
    }

    const attachments = (activity.attachments || []).filter((a) => a);
    const carousel = activity.attachmentLayout === 'carousel' && attachments.length > 1;
    attachments.forEach((attachment, index) => {
        const lines = renderAttachment(attachment, decode);
        if (carousel) {
            lines[0] = `(${ index + 1 }/${ attachments.length }) ${ lines[0] }`;
        }
        content.push(...lines);
    });

    const choices = getAllChoices(activity, options.unescapeHtml);
    const hasDefault = channelData.default !== undefined && channelData.default !== null;
    const defaultValue = hasDefault ? String(channelData.default) : undefined;
    if (choices.length) {
        content.push(choices.map((choice, index) => {
            const marker = (hasDefault && defaultValue === choice.value) ? ' (default)' : '';
            return `${ paint(BOLD, `[${ index + 1 }]`) } ${ choice.title }${ marker }`;
        }).join('  '));
    }
    if (hasDefault && !choices.some((choice) => choice.value === defaultValue)) {
        content.push(paint(DIM, `(default: ${ decode(defaultValue) })`));
    }
    if (options.verbose) {
        const data = remainingData(channelData, RENDERED_DATA_FIELDS);
        if (data) {
            content.push(paint(DIM, 'data: ' + JSON.stringify(data)));
        }
    }

    const lines = content.map((line, index) => {
        if (index === 0) {
            return paint(BOLD_CYAN, prefix) + line;
        }
        return line === '' ? '' : indent + line;
    });

    return { lines: lines, choices: choices, defaultValue: defaultValue };
}

/**
 * Render an outgoing activity as one line of JSON (NDJSON), for programs that read the bot's output.
 * The object has the fields `type`, `text` (decoded), `choices` (only when there are any), `attachments` (`[{ contentType, name, url, content }]`,
 * with `content` only for hero, thumbnail and adaptive cards), `data` (channelData without `quick_replies` and `botkitEventType`, only when not empty),
 * `name` and `value` (events only), `to` (the recipient id) and `conversation` (the conversation id). Undefined fields are left out.
 *
 * ```javascript
 * const { renderJson } = require('botbuilder-adapter-cli');
 * renderJson({ type: 'message', text: 'Hi', recipient: { id: 'ann' }, conversation: { id: 'c1' } }, options);
 * // '{"type":"message","text":"Hi","to":"ann","conversation":"c1"}'
 * renderJson({ type: 'typing' }, options); // null
 * ```
 *
 * @param activity An outgoing activity.
 * @param options How to render it. Only `unescapeHtml` is used.
 * @returns A JSON string, or null for `typing`, `delay` and `trace` activities.
 */
export function renderJson(activity: Partial<Activity>, options: RenderOptions): string | null {
    const type = activity.type || 'message';
    if (SILENT_TYPES.includes(type)) {
        return null;
    }
    const decode = (text: any): string => {
        const value = String(text);
        return options.unescapeHtml ? unescapeHtml(value) : value;
    };
    const choices = getAllChoices(activity, options.unescapeHtml);
    const attachments = (activity.attachments || []).filter((a) => a).map((attachment) => ({
        contentType: attachment.contentType,
        name: attachment.name === undefined || attachment.name === null ? undefined : decode(attachment.name),
        url: attachment.contentUrl === undefined || attachment.contentUrl === null ? undefined : decode(attachment.contentUrl),
        content: CARD_TYPES.includes(attachment.contentType) ? attachment.content : undefined
    }));
    const isEvent = type === 'event';
    const output = {
        type: type,
        text: activity.text === undefined || activity.text === null ? undefined : decode(activity.text),
        choices: choices.length ? choices : undefined,
        attachments: attachments.length ? attachments : undefined,
        data: remainingData(activity.channelData, JSON_HIDDEN_DATA_FIELDS),
        name: isEvent ? activity.name : undefined,
        value: isEvent ? activity.value : undefined,
        to: activity.recipient ? activity.recipient.id : undefined,
        conversation: activity.conversation ? activity.conversation.id : undefined
    };
    return JSON.stringify(output);
}
