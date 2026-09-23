<script setup lang="ts">
const route = useRoute()
const { data: product } = await useFetch(`/api/products/${route.params.id}`)

async function addToCart() {
  await $fetch('/api/cart', { method: 'POST', body: { productId: route.params.id, quantity: 1 } })
}
</script>

<template>
  <main v-if="product">
    <h1>{{ product.name }}</h1>
    <p>{{ product.description }}</p>
    <strong>{{ product.price }} €</strong>
    <button type="button" @click="addToCart">Add to cart</button>
  </main>
</template>
