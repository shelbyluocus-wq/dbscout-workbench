# Product

## Register

product

## Users

DB Scout Workbench is for developers, database operators, and technical users who need to inspect and edit MySQL data from a desktop workbench. They are usually in a focused maintenance or debugging workflow: opening connections, browsing schemas, paging through tables, filtering rows, editing cells, inserting and deleting records, and exporting or importing table data.

## Product Purpose

The product provides an independent, cross-platform MySQL workbench built with Tauri, Vue, and Rust. Success means users can move through database reading and editing tasks with the speed, density, and predictability of familiar desktop database tools, while still having a safe mock/demo mode for browser-only development.

## Brand Personality

Quiet, precise, capable. The interface should feel like a trustworthy data instrument: dense enough for real work, calm enough for long sessions, and explicit about state, errors, and pending edits.

## Anti-references

Avoid marketing-page styling, decorative dashboards, oversized cards, novelty interactions, and visual effects that compete with the data grid. Avoid generic SaaS polish that makes destructive database actions feel casual. Avoid hiding essential state behind animation, color alone, or hover-only controls.

## Design Principles

1. Keep database work in flow: preserve keyboard navigation, stable panes, predictable tabs, and fast table scanning.
2. Make state legible: loading, pending saves, errors, selection, filters, sorting, and destructive actions must be visible and unambiguous.
3. Prefer dense clarity over decoration: every pixel should help navigation, comparison, editing, or inspection.
4. Respect desktop workbench expectations: familiar controls beat invented affordances unless the workflow clearly improves.
5. Build for long sessions: contrast, focus states, reduced motion, and theme support matter because users may stay in the tool for hours.

## Accessibility & Inclusion

Default target is WCAG AA. Keyboard access, visible focus, sufficient contrast in light and dark themes, non-color-only state indicators, and reduced-motion alternatives should be treated as production requirements.
