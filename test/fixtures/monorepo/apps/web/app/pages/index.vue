<script setup lang="ts">
import { Button } from '@acme/ui'

const { data: stats, refresh } = await useFetch('/api/stats')
</script>

<template>
  <main>
    <h1>Acme</h1>
    <p v-if="stats">{{ stats.users }} users · {{ stats.orders }} orders</p>
    <Button label="Refresh" @click="refresh()" />
  </main>
</template>
