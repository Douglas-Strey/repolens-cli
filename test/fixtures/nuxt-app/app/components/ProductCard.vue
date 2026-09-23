<script setup lang="ts">
defineProps<{
  product: { id: number; name: string; price: number }
}>()
</script>

<template>
  <NuxtLink :to="`/products/${product.id}`" class="product-card">
    <h2>{{ product.name }}</h2>
    <span>{{ product.price }} €</span>
  </NuxtLink>
</template>
