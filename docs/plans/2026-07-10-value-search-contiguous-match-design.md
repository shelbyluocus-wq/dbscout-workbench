# Value Search Contiguous Match Design

## Goal

Change value search from fuzzy character-sequence matching to case-insensitive contiguous substring matching. A cell containing `abc21020xyz` matches `21020`; a cell containing only separated fragments such as `2...10...20` does not. The whole cell does not need to equal the query.

## Scope

- Apply the rule to value search in MySQL, ClickHouse, demo data, and the browser mock backend.
- Keep query trimming and literal treatment of SQL wildcard characters.
- Highlight only a contiguous query range in value-result previews.
- Preserve fuzzy matching for table names, column names, and normal grid filtering.
- Do not add a search-mode switch.

## Data Flow

The frontend sends the trimmed query through the existing `search_values` command. Every backend adapter evaluates the same case-insensitive contiguous-substring rule and returns at most one preview per matching column. Long values are windowed around the actual match so the preview always contains the accepted range. The sidebar and quick-open views use a contains-only highlighter for value previews while retaining the existing fuzzy highlighter for schema metadata.

## Verification

Regression tests must prove that a contiguous value matches, a separated subsequence does not, matching is case-insensitive, SQL wildcard characters remain literal, a match after the first 80 characters remains visible, Unicode case expansion and character boundaries remain aligned, and value-result highlighting never marks separated characters.
