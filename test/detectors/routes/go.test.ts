import { describe, expect, it } from 'vitest'
import { goModuleFrameworks, parseGoImports, parseServeMuxPattern } from '../../../src/detectors/routes/go.ts'
import { find, fixtureRoutes, routesOf, summary } from './helpers.ts'

function goMod(...requires: string[]): string {
  return `module example.com/app\n\ngo 1.25\n\nrequire (\n${requires.map((r) => `\t${r} v1.0.0`).join('\n')}\n)\n`
}

describe('Go helpers', () => {
  it('parses ServeMux patterns', () => {
    expect(parseServeMuxPattern('GET /metrics')).toEqual({ method: 'GET', path: '/metrics' })
    expect(parseServeMuxPattern('/debug/vars')).toEqual({ method: 'ANY', path: '/debug/vars' })
    expect(parseServeMuxPattern('POST /items/{id}')).toEqual({ method: 'POST', path: '/items/{id}' })
    expect(parseServeMuxPattern('example.com/')).toBeNull()
    expect(parseServeMuxPattern('PROPFIND /dav')).toBeNull()
  })

  it('parses imports with aliases and versioned paths', () => {
    const imports = parseGoImports(
      'import (\n\t"net/http"\n\tfiber "github.com/gofiber/fiber/v2"\n\t"github.com/labstack/echo/v4"\n\t_ "embed"\n)\nimport chi "github.com/go-chi/chi/v5"',
    )
    expect([...imports]).toEqual([
      ['http', 'net/http'],
      ['fiber', 'github.com/gofiber/fiber/v2'],
      ['echo', 'github.com/labstack/echo/v4'],
      ['chi', 'github.com/go-chi/chi/v5'],
    ])
    // Imports after the first declaration are not imports.
    expect(parseGoImports('package x\nfunc f() {}\nimport "net/http"\n').size).toBe(0)
  })

  it('allows frameworks the module requires plus net/http', () => {
    expect([...goModuleFrameworks(['github.com/gin-gonic/gin', 'github.com/google/uuid'])]).toEqual([
      'go-net-http',
      'gin',
    ])
  })
})

