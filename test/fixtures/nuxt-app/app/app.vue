<template>
  <div>
    <NuxtRouteAnnouncer />
    <header class="site-header">
      <NuxtLink to="/">Nuxt Shop</NuxtLink>
      <nav>
        <NuxtLink to="/products">Products</NuxtLink>
        <NuxtLink to="/about">About</NuxtLink>
      </nav>
    </header>
    <NuxtPage />
  </div>
</template>
