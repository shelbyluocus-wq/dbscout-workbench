<script setup>
import { t } from "../i18n/index.js";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  ViewUpdate,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { MySQL, sql } from "@codemirror/lang-sql";

import { buildSqlCompletionOptions, getSqlCompletionContext } from "../utils/sqlCompletions.js";
import { sqlSyntaxHighlighting } from "../utils/sqlEditorTheme.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  schema: { type: Array, default: () => [] },
  database: { type: String, default: "" },
  databases: { type: Array, default: () => [] },
  readOnly: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "execute", "save", "stop"]);
const host = ref(null);
let view = null;

function completionSource(context) {
  const completionContext = {
    ...getSqlCompletionContext(context.state.doc.toString(), context.pos),
    database: props.database,
  };
  if (completionContext.kind === "blocked") return null;
  if (!completionContext.prefix && !context.explicit && !completionContext.auto) return null;
  const options = buildSqlCompletionOptions(props.schema, props.databases, completionContext)
    .map((option) => {
      if (!option.template) return option;
      const { template, ...completion } = option;
      return snippetCompletion(template, completion);
    });
  if (!options.length) return null;
  return {
    from: completionContext.from,
    options,
    validFor: /^[\w$\u0080-\uFFFF]*$/,
  };
}

function executionContext(all = false, explain = false) {
  if (!view) return { all, explain };
  const selection = view.state.selection.main;
  return {
    all,
    explain,
    selectionFrom: selection.from,
    selectionTo: selection.to,
    cursor: selection.head,
  };
}

function runExecution(all = false, explain = false) {
  emit("execute", executionContext(all, explain));
  return true;
}

function buildState(doc) {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      sqlSyntaxHighlighting,
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      sql({ dialect: MySQL }),
      autocompletion({
        override: [completionSource],
        activateOnTyping: true,
        maxRenderedOptions: 80,
        interactionDelay: 50,
      }),
      keymap.of([
        ...completionKeymap,
        { key: "Tab", run: acceptCompletion },
        { key: "Ctrl-Enter", mac: "Cmd-Enter", run: () => runExecution(false) },
        { key: "F5", run: () => runExecution(true) },
        { key: "Escape", run: () => { emit("stop"); return false; } },
        { key: "Mod-s", run: () => { emit("save"); return true; } },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
      ]),
      EditorView.editable.of(!props.readOnly),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit("update:modelValue", update.state.doc.toString());
      }),
      EditorView.theme({
        "&": { height: "100%" },
        ".cm-scroller": { overflow: "auto", fontFamily: "var(--wb-font-mono)" },
      }),
    ],
  });
}

onMounted(() => {
  view = new EditorView({ state: buildState(props.modelValue), parent: host.value });
  view.focus();
});

watch(() => props.modelValue, (value) => {
  if (!view || value === view.state.doc.toString()) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
});

onBeforeUnmount(() => view?.destroy());
defineExpose({
  executionContext,
  focus: () => view?.focus(),
  revealOffset: (offset) => {
    if (!view) return;
    const anchor = Math.max(0, Math.min(view.state.doc.length, Number(offset) || 0));
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    view.focus();
  },
});
</script>

<template><div ref="host" class="wb-sql-code-editor" :aria-label="t('m_7af65951e236')"></div></template>