describe('Go routes', () => {
  it('extracts the go-api fixture (gin groups and net/http patterns)', async () => {
    const { routes } = await fixtureRoutes('go-api')
    expect(routes.map((r) => `${r.method} ${r.path} ${r.framework} ${r.file}:${r.line} ${r.confidence}`)).toEqual([
      'GET /api/v1/users gin cmd/api/main.go:35 high',
      'POST /api/v1/users gin cmd/api/main.go:36 high',
      'GET /api/v1/users/:id gin cmd/api/main.go:37 high',
      'ANY /debug/vars go-net-http internal/metrics/metrics.go:22 high',
      'GET /health gin cmd/api/main.go:29 high',
      'GET /metrics go-net-http internal/metrics/metrics.go:17 high',
    ])
  })

  it('finds net/http routes in a Go module of the monorepo fixture', async () => {
    const { routes } = await fixtureRoutes('monorepo')
    expect(find(routes, 'ANY', '/invoices')).toMatchObject({
      framework: 'go-net-http',
      package: 'services/billing',
      file: 'services/billing/main.go',
      confidence: 'high',
    })
  })

  it('handles echo groups and typed parameters', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/labstack/echo/v4'),
      'main.go': [
        'package main',
        'import "github.com/labstack/echo/v4"',
        'func main() {',
        '\te := echo.New()',
        '\te.GET("/", home)',
        '\tadmin := e.Group("/admin")',
        '\tadmin.POST("/users/:id", h)',
        '\tregister(e)',
        '}',
        'func register(app *echo.Echo) {',
        '\tapp.Any("/any", h)',
        '}',
        'func group(g *echo.Group) {',
        '\tg.DELETE("/x", h)',
        '}',
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.framework} ${r.confidence}`)).toEqual([
      'GET / echo high',
      'POST /admin/users/:id echo high',
      'ANY /any echo high',
      'DELETE /x echo medium',
    ])
    expect(find(routes, 'DELETE', '/x')?.note).toBe('registered on a router group; a prefix may apply')
  })

  it('handles chi Route closures, Mount of sub-routers and method patterns', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/go-chi/chi/v5'),
      'cmd/server/main.go': [
        'package main',
        'import (',
        '\t"net/http"',
        '\t"github.com/go-chi/chi/v5"',
        ')',
        'func main() {',
        '\tr := chi.NewRouter()',
        '\tr.Get("/", home)',
        '\tr.Route("/articles", func(r chi.Router) {',
        '\t\tr.Get("/", list)',
        '\t\tr.Route("/{articleID}", func(r chi.Router) {',
        '\t\t\tr.Put("/", update)',
        '\t\t})',
        '\t})',
        '\tr.Mount("/admin", adminRouter())',
        '\tr.With(auth).Post("/login", login)',
        '\tr.Method(http.MethodPatch, "/method", h)',
        '\thttp.ListenAndServe(":3000", r)',
        '}',
      ].join('\n'),
      'cmd/server/admin.go': [
        'package main',
        'import "github.com/go-chi/chi/v5"',
        'func adminRouter() chi.Router {',
        '\tr := chi.NewRouter()',
        '\tr.Get("/stats", stats)',
        '\treturn r',
        '}',
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'GET / high',
      'GET /admin/stats high',
      'GET /articles high',
      'PUT /articles/:articleID high',
      'POST /login high',
      'PATCH /method high',
    ])
    expect(routes.every((r) => r.framework === 'chi')).toBe(true)
  })

  it('handles fiber groups and gorilla/mux Methods and subrouters', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/gofiber/fiber/v2', 'github.com/gorilla/mux'),
      'fiber.go': [
        'package main',
        'import "github.com/gofiber/fiber/v2"',
        'func fiberApp() {',
        '\tapp := fiber.New()',
        '\tapi := app.Group("/api")',
        '\tv1 := api.Group("/v1")',
        '\tv1.Get("/list", h)',
        '\tapp.All("/proxy/*", h)',
        '}',
      ].join('\n'),
      'mux.go': [
        'package main',
        'import (',
        '\t"net/http"',
        '\t"github.com/gorilla/mux"',
        ')',
        'func muxApp() {',
        '\tr := mux.NewRouter()',
        '\tr.HandleFunc("/products/{key}", h).Methods("GET", http.MethodPost)',
        '\ts := r.PathPrefix("/shop").Subrouter()',
        '\ts.HandleFunc("/cart", h)',
        '}',
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.framework}`)).toEqual([
      'GET /api/v1/list fiber',
      'GET /products/:key gorilla-mux',
      'POST /products/:key gorilla-mux',
      'ANY /proxy/* fiber',
      'ANY /shop/cart gorilla-mux',
    ])
  })

  it('accepts empty and relative paths on gin, echo and fiber groups only', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/gin-gonic/gin', 'github.com/labstack/echo/v4', 'github.com/go-chi/chi/v5'),
      'gin.go': [
        'package main',
        'import "github.com/gin-gonic/gin"',
        'func ginApp() {',
        '\tr := gin.New()',
        '\tusers := r.Group("/users")',
        '\tusers.GET("", list)',
        '\tusers.GET("active", active)',
        '\tr.Group("/inline").POST("", create)',
        '\tr.GET("engine-relative", h)',
        '}',
        'func register(g *gin.RouterGroup) {',
        '\tg.DELETE("", remove)',
        '}',
      ].join('\n'),
      'echo.go': [
        'package main',
        'import "github.com/labstack/echo/v4"',
        'func echoApp() {',
        '\te := echo.New()',
        '\tadmin := e.Group("/admin")',
        '\tadmin.GET("stats", h)',
        '}',
      ].join('\n'),
      'chi.go': [
        'package main',
        'import "github.com/go-chi/chi/v5"',
        'func chiApp() {',
        '\tr := chi.NewRouter()',
        '\tsub := r.With(auth)',
        '\tsub.Get("relative", h)',
        '}',
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.framework} ${r.confidence}`)).toEqual([
      'DELETE / gin medium',
      'GET /admin/stats echo high',
      'POST /inline gin high',
      'GET /users gin high',
      'GET /users/active gin high',
    ])
  })

  it('mounts routes registered by functions that receive a router (golang-gin-realworld layout)', async () => {
    const { routes } = await routesOf({
      'go.mod': 'module github.com/acme/realworld\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n',
      'hello.go': [
        'package main',
        'import (',
        '\t"github.com/gin-gonic/gin"',
        '\t"github.com/acme/realworld/articles"',
        '\t"github.com/acme/realworld/users"',
        ')',
        'func main() {',
        '\tr := gin.Default()',
        '\tv1 := r.Group("/api")',
        '\tusers.UsersRegister(v1.Group("/users"))',
        '\tv1.Use(users.AuthMiddleware(false))',
        '\tarticles.ArticlesAnonymousRegister(v1.Group("/articles"))',
        '\tarticles.TagsAnonymousRegister(v1.Group("/tags"))',
        '\tregisterHealth(r, v1)',
        '\tr.Run()',
        '}',
      ].join('\n'),
      'health.go': [
        'package main',
        'import "github.com/gin-gonic/gin"',
        'func registerHealth(engine *gin.Engine, api *gin.RouterGroup) {',
        '\tengine.GET("/healthz", h)',
        '\tapi.GET("/health", h)',
        '}',
      ].join('\n'),
      'users/routers.go': [
        'package users',
        'import "github.com/gin-gonic/gin"',
        'func UsersRegister(router *gin.RouterGroup) {',
        '\trouter.POST("/", UsersRegistration)',
        '\trouter.POST("/login", UsersLogin)',
        '}',
      ].join('\n'),
      'articles/routers.go': [
        'package articles',
        'import "github.com/gin-gonic/gin"',
        'func ArticlesAnonymousRegister(router *gin.RouterGroup) {',
        '\trouter.GET("/", ArticleList)',
        '\trouter.GET("/:slug", ArticleRetrieve)',
        '}',
        'func TagsAnonymousRegister(router *gin.RouterGroup) {',
        '\trouter.GET("/", TagList)',
        '}',
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.file}:${r.line} ${r.confidence}`)).toEqual([
      'GET /api/articles articles/routers.go:4 high',
      'GET /api/articles/:slug articles/routers.go:5 high',
      'GET /api/health health.go:5 high',
      'GET /api/tags articles/routers.go:8 high',
      'POST /api/users users/routers.go:4 high',
      'POST /api/users/login users/routers.go:5 high',
      'GET /healthz health.go:4 high',
    ])
  })

  it('resolves functions that pass groups to each other recursively', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/gin-gonic/gin'),
      'main.go': [
        'package main',
        'import "github.com/gin-gonic/gin"',
        'func main() {',
        '\tr := gin.New()',
        '\tF(r.Group("/root"))',
        '}',
        'func F(r *gin.RouterGroup) {',
        '\tG(r.Group("/b"))',
        '\tr.GET("/x", h)',
        '}',
        'func G(r *gin.RouterGroup) {',
        '\tF(r.Group("/c"))',
        '\tr.GET("/y", h)',
        '}',
      ].join('\n'),
    })
    const high = routes.filter((r) => r.confidence === 'high').map((r) => `${r.method} ${r.path}`)
    expect(high).toEqual(['GET /root/b/y', 'GET /root/x'])
  })

  it('keeps unresolved routes of different functions apart', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/gin-gonic/gin'),
      'articles/routers.go': [
        'package articles',
        'import "github.com/gin-gonic/gin"',
        'func ArticlesAnonymousRegister(router *gin.RouterGroup) {',
        '\trouter.GET("/", ArticleList)',
        '}',
        'func TagsAnonymousRegister(router *gin.RouterGroup) {',
        '\trouter.GET("/", TagList)',
        '}',
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.line} ${r.confidence}`)).toEqual([
      'GET / 4 medium',
      'GET / 7 medium',
    ])
  })

  it('only mounts through router parameters, by position', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/labstack/echo/v4'),
      'main.go': [
        'package main',
        'import "github.com/labstack/echo/v4"',
        'func main() {',
        '\te := echo.New()',
        '\tsetup(db, e.Group("/v1"), e.Group("/admin"))',
        '\tunrelated(e.Group("/ignored"))',
        '}',
        'func setup(db *sql.DB, api *echo.Group, admin *echo.Group) {',
        '\tapi.GET("/items", h)',
        '\tadmin.GET("/stats", h)',
        '}',
        'func unrelated(name string) {}',
      ].join('\n'),
    })
    expect(routes.map((r) => `${r.method} ${r.path} ${r.confidence}`)).toEqual([
      'GET /admin/stats high',
      'GET /v1/items high',
    ])
  })

  it('only uses frameworks the module requires and skips tests, comments and dynamic paths', async () => {
    const { routes } = await routesOf({
      'go.mod': goMod('github.com/google/uuid'),
      'main.go': [
        'package main',
        'import (',
        '\t"net/http"',
        '\t"github.com/gin-gonic/gin"',
        ')',
        'func main() {',
        '\tr := gin.Default()',
        '\tr.GET("/gin-not-required", h)',
        '\t// http.HandleFunc("/commented", h)',
        '\thttp.HandleFunc("/prefix"+name, h)',
        '\thttp.Handle("/static/", fs)',
        '\tresp, _ := http.Get("http://example.com/x")',
        '}',
      ].join('\n'),
      'main_test.go': 'package main\nimport "net/http"\nfunc TestX() { http.HandleFunc("/test-only", h) }\n',
      'testdata/fixture.go': 'package fixture\nimport "net/http"\nfunc x() { http.HandleFunc("/testdata", h) }\n',
    })
    expect(summary(routes)).toEqual(['ANY /static'])
  })

  it('ignores Go files outside any module', async () => {
    const { routes } = await routesOf({
      'main.go': 'package main\nimport "net/http"\nfunc main() { http.HandleFunc("/x", h) }\n',
    })
    expect(routes).toEqual([])
  })
})
