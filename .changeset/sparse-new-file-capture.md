---
"@claudexor/workspace": patch
---

Capture new files created outside a sparse checkout's patterns. A run in a sparse checkout that created such a file (a test beside the checked-out directory, review evidence) failed to save its result, and every later capture and dirty snapshot of that checkout failed too; with Git 2.41 or newer the result and the snapshot now hold the file, and a later turn records its edit or removal, unless the checkout leaves the file out itself, as a worktree made on the snapshot does. Files HEAD tracks outside the patterns stay untouched, ignored files stay out, and delivery into a sparse checkout still refuses paths outside its patterns. A new file there that only a `.gitignore` outside the patterns ignores still fails the capture and every later capture and dirty snapshot, and with a Git older than 2.41 any new file there does (#734).
