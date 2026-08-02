<script setup>
import { computed } from "vue";

// 切库流光覆盖层：跨数据库切换标签时，沿中间内容区三边（左/顶/右）播放一段
// 流光，并在区域中央浮现「服务名 · 数据库显示名」。纯展示组件，动画全部在 CSS
// keyframes 中（workbench.css 的 wb-db-glow-*），:key 变化即重播。
const props = defineProps({
  playback: { type: Object, default: null },
});

// U 形轨迹：左下角升起 → 顶边（标签栏下沿）横穿 → 右侧降下，无底边。
// 坐标按 100×100 viewBox 书写，配合 preserveAspectRatio="none" 自适应区域尺寸。
const GLOW_PATH = "M 0.4 100 L 0.4 1.6 Q 0.4 0.4 1.6 0.4 L 98.4 0.4 Q 99.6 0.4 99.6 1.6 L 99.6 100";

const dotStyle = computed(() => ({
  background: props.playback?.markerColor || "var(--wb-glow-color)",
}));
</script>

<template>
  <div v-if="playback" :key="playback.id" class="wb-db-glow-layer" aria-hidden="true">
    <svg class="wb-db-glow-svg" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
      <path
        class="wb-db-glow-path wb-db-glow-path-halo"
        :d="GLOW_PATH"
        pathLength="100"
        vector-effect="non-scaling-stroke"
      />
      <path
        class="wb-db-glow-path wb-db-glow-path-core"
        :d="GLOW_PATH"
        pathLength="100"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <div class="wb-db-glow-label">
      <span class="wb-db-glow-label-dot" :style="dotStyle"></span>
      <span v-if="playback.service" class="wb-db-glow-label-engine">{{ playback.service }}</span>
      <span v-if="playback.service" class="wb-db-glow-label-sep">·</span>
      <span class="wb-db-glow-label-name">{{ playback.label }}</span>
    </div>
  </div>
</template>
