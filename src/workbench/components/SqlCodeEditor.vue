<script setup>
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
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { MySQL, sql } from "@codemirror/lang-sql";

import { buildSqlCompletionOptions } from "../utils/sqlCompletions.js";

const props = defineProps({
  modelValue: { type: String, default: "" },
  schema: { type: Array, default: () => [] },
  databases: { type: Array, default: () => [] },
  readOnly: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "execute", "save", "stop"]);
const host = ref(null);
let view = null;

function completionSource(context) {
  const word = context.matchBefore(/[\w$]*$/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return {
    from: word.from,
    options: buildSqlCompletionOptions(props.schema, props.databases),
    validFor: /^[\w$]*$/,
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
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      sql({ dialect: MySQL }),
      autocompletion({ override: [completionSource], activateOnTyping: true }),
      keymap.of([
        { key: "Ctrl-Enter", mac: "Cmd-Enter", run: () => runExecution(false) },
        { key: "F5", run: () => runExecution(true) },
        { key: "Escape", run: () => { emit("stop"); return false; } },
        { key: "Mod-s", run: () => { emit("save"); return true; } },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...completionKeymap,
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

<template><div ref="host" class="wb-sql-code-editor" aria-label="SQL 编辑器"></div></template>
