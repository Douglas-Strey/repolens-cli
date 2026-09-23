export default defineEventHandler((event) => {
  console.log(`[${new Date().toISOString()}] ${event.method} ${getRequestURL(event).pathname}`)
})
