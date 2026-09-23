/** Homebrew formula for RepoLens, installed from the npm tarball (the standard pattern for Node CLIs). */

export const PACKAGE_NAME = 'repolens-cli'
export const HOMEPAGE = 'https://github.com/Douglas-Strey/repolens-cli'

export interface FormulaInput {
  version: string
  /** SHA-256 of the npm tarball, hex. */
  sha256: string
}

export function tarballUrl(version: string): string {
  return `https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${version}.tgz`
}

export function renderFormula({ version, sha256 }: FormulaInput): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid version: ${version}`)
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid sha256: ${sha256}`)
  return `class Repolens < Formula
  desc "Understand a repository's stack, services, env vars and setup problems"
  homepage "${HOMEPAGE}"
  url "${tarballUrl(version)}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/repolens --version")

    (testpath/"package.json").write <<~JSON
      { "name": "brew-test", "packageManager": "pnpm@10.17.1", "scripts": { "dev": "vite" } }
    JSON
    output = shell_output("#{bin}/repolens --json #{testpath}")
    assert_match '"name": "brew-test"', output
    assert_match '"run": "pnpm dev"', output
  end
end
`
}
