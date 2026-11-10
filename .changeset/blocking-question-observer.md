---
"@claudexor/cli": patch
"@claudexor/acp-server": patch
---

An ACP prompt for a blocking question no longer holds the turn. `session/cancel`
now reaches a run that is parked on a question, and a prompt whose question was
answered elsewhere, expired or outlived its run closes without the editor
replying. The agent stays parked until its question is settled, a turn that was
cancelled no longer reports a run still paused, and a prompt that fails still
fails the turn.
