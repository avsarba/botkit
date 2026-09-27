# Botkit examples

Runnable examples that use the packages in this repository. They need no credentials, accounts or network access.

| Example | What it shows
|--- |---
| [Ops Desk](ops-desk/readme.md) | One Botkit bot served three ways that have nothing to do with chat apps: as an interactive terminal app, as an unattended CI step driven by an answers file, and as an MCP server that AI agents such as Claude Code can use. It includes a guided deploy dialog, reminders and health watches from the scheduler, and a nightly cron report. Built on [botbuilder-adapter-cli](../botbuilder-adapter-cli), [botbuilder-adapter-mcp](../botbuilder-adapter-mcp) and [botkit-plugin-scheduler](../botkit-plugin-scheduler).

## Run the examples

This is a private package in the Botkit monorepo. From the root of the repository:

```bash
npm install
npm run build
cd packages/examples
npm run start:cli      # Ops Desk in the terminal
npm run -s start:mcp   # Ops Desk as an MCP server on stdio
npm test               # in-process and child-process tests of every example
```

Keep the `-s` (`--silent`) in `npm run -s start:mcp`. An MCP server's stdout carries only protocol messages, and without `-s` npm writes its own banner there first. MCP clients should start the server with `node` and the absolute path to `ops-desk/mcp.js`, as the [Ops Desk readme](ops-desk/readme.md#3-as-an-mcp-server-for-ai-agents) shows.

Read the [Botkit Beyond Chat guide](../docs/beyond-chat.md) for the ideas behind these examples.
