export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  build: {
    transpile: ['@acme/ui'],
  },
  runtimeConfig: {
    public: {
      apiUrl: '',
    },
  },
})
