<script setup>
const props = defineProps({
  dialog: { type: Object, required: true },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(['submit', 'cancel']);

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
        <input v-model="dialog.host" placeholder="127.0.0.1" />
      </label>
      <label class="wb-dialog-field">
        <span>端口</span>
        <input v-model="dialog.port" :placeholder="dialog.kind === 'clickhouse' ? '8123' : '3306'" />
      </label>
      <label class="wb-dialog-field">
        <span>用户名</span>
        <input v-model="dialog.username" :placeholder="dialog.kind === 'clickhouse' ? 'default' : 'root'" />
      </label>
      <label class="wb-dialog-field">
        <span>密码</span>
        <input v-model="dialog.password" type="password" placeholder="密码" />
      </label>
      <p v-if="dialog.error" class="wb-dialog-error">{{ dialog.error }}</p>
      <footer class="wb-dialog-actions">
        <button type="button" @click="emit('cancel')">取消</button>
        <button type="submit" :disabled="busy">{{ busy ? "连接中…" : "连接服务器" }}</button>
      </footer>
    </form>
  </div>
</template>
