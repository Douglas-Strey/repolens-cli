<script setup lang="ts">
const { data: products } = await useFetch('/api/products')
</script>

<template>
  <main>
    <h1>Featured products</h1>
    <div class="grid">
      <ProductCard v-for="product in products?.slice(0, 3)" :key="product.id" :product="product" />
    </div>
  </main>
</template>
