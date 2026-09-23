import { routesDetector } from '../../../src/detectors/routes/index.ts'
import type { Route, RoutesSection, ScanOptions } from '../../../src/types.ts'
import { contextFor, fixtureContext, makeProject } from '../../helpers.ts'

/** Run only the routes detector on an inline project. */
export async function routesOf(files: Record<string, string>, options: ScanOptions = {}): Promise<RoutesSection> {
  const ctx = await contextFor(await makeProject(files), options)
  return ctx.use(routesDetector)
}

/** Run only the routes detector on a fixture copy. */
export async function fixtureRoutes(name: string): Promise<RoutesSection> {
  const ctx = await fixtureContext(name)
  return ctx.use(routesDetector)
}

/** Compact "METHOD path" list for readable assertions. */
export function summary(routes: readonly Route[]): string[] {
  return routes.map((route) => `${route.method} ${route.path}`)
}

/** Find a route by method and path. */
export function find(routes: readonly Route[], method: string, path: string): Route | undefined {
  return routes.find((route) => route.method === method && route.path === path)
}
