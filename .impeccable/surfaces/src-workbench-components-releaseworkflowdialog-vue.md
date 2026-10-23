---
version: 1
slug: "src-workbench-components-releaseworkflowdialog-vue"
primary_target: "src/workbench/components/ReleaseWorkflowDialog.vue"
related_targets: ["src/workbench/releaseWorkflow.css","src/workbench/releaseWorkflowState.js","src/workbench/composables/useReleaseWorkflow.js","src/workbench/components/ReleasePrepareStage.vue","src/workbench/components/ReleaseDatabaseStage.vue","src/workbench/components/ReleaseClientStage.vue","src/workbench/components/ReleaseBuildStage.vue","src/workbench/components/ReleaseGmStage.vue","src/workbench/components/ReleaseLaunchStage.vue"]
---

# Release Workflow Rehearsal

## Scope and Mode

- Mode: Operate. A local extension of Blackcat, not a new visual identity.
- Audience/job: release operators rehearse one platform's release sequence, inspect planned changes, resolve simulated interruptions, and retain a clearly labeled report without touching live systems.
- Authority: PRODUCT.md and the incumbent compact, quiet, theme-aware workbench. Inherit existing typography, surfaces, controls, and slate/teal/azure light/dark tokens; do not establish a parallel token system.

## Built Direction

**Thesis:** One protected workspace rehearses a release without touching live systems.

**Story:** Prepare, preview, confirm, simulate, recover, and reopen in dependency order. Six stages cover preparation; database and availability planning; SVN/client copy, conversion and diff; Cocos build; GM uploads and scheduling; maintenance, restart, health checks and reopening.

**First viewport and memorable behavior:** Platform and release date establish the target. A six-step task rail keeps the sequence legible, one central stage scrolls, and a persistent action footer always exposes the next action or its blocking reason. A wide-screen target receipt keeps version, database, client and opening time alongside the task. The signature is a visible, reviewable release rehearsal, not an apparent live execution console.

## Layout and States

- Wide layout: left platform/step rail, central stage and fixed footer, right target receipt. At 1200px and below the receipt hides and export/reset move to compact rail tools. At 760px and below the workspace fills the viewport, the rail becomes horizontally scrollable steps, and diff/timeline content stacks. At 440px and below two-column forms become one column. Wide plan tables retain horizontal scrolling rather than crushing fields.
- Preserve pending, running, done, blocked, failed and cancelled states with explicit labels and progress. While running, editable inputs and navigation are disabled; cancellation remains available. Closing cancels the active simulation. Simulated SVN conflicts require choices; the build-failure example supports retry.
- Stage changes reset central scroll and focus the heading. Controls expose visible focus; progress/status updates and errors have accessible announcements. Reduced-motion styling removes spinner animation and progress transitions.
- Drafts and results are isolated per sample platform in localStorage. Input changes invalidate dependent results and review checks rather than preserving misleading successes. Storage failure remains visible; interrupted saved work restores as cancelled, with dependency validity checked.

## Content and Safety Truth

- Date ranges and explicit table/row/field mappings drive simulated availability previews. Notes are descriptive, never executable. Preserve/overwrite choices, exclusions, sample before/after files, command text, package labels and health results are rehearsal content, not evidence of real operations.
- Explicit review gates cover preparation, database changes, client differences and reopening. Reset requires confirmation. Navigation can inspect a later stage, but prerequisites still gate execution.
- Existing transfer templates are read-only choices: display their names and paths without editing them or running their scripts. Keep default examples synthetic.
- State and orchestration have no database, network, filesystem or native execution bridge. Timers simulate progress; localStorage retains drafts; a user-triggered JSON download exports the report. The build stage also offers an ordinary user-opened documentation link, not an engine integration.
- Keep the demo badge and safety explanation visible. Export names include DEMO and report content explicitly records `demo: true` and `realOperationsExecuted: false`. Scheduled times use Asia/Shanghai (UTC+8); this is not a live scheduler. No real game project is touched.

## Unresolved Future Work

Real GM authentication/APIs, uploads and scheduling; Cocos discovery/build invocation; database writes/backups; SVN, filesystem and native tool bindings remain outside this feature. Any real execution needs a separately reviewed boundary, permissions, target validation, recovery and truthful result evidence. Do not silently replace simulation callbacks with integrations or present this rehearsal's success as a production release.

## Evidence

Recorded from releaseWorkflow.css, ReleaseWorkflowDialog.vue, releaseWorkflowState.js, useReleaseWorkflow.js and the stage components. Finish reviewer disposition supplied at handoff: ship; material fixes: none. This brief records source behavior, not an additional browser audit or a global design-system rewrite.
