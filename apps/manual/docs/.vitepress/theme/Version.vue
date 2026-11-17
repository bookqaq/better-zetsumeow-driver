<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ kind?: 'userscript' | 'sdk' }>(), {
  kind: 'userscript',
})

const version = computed(() =>
  props.kind === 'sdk' ? __MANUAL_SDK_VERSION__ : __MANUAL_VERSION__,
)
</script>

<template>
  <span class="manual-version" :title="`v${version}`">v{{ version }}</span>
</template>
