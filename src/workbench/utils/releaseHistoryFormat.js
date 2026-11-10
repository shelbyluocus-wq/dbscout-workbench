// Wording of history entries, shared by the history list and its detail.
import { t } from "../i18n/index.js";
import { RELEASE_SCOPES } from "../releaseFlowState.js";

/** "Database, client" / "Client build · android" / "SVN commit r52818". */
export function historyTitle(entry, translate = t) {
  if (entry.kind === "build") {
    return translate("releaseFlow.history.title.build", { platform: entry.details?.platform || "" });
  }
  if (entry.kind === "svn") {
    const details = entry.details || {};
    const count = details.paths?.length || 0;
    if (details.action === "commit") {
      return details.revision
        ? translate("releaseFlow.history.title.commit", { revision: details.revision })
        : translate("releaseFlow.history.title.commitFiles", { count });
    }
    return translate(details.action === "revert" || details.action === "resolve" ? `releaseFlow.history.title.${details.action}` : "releaseFlow.history.title.svn", { count });
  }
  const scopes = RELEASE_SCOPES.filter((scope) => entry.brief?.scope?.[scope]).map((scope) => translate(`releaseFlow.scope.${scope}`));
  return scopes.join(translate("releaseFlow.list.separator")) || translate("releaseFlow.history.kind.release");
}

/** Group entries (newest first) by local day for headings. */
export function groupHistoryByDay(entries) {
  const groups = [];
  for (const entry of entries) {
    const date = new Date(entry.finishedAt);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const last = groups.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else groups.push({ key, at: entry.finishedAt, entries: [entry] });
  }
  return groups;
}
