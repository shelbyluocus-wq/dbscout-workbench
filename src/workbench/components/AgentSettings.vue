<script setup>
const props = defineProps({
  assistant: { type: Object, required: true },
});
</script>

<template>
  <section class="wb-ai-config-panel" aria-label="Agent 设置">
    <label>
      <span>API Key（可选）</span>
      <input
        v-model="assistant.apiKey.value"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="留空使用本机 Claude Code 登录"
      />
    </label>
    <label>
      <span>Base URL（可选）</span>
      <input
        v-model="assistant.apiUrl.value"
        type="url"
        autocomplete="off"
        spellcheck="false"
        placeholder="留空使用 Anthropic 官方端点"
      />
    </label>
    <label>
      <span>模型（可选）</span>
      <input
        v-model="assistant.model.value"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="留空使用默认"
      />
    </label>
    <label>
      <span>模式</span>
      <select v-model="assistant.permissionMode.value">
        <option value="default">执行模式</option>
        <option value="plan">计划模式</option>
      </select>
    </label>
    <small>Key、地址、模型留空时，使用本机 Claude Code 的登录与默认设置。</small>
  </section>
</template>
