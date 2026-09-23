export default defineEventHandler(() => ({
  status: 'ok',
  uptime: process.uptime(),
}))
