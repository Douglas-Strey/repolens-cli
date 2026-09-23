<script setup lang="ts">
const { data: products, status } = await useFetch('/api/products')
</script>

<template>
  <main>
    <h1>All products</h1>
    <p v-if="status === 'pending'">Loading…</p>
    <div v-else class="grid">
      <ProductCard v-for="product in products" :key="product.id" :product="product" />
    </div>
  </main>
</template>
