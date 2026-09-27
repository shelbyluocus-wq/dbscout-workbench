<script setup>
import { language, t } from "../i18n/index.js";
const { locale, setLanguage } = language;
</script>

<template>
  <div class="wb-sidebar-settings-row wb-language-settings-row">
    <span class="wb-sidebar-settings-label">{{ t('settings.language') }}</span>
    <div class="wb-sidebar-theme-segment wb-language-segment" role="group" data-language-selector :aria-label="t('settings.language')">
      <button type="button" :class="{ active: locale === 'zh-CN' }" :aria-pressed="locale === 'zh-CN'" @click.stop="setLanguage('zh-CN')">简体中文</button>
      <button type="button" :class="{ active: locale === 'zh-TW' }" :aria-pressed="locale === 'zh-TW'" @click.stop="setLanguage('zh-TW')">繁體中文（台灣）</button>
      <button type="button" :class="{ active: locale === 'en' }" :aria-pressed="locale === 'en'" @click.stop="setLanguage('en')">English</button>
    </div>
  </div>
</template>
