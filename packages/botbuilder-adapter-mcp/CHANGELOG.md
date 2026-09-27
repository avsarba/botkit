# botbuilder-adapter-mcp changelog

# 1.0.0

This is the first public release!

* NEW: `McpAdapter` serves any Botkit bot as a Model Context Protocol (MCP) server over stdio, with a dependency-free JSON-RPC 2.0 transport. It negotiates protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05.
* NEW: The `chat` tool runs a message through the full Botkit pipeline and returns the replies, the choices offered, `awaitingInput` and the pending question, so agents can walk BotkitConversation dialogs step by step. Calls are queued per session, and choice titles are mapped to their values.
* NEW: `adapter.tool(name, definition)` declares tools that are handled by `controller.on('tool:<name>')`, with arguments checked against the tool's `inputSchema` and structured results from `bot.toolResult()`.
* NEW: Proactive messages wait in a per-session outbox for the agent's next chat call and are also sent as log notifications.
* NEW: `McpBotWorker` with `bot.toolResult()`, `bot.toolError()`, `bot.log()`, `bot.progress()` and `bot.startConversationWithUser()`.
* NEW: Logging (`logging/setLevel`), progress notifications, request cancellation, JSON-RPC batches and turn timeouts.
* NEW: Console output is sent to stderr while the adapter is open, so only protocol messages reach stdout.
* Requires Botkit 4.11, which adds `controller.getPendingQuestion()` and makes failing handlers reject the turn.
