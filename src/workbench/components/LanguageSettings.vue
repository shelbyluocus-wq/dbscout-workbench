<script setup>
import { language, t } from "../i18n/index.js";
const { locale, setLanguage } = language;
</script>

<template>
  <div class="wb-sidebar-settings-row wb-language-settings-row">
    <span class="wb-sidebar-settings-label">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M3.5 12h17M12 3.5c2.4 2.5 3.6 5.3 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.3-3.6-8.5s1.2-6 3.6-8.5z" />
      </svg> {{ t('settings.language') }}</span>
    <div class="wb-sidebar-theme-segment wb-language-segment" role="group" data-language-selector :aria-label="t('settings.language')">
      <button type="button" :class="{ active: locale === 'zh-CN' }" :aria-pressed="locale === 'zh-CN'" aria-label="简体中文" @click.stop="setLanguage('zh-CN')">简体中文</button>
      <button type="button" :class="{ active: locale === 'zh-TW' }" :aria-pressed="locale === 'zh-TW'" aria-label="繁體中文（台灣）" title="繁體中文（台灣）" @click.stop="setLanguage('zh-TW')">繁體中文</button>
      <button type="button" :class="{ active: locale === 'en' }" :aria-pressed="locale === 'en'" aria-label="English" @click.stop="setLanguage('en')">English</button>
    </div>
  </div>
</template>
