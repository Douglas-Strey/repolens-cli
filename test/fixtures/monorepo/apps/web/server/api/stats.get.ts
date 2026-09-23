export default defineEventHandler(async () => {
  const config = useRuntimeConfig()
  const users = await $fetch<unknown[]>('/api/users', { baseURL: config.public.apiUrl })

  return {
    users: users.length,
    orders: 0,
  }
})
