export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'application/xml')
  const urls = ['/', '/about', '/products']
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`
})
