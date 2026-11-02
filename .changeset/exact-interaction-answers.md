---
"@claudexor/schema": patch
"@claudexor/daemon": patch
"@claudexor/harness-claude": patch
"@claudexor/acp-server": patch
"@claudexor/cli": patch
---

Questions Claude Code asks through `AskUserQuestion` now reach every answering surface without the former length cuts (2,000 characters for a question, 100 for a header, 500 for an option label and 1,000 for a description), and a selected long label goes back unchanged (#560). Non-blank free text is sent as written; `claudexor follow` and the macOS card take one line per question. The daemon refuses an answer row that names a question the interaction does not list, repeats a question, or carries neither a label nor non-blank text (`rejected`), and the question stays pending; partial answers, the empty-set decline and selected labels are handled as before. A pending question that no live session holds is answered `not_found` instead of `delivered`, and `delivered` does not prove that the Claude process read the answer. In ACP, each permission prompt now also shows the question's header and option descriptions, a multi-select question with every option skipped is left out instead of sent as an empty row, and a turn-text message names every question left without an answer: with nothing chosen the run stays paused on the set until it is answered elsewhere or expires, and otherwise the message says the chosen answers will be submitted as a partial answer that closes the set once it is accepted. The macOS question card wraps long option labels and scrolls long questions inside a bounded area. No live Claude CLI was run for this change, and the cause of the incident reported in #560 is not established.
