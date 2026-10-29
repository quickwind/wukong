# Files panel: search across file contents (and replace)

## Intent

The Files panel in the Explorer sidebar can only browse. To find where a string is used, people leave
Paseo or ask an agent. They want what VS Code's Search view does: type text, see every matching line
in the workspace, click one to open the file at that line, and replace across files.

The daemon has no content search today. `directory_suggestions_request` matches file paths only (it
powers the command center and `@` mentions), so this is new work in three layers: protocol, daemon,
app.

## Delivery: two milestones

- **Milestone 1: search.** Magnifier, query, toggles, include/exclude, streamed results grouped by file,
  press a match to open the file at that line.
- **Milestone 2: replace.** Replace box, preview, per-match and per-file exclusion, write, conflict
  handling. It ships after milestone 1 has been used.

Milestone 1's protocol and result shape must not rule out milestone 2 (see "Replace" below for what
the search results have to carry). Milestone 2 may add its own messages behind its own
`server_info.features.*` flag.

## Goals

- A magnifier icon in the Files toolbar, next to the New folder icon (`files-new-folder`,
  `packages/app/src/components/file-explorer-pane.tsx`). One press opens the search area, a second
  press closes it and shows the file tree again. Nothing about search is visible while it is closed.
- The search area has: a query box, toggles for match case, regular expression and whole word, and an
  include/exclude glob box. Milestone 2 adds an expandable replace box.
- Results replace the tree while search is open. They are grouped by file; each match shows its line
  with the matched text highlighted. Pressing a match opens that file at that line.
- Results stream in: the first matches appear while the search is still running. A newer query cancels
  the running one.
- Search stays fast: the user types and results follow without the UI or the daemon stalling.
- Works in any workspace folder, git repository or not.

## Non-goals

- Searching outside the workspace directory.
- Searching git history, other branches, or agent transcripts.
- Search-as-you-type of file names (the command center already does that).
- Multi-line patterns, preserve-case replace, saved searches, search history.
- Searching the unsaved text in open editors (VS Code does; a later improvement).
- A new panel type or a new Explorer tab. Search lives inside the Files panel.
- Following or depending on upstream PR #4659 (below).

## Anti-goals

- A replace that silently changes a file the user is editing, or that rewrites a file with a different
  line ending or encoding than it had.
- A search that blocks the daemon for other clients or agents.
- Search UI taking toolbar or tree space when closed.

## Constraints

- **Protocol compatibility** ([docs/protocol-compatibility.md](../../protocol-compatibility.md)): the
  new messages are optional additions, with dotted names and `.request`/`.response` pairs
  ([docs/rpc-namespacing.md](../../rpc-namespacing.md)). Wire schemas stay pure (no `.transform()`,
  `.catch()`, `.preprocess()`). The app gates the feature once on a new `server_info.features.*` flag;
  an older daemon gets "update the host", no fallback path.
- **Irix** ([IRIX.md](../../../IRIX.md)): the smallest footprint on upstream. New code goes in new
  files. The unavoidable upstream edits are the toolbar button and the search/tree switch in
  `file-explorer-pane.tsx`, the message schemas in `protocol/src/messages.ts`, the request handler
  wiring in the session, and the feature flag. Each carries an `Irix:` comment, and the footprint
  budget in `irix/scripts/upstream-footprint.mjs` must be kept or raised on purpose. Walk the ladder in
  IRIX.md before each of them.
- **Windows without administrator rights** is a target machine. Nothing may be downloaded at install
  or run time (no traffic from the daemon to the internet).
- **Process cost:** on a busy Windows daemon every spawned process waits in a queue (a
  `checkout_status_request` took 26 s in one log; IRIX.md, "The lookups behind the click are cached").
  One search process at a time per workspace.
- The app is cross-platform (iOS, Android, web, Electron). Follow
  [docs/design.md](../../design.md), [docs/hover.md](../../hover.md), [docs/forms.md](../../forms.md)
  and the platform-gating rules in `CLAUDE.md`. On compact layouts the Explorer is an overlay; the
  search area must work at that width and with a touch keyboard.

## Decided

- **Our own stack, not upstream's (user's decision).** Upstream PR #4659 (open, by the maintainer)
  adds workspace content search in the Command Center over `fs.content.search.request` and
  `fs.content.search.cancel.request`, backed by ripgrep, without regex, globs, replace or any Files
  panel change. We do not build on it. Use RPC names that do **not** collide with those two, so a later
  upstream merge does not clash in `messages.ts`. When #4659 or anything like it lands on `main`, the
  fork revisits the overlap; this design does not try to anticipate it. (Upstream closed an earlier
  Files-panel search PR, #3048, saying it prefers a plugin; the plugin surfaces cannot do this: no hook
  into the Files panel, no open-file-at-line navigation, no view of unsaved editor buffers.)
