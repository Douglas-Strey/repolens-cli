<script setup lang="ts">
withDefaults(defineProps<{ label: string; variant?: 'primary' | 'secondary' }>(), {
  variant: 'primary',
})

defineEmits<{ click: [event: MouseEvent] }>()
</script>

<template>
  <button type="button" :class="['acme-button', `acme-button--${variant}`]" @click="$emit('click', $event)">
    {{ label }}
  </button>
</template>
