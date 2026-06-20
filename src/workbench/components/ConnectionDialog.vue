<script setup>
import { computed } from "vue";

const props = defineProps({
  dialog: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  testBusy: { type: Boolean, default: false },
});

const emit = defineEmits(["submit", "cancel", "test", "field-change"]);

const formComplete = computed(() =>
  Boolean(
    props.dialog.host?.trim() &&
      props.dialog.port?.trim() &&
      props.dialog.username?.trim(),
  ),
);

const testReady = computed(() => formComplete.value && Boolean(String(props.dialog.password ?? "").length));

function applyKindDefaults() {
  const kind = props.dialog.kind === "clickhouse" ? "clickhouse" : "mysql";
  props.dialog.kind = kind;
  if (kind === "clickhouse") {
    if (!props.dialog.port || props.dialog.port === "3306") props.dialog.port = "8123";
    if (!props.dialog.username || props.dialog.username === "root") props.dialog.username = "default";
  } else {
    if (!props.dialog.port || props.dialog.port === "8123") props.dialog.port = "3306";
    if (!props.dialog.username || props.dialog.username === "default") props.dialog.username = "root";
  }
  emit("field-change");
}

function onFieldChange() {
  emit("field-change");
}
</script>

<template>
  <div v-if="dialog.open" class="wb-dialog-overlay" @click.self="emit('cancel')">
    <form class="wb-dialog" @submit.prevent="emit('submit')">
      <header class="wb-dialog-header">
        <strong>连接数据库服务器</strong>
        <button type="button" class="wb-dialog-close" @click="emit('cancel')">×</button>
      </header>
      <label class="wb-dialog-field">
        <span>类型</span>
        <select v-model="dialog.kind" @change="applyKindDefaults">
          <option value="mysql">MySQL</option>
          <option value="clickhouse">ClickHouse</option>
        </select>
      </label>
      <label class="wb-dialog-field">
        <span>主机</span>
        <input v-model="dialog.host" placeholder="127.0.0.1" @input="onFieldChange" />
      </label>
      <label class="wb-dialog-field">
        <span>端口</span>
        <input
          v-model="dialog.port"
          :placeholder="dialog.kind === 'clickhouse' ? '8123' : '3306'"
          @input="onFieldChange"
        />
      </label>
      <label class="wb-dialog-field">
        <span>用户名</span>
        <input
          v-model="dialog.username"
          :placeholder="dialog.kind === 'clickhouse' ? 'default' : 'root'"
          @input="onFieldChange"
        />
      </label>
      <label class="wb-dialog-field">
        <span>密码</span>
        <input v-model="dialog.password" type="password" placeholder="密码" @input="onFieldChange" />
      </label>
      <p v-if="dialog.error" class="wb-dialog-error">{{ dialog.error }}</p>
      <footer class="wb-dialog-actions">
        <button type="button" @click="emit('cancel')">取消</button>
        <button
          type="button"
          class="wb-dialog-test-btn"
          :class="{ 'is-success': dialog.testPassed }"
          :disabled="testBusy || busy || !testReady"
          @click="emit('test')"
        >
          {{ testBusy ? "测试中…" : dialog.testPassed ? "✓ 连接成功" : "测试连接" }}
        </button>
        <button
          type="submit"
          :class="{ 'wb-dialog-primary': dialog.testPassed }"
          :disabled="busy || testBusy || !formComplete"
        >
          {{ busy ? "连接中…" : "连接服务器" }}
        </button>
      </footer>
    </form>
  </div>
</template>