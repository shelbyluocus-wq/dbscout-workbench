# Homepage Keyboard Interactions Design

**Status:** Approved on 2026-07-10

## Goal

Make the database homepage behave consistently with the data-table page:
table-object copy and paste must work regardless of incidental focus, F2 rename
must focus the editor and save on blur, and Ctrl/Cmd+F must focus the search
field for the currently focused page.

## Confirmed Root Causes

- Homepage Ctrl/Cmd+C and Ctrl/Cmd+V are handled only by the table list or a
  table-name button. Closing the context menu or switching databases can leave
  focus outside that subtree, so paste never reaches the homepage handler.
- The globally reused homepage tab keeps the same component key while its
  database changes. `DatabaseHome` therefore retains controller values from
  the database used when the component first mounted, including the copy
  source database.
- The rename input is rendered inside `v-for`, so its template ref is an array,
  but the focus watcher treats it as one element. The input also has no blur
  submission path.
- The document-level Ctrl/Cmd+F handler always prevents the WebView default,
  then attempts to focus only the data-table search. On a homepage it consumes
  the shortcut without focusing anything.

## Selected Design

### Homepage copy and paste

- Keep the existing application-level table-object clipboard and backend
  `copy_tables` request contract.
- Expose homepage copy and paste commands through `DatabaseHome`, then through
  the focused `WorkbenchPane` state.
- Route Ctrl/Cmd+C and Ctrl/Cmd+V from the existing document capture handler
  when the focused tab is a homepage. Do not intercept editable targets, so
  text inputs and textareas retain native clipboard behavior.
- Key `DatabaseHome` by the homepage `tabKey`, which changes with connection
  and database, instead of the globally reused tab id. This remounts the local
  controller with the current source and clears stale selection/query state
  that `workspaceState` already resets on a database switch.

### F2 rename

- Replace the `v-for` string ref with a callback ref that stores the single
  active rename input element. F2 then focuses and selects the full table name.
- Submit the same rename event from Enter and blur. Use a small per-edit guard
  so Enter followed by DOM blur emits at most one request.
- Escape marks the edit as cancelled before removing the input, preventing its
  blur from saving.
- An unchanged draft exits silently. Empty, duplicate, or invalid names remain
  in edit mode and keep the existing visible validation message.

### Ctrl/Cmd+F

- Give the homepage search input a ref and expose a `focusSearch` command that
  focuses and selects its current value.
- Let `WorkbenchPane` expose one `focusCurrentSearch` command. It chooses the
  homepage search for a focused home tab and the existing table search for a
  focused data tab.
- Keep the document capture listener so native WebView find never appears, but
  route it through the focused pane rather than through global table state.

## Error Handling

- Copy and paste shortcuts are considered handled only when the homepage
  controller can perform the action. Read-only behavior and backend errors
  continue to use the existing status bar messages.
- Invalid rename drafts are not sent to the backend. A valid draft is cancelled
  locally immediately after emitting; backend failure continues to surface in
  the global status bar.
- Editable controls are excluded from homepage Ctrl/Cmd+C and Ctrl/Cmd+V so
  selecting text in search or rename fields remains safe.

## Verification

- Add focused Node regression assertions before each production change and
  observe them fail for the current implementation.
- Run homepage controller, workspace state, shortcut, and shell wiring tests.
- Run the complete frontend test set and record unrelated baseline failures.
- Run `npm run build`.
- Use Playwright against the browser demo to verify context-menu copy followed
  by Ctrl+V, cross-database paste source/target, F2 focus and blur save, Escape
  cancellation, homepage Ctrl+F, and unchanged table-page Ctrl+F behavior.

## Out Of Scope

- Replacing the application-level table-object clipboard with the operating
  system text clipboard.
- Redesigning the shortcut settings model.
- Changing backend copy or rename semantics.
