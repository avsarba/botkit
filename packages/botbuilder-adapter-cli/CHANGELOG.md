# botbuilder-adapter-cli changelog

# 1.0.0

This is the first public release!

* NEW: `CliAdapter` runs any Botkit bot in a terminal. Typed or piped lines run through the full Botkit pipeline, one turn at a time, and replies are printed as `bot> ...`.
* NEW: Quick replies, suggested actions and card buttons render as numbered menus. Type a number or a title to pick a choice, or press Enter for `channelData.default`.
* NEW: Slash-commands `/help`, `/quit`, `/event`, `/as`, `/new`, `/state`, `/raw` and `/json`, plus custom commands with the `commands` option.
* NEW: `adapter.run({ dialog, vars })` runs a BotkitConversation as a wizard and resolves with `{ status, vars, exitCode }`.
* NEW: Unattended mode for CI: `answers` answers questions by key, and `nonInteractive` uses defaults or fails with exit code 2 instead of waiting.
* NEW: `format: 'json'` writes one JSON object per line for other programs.
* NEW: `adapter.submit(line)` processes a line and resolves with the printed lines, for offline tests.
* NEW: `CliBotWorker` with `bot.progress()`, `bot.startConversationWithUser()` and `bot.cli`.
* Requires Botkit 4.11, which adds `controller.getPendingQuestion()` and makes failing handlers reject the turn.
