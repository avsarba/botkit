/**
 * @module botbuilder-adapter-mcp
 */
/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * The Model Context Protocol versions this package can speak, newest first.
 * During `initialize` the server answers with the version the client asked for when it is in this list,
 * and with `LATEST_PROTOCOL_VERSION` otherwise.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * The newest Model Context Protocol version this package speaks.
 * It is also used before a client has sent `initialize`.
 */
export const LATEST_PROTOCOL_VERSION = '2025-11-25';

/**
 * The severity levels of MCP log messages (`notifications/message`), from least to most severe.
 */
export type McpLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

/**
 * Every `McpLogLevel`, from least to most severe.
 * @ignore
 */
export const MCP_LOG_LEVELS: McpLogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

/**
 * The standard JSON-RPC 2.0 error codes used by this package.
 * @ignore
 */
export const JSONRPC_ERRORS = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603
};

/**
 * The key under which the adapter stores the `McpRequestState` of a tool call in `context.turnState`.
 * @ignore
 */
export const MCP_REQUEST_STATE = 'mcp.request';

/**
 * Hints that describe how a tool behaves. Clients use them to decide, for example, whether to ask the user before calling a tool.
 * They are hints only: clients must not rely on them for security.
 */
export interface McpToolAnnotations {
    /**
     * A human-readable title for the tool.
     */
    title?: string;

    /**
     * True if the tool does not change anything. Default false.
     */
    readOnlyHint?: boolean;

    /**
     * True if the tool may delete or overwrite data, false if it only adds. Only meaningful when readOnlyHint is false. Default true.
     */
    destructiveHint?: boolean;

    /**
     * True if calling the tool again with the same arguments has no further effect. Only meaningful when readOnlyHint is false. Default false.
     */
    idempotentHint?: boolean;

    /**
     * True if the tool reaches systems outside the bot, such as the web or a third-party API. Default true.
     */
    openWorldHint?: boolean;
}

/**
 * Describes a tool declared with [McpAdapter.tool()](#tool). The tool's handler is `controller.on('tool:<name>', handler)`.
 */
export interface McpToolDefinition {
    /**
     * A human-readable name for the tool. Sent to clients that negotiated protocol version 2025-06-18 or later.
     */
    title?: string;

    /**
     * What the tool does and when to use it. Agents read this to decide when to call the tool, so be specific.
     */
    description?: string;

    /**
     * A JSON Schema for the tool's arguments. It must have `type: 'object'`. Defaults to `{ type: 'object', properties: {} }`.
     * Arguments are checked with `validateArguments()` before the handler runs.
     */
    inputSchema?: { [key: string]: any };

    /**
     * A JSON Schema for the structured result the handler passes to `bot.toolResult()`. It must have `type: 'object'`.
     * Sent to clients that negotiated protocol version 2025-06-18 or later.
     * The result is checked against it with `validateArguments()`. A call whose handler does not call `bot.toolResult()`,
     * or passes a result that does not match, returns an error without `structuredContent`.
     */
    outputSchema?: { [key: string]: any };

    /**
     * Hints that describe how the tool behaves.
     */
    annotations?: McpToolAnnotations;
}

/**
 * One choice offered by a bot message, from its quick replies, suggested actions or card buttons.
 */
export interface McpChoice {
    /**
     * The label of the choice.
     */
    title: string;

    /**
     * The value to send to choose it.
     */
    value: string;
}

/**
 * An attachment of a bot message, as reported to the agent.
 */
export interface McpAttachment {
    /**
     * The MIME type of the attachment, or a card type such as `application/vnd.microsoft.card.hero`.
     */
    contentType: string;

    /**
     * The name of the attachment, if it has one.
     */
    name?: string;

    /**
     * The attachment's `contentUrl`, if it has one.
     */
    url?: string;

    /**
     * The card itself, for hero, thumbnail and adaptive cards only.
     */
    content?: any;
}