- **Engine: ripgrep, shipped with Irix (user's decision to bundle; the rest is my call).**
  - Packaging downloads a pinned `rg` release for each shipped platform (Windows x64 at least) on the
    machine that builds the tarballs, verifies its checksum, and puts it in a new Irix-owned location in
    the tarball. Nothing is fetched at install or run time. ripgrep is MIT/Unlicense: run
    `irix/scripts/license-audit.mjs`, add its license to the `NOTICE`, and name the source in the commit
    message (IRIX.md, "Rules for every change"). The daemon resolves the binary through an Irix-owned
    module: the bundled copy first, then `rg` on `PATH` (useful in a source checkout).
  - **First prerequisite, before building anything:** someone runs the pinned `rg.exe` on a real company
    Windows machine (`rg --version` and one search) to confirm application allow-listing or antivirus
    does not block it. If it is blocked, stop and go back to the owner: the fallback would be `git grep`
    (which changes the non-git-folder decision) or a different delivery.
  - Run it without a shell, one process per search, `--json` output parsed line by line, so matches
    stream to the app in batches. Cancelling kills the process. Include `--no-require-git` style
    behavior so `.gitignore` is respected in folders that are not git repositories.
  - Measured on this repository (about 6300 files, macOS, warm cache): ripgrep 60 ms against
    `git grep` 80 ms for a plain string and 60 ms against 167 ms for a regex. Windows numbers are
    unknown.
- **Limits (my call):** at least 2 characters before a search starts; 100 ms debounce; one search per
  workspace at a time; results capped (starting point: 500 matches or 100 files, configurable later)
  with a visible "results truncated" line when the cap stops the search; each returned line trimmed
  around the match to a few hundred characters (VS Code's defaults, 20000 results and 10000
  characters per line, are too large for a side panel); binary files skipped (ripgrep default).
- **Performance** is the user's stated worry. The builder measures on a large repository, on Windows if
  one can be had, and reports the numbers; the limits above may move. The engine can change only with
  the owner's approval.
- **Regex dialect (my call):** ripgrep's (Rust regex). The UI says so near the toggle. Lookaround and
  backreferences are not available unless ripgrep's PCRE2 mode is shipped; do not promise them.
- **Encoding (my call):** replace writes only UTF-8 files (a BOM is allowed, and preserved). Files in
  any other encoding are searched as ripgrep sees them but are skipped by replace and marked.
- **Ignored files (my call):** files ignored by `.gitignore` (including `node_modules`) are not searched.
  Only the workspace root is searched; submodules and nested repositories are not entered.
- **Performance target (my call):** "a normal repository" means a few thousand files; the target is
  first results and the full result in under a second there.

## Replace (milestone 2)

- Flow: preview, per-match and per-file exclusion, then write. Nothing is written until the user
  presses Replace.
- **Conflicts (user's decision):** a file with unsaved edits in the editor of this client, or one that
  changed on disk after the search ran, is **skipped** and marked in the results. The other files are
  still replaced. No forced overwrite, no all-or-nothing. This is deliberately stricter than VS Code,
  whose replace applies edits to the editor's text model and then saves the whole model, so unsaved
  edits get saved along with it. Paseo's daemon writes the disk and the editor buffer lives in the app,
  so the two can disagree.
- "Changed on disk since the search" (my call): each file in the search results carries its modification
  time and size; replace compares them and also confirms the matched line text is unchanged, otherwise
  the file is skipped.
- Unsaved edits in a file open on another device are out of scope; the disk check covers them.
- Search and replace must agree on what matches. Compute replacements with the same engine that found
  the matches (ripgrep's `--replace` takes `$1`-style capture groups) rather than a second regex
  implementation in JavaScript.

## Left to the builder

- Exact RPC message shapes and names (not `fs.content.search.*`), the feature flag names, and where the
  handler lives on the daemon (a new file next to `server/file-explorer/` is expected).
- How the app detects "unsaved edits in an editor", given that the file editor keeps unsaved text in
  the mounted view ([docs/explorer-sidebar.md](../../explorer-sidebar.md), "Sheets"), and what it sends
  with the replace request.
- Glob syntax and how include/exclude map to ripgrep's `-g` rules.
- Result list virtualization, keyboard navigation, and the compact-layout presentation.
- How streamed batches are delivered over the existing WebSocket protocol.
- i18n: upstream strings are translated; Irix's own are English only (IRIX.md, "Web UI").
- Tests per [docs/testing.md](../../testing.md): the daemon handler against a real temporary folder and a
  real `rg`, pure functions for result grouping and replace-edit computation, and the app state for
  open/close and conflict behavior. No full-suite runs.
- Documentation: update the doc that owns the Files panel, and IRIX.md's upstream-files table for each
  upstream file touched, plus the packaging section for the bundled `rg`.

## Success

Milestone 1: a user opens Files, presses the magnifier, types a word, sees the first matches almost at
once and the full list in under a second on a normal repository, presses one and lands on that line,
and can close search to get the tree back.

Milestone 2: the user replaces across files with a preview, and files that changed meanwhile or have
unsaved edits are left alone and reported.
