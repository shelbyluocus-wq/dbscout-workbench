<script setup>
const props = defineProps({
  dialog: { type: Object, required: true },
  busy: { type: Boolean, default: false },
});

const emit = defineEmits(['submit', 'cancel']);
</script>

<template>
  <div v-if="dialog.open" class="wb-dialog-overlay" @click.self="emit('cancel')">
    <form class="wb-dialog" @submit.prevent="emit('submit')">
      <header class="wb-dialog-header">
        <strong>连接 MySQL 服务器</strong>
        <button type="button" class="wb-dialog-close" @click="emit('cancel')">×</button>
      </header>
      <label class="wb-dialog-field">
        <span>主机</span>
        <input v-model="dialog.host" placeholder="127.0.0.1" />
      </label>
      <label class="wb-dialog-field">
        <span>端口</span>
        <input v-model="dialog.port" placeholder="3306" />
      </label>
      <label class="wb-dialog-field">
        <span>用户名</span>
        <input v-model="dialog.username" placeholder="root" />
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
