/**
 * Locale-independent string comparison (UTF-16 code units). Every sort in
 * RepoLens uses this instead of localeCompare so output is identical on every
 * machine, whatever its locale (in Danish collation "aa" sorts after "z").
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