/**
 * One activity the bot sent, simplified for an agent. `typing`, `delay` and `trace` activities are never reported.
 */
export interface McpReply {
    /**
     * The activity type, usually `message` or `event`.
     */
    type: string;

    /**
     * The text of the message, with the HTML entities that mustache adds decoded (unless the `unescapeHtml` option is false).
     */
    text?: string;

    /**
     * The choices the message offers: quick replies or suggested actions, or else hero and thumbnail card buttons.
     */
    choices?: McpChoice[];

    /**
     * The attachments of the message.
     */
    attachments?: McpAttachment[];

    /**
     * The message's `channelData`, without `quick_replies` and `botkitEventType`. Only present when something is left.
     */
    data?: { [key: string]: any };

    /**
     * The name of an event activity.
     */
    name?: string;

    /**
     * The value of an event activity.
     */
    value?: any;
}

/**
 * The result of an MCP `tools/call` request, as returned by [McpAdapter.callTool()](#callTool).
 */
export interface McpCallToolResult {
    /**
     * Text for the agent to read.
     */
    content: { type: 'text'; text: string }[];

    /**
     * A structured result. Only sent to clients that negotiated protocol version 2025-06-18 or later.
     */
    structuredContent?: any;

    /**
     * True when the call failed. The text explains why.
     */
    isError?: boolean;
}

/**
 * Options for [McpAdapter.callTool()](#callTool).
 */
export interface McpCallMeta {
    /**
     * The progress token the client sent in `params._meta.progressToken`. `bot.progress()` does nothing without one.
     */
    progressToken?: string | number;

    /**
     * The id of the JSON-RPC request, passed to handlers as `message.mcp.requestId`.
     */
    requestId?: string | number;
}

/**
 * The state of one tool call while its turn runs, stored in `context.turnState` under `'mcp.request'`.
 * @ignore
 */
export interface McpRequestState {
    /**
     * The name of the tool that was called.
     */
    tool: string;

    /**
     * True for a call of the chat tool, false for a declared tool.
     */
    chat: boolean;

    /**
     * The replies the bot sent during the turn.
     */
    replies: McpReply[];

    /**
     * The choices of the last reply in the turn that offered any.
     */
    choicesInTurn: McpChoice[] | null;

    /**
     * The client's progress token, if it sent one.
     */
    progressToken?: string | number;

    /**
     * The JSON-RPC request id.
     */
    requestId?: string | number;

    /**
     * The value passed to `bot.toolResult()`.
     */
    structured: any;

    /**
     * True once `bot.toolError()` was called.
     */
    isError: boolean;

    /**
     * The messages passed to `bot.toolError()`.
     */
    errors: string[];

    /**
     * True once the turn has finished or timed out. Later messages go to the outbox.
     */
    done: boolean;
}

/**
 * An Error that carries a JSON-RPC error code, created with `rpcError()`.
 * @ignore
 */
export interface JsonRpcError extends Error {
    /**
     * The JSON-RPC error code sent to the client.
     */
    rpcCode: number;

    /**
     * Optional `data` for the JSON-RPC error object.
     */
    rpcData?: any;
}

/**
 * Create an Error that the adapter turns into a JSON-RPC error response with the given code and message,
 * instead of the generic `-32603 Internal error`.
 *
 * ```javascript
 * throw rpcError(-32602, 'Invalid params: name must be a string');
 * ```
 *
 * @param code A JSON-RPC error code, such as -32602 (invalid params).
 * @param message The error message sent to the client.
 * @param data Optional extra information for the client.
 * @returns An Error with `rpcCode` (and `rpcData`) set.
 * @ignore
 */
export function rpcError(code: number, message: string, data?: any): JsonRpcError {
    const err = new Error(message) as JsonRpcError;
    err.rpcCode = code;
    if (data !== undefined) {
        err.rpcData = data;
    }
    return err;
}
