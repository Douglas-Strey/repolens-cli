// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  modules: ['@nuxt/eslint'],
  runtimeConfig: {
    // Server-only; overridden by NUXT_STRIPE_SECRET_KEY at runtime
    stripeSecretKey: '',
    public: {
      // Overridden by NUXT_PUBLIC_API_BASE
      apiBase: '',
    },
  },
})
