# Saída JSON

[English](../json-schema.md) | **Português (Brasil)**

`repolens --json` imprime um documento JSON que descreve o repositório. Ele foi pensado
para ser consumido por scripts, jobs de CI, dashboards e agentes de IA.

```sh
repolens --json | jq '.frameworks[].name'
repolens --json | jq '.environment.variables[] | select(.used and (.documented | not)) | .name'
repolens doctor --json | jq '.diagnostics[].code'
```

## Estabilidade

- Todo documento começa com `"schemaVersion": 1`.
- Dentro de uma versão do schema, campos são **apenas adicionados**, nunca removidos,
  renomeados ou alterados no significado. Quem consome a saída deve ignorar os campos que
  não conhece.
- Uma mudança incompatível incrementa `schemaVersion`, e as notas de release vão avisar.
- Os `code`s de diagnóstico são identificadores estáveis e nunca são renomeados.
- As definições TypeScript em [`src/types.ts`](../../src/types.ts) são a fonte da verdade
  e são exportadas pelo pacote (`import type { ScanResult } from 'repolens-cli'`).

## Garantias

- **Nenhum valor de segredo.** Variáveis de ambiente aparecem só pelo nome, com
  indicadores booleanos. Valores em formato de URL são reduzidos a `{ scheme, port, local }`.
- **Nenhum caminho absoluto.** Todos os caminhos são relativos ao diretório analisado, com
  separadores `/` em qualquer sistema operacional. `"."` significa a raiz.
- **Determinística.** Sem timestamps, e os arrays são ordenados, então a mesma entrada
  produz a mesma saída. Coleções são ordenadas pela chave natural (nome ou caminho),
  achados por confiança e depois por nome, rotas por pacote, tipo, caminho e método. Listas
  que espelham um arquivo (portas do Compose, jobs de CI, scripts do package.json) mantêm a
  ordem do arquivo.
- Achados de baixa confiança são omitidos, a menos que você passe `--verbose`. Todo achado
  que pode ser incerto traz um `confidence` (`"high"`, `"medium"`, `"low"`) e `evidence`.

## Estrutura de nível superior

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "repolens", "version": "0.1.0" },
  "project": { … },          // name, type, license, manifests, entrypoints, structure
  "languages": [ … ],        // { name, kind, files, share }
  "runtimes": [ … ],         // Node.js, Go, Bun, Deno com todas as fontes de versão
  "packageManagers": { … },  // principal + detectados, lockfiles, declarações
  "workspace": { … } | null, // ferramentas de monorepo, padrões, pacotes
  "dependencies": { … },     // dependências diretas por pacote
  "frameworks": [ … ],
  "build": { "tools": [ … ] },
  "testing": { "tools": [ … ], "testFiles": 23 },
  "linting": { "tools": [ … ] },
  "scripts": { "runner": "pnpm", "scripts": [ … ] },
  "environment": { "files": [ … ], "variables": [ … ], "usageTruncated": false },
  "services": { "composeFiles": [ … ], "services": [ … ], "dockerfiles": [ … ] },
  "databases": { "databases": [ … ], "orms": [ … ] },
  "routes": { "routes": [ … ], "truncated": false },
  "ci": { "providers": [ … ], "workflows": [ … ] },
  "git": { … } | null,
  "configFiles": [ … ],
  "doctor": { "checks": [ … ], "diagnostics": [ … ], "summary": { … } },
  "meta": { "files": 162, "truncated": false, "warnings": [ … ], "config": { … } }
}
```

## Seções

### `project`

| Campo | Tipo | Observações |
| --- | --- | --- |
| `name` | string | Nome do `package.json`, nome do módulo Go ou o nome do diretório. |
| `directory` | string | Nome do diretório analisado (nunca um caminho completo). |
| `description`, `version`, `license`, `homepage`, `repository` | string? | Vêm do `package.json` (a licença também pode vir de um arquivo `LICENSE` reconhecido; a URL do repositório tem as credenciais removidas). |
| `type` | `"monorepo" \| "application" \| "library" \| "cli" \| "unknown"` | |
| `private` | boolean? | |
| `manifests` | string[] | Manifestos encontrados na raiz: `package.json`, `go.mod`, `pyproject.toml`, … |
| `entrypoints` | `{ kind: "go-main" \| "bin", path, name? }[]` | Pacotes `main` do Go e comandos `bin`. |
| `structure` | `{ path, files }[]` | Diretórios de primeiro nível por quantidade de arquivos indexados (no máximo 15). |

### `languages[]`

`{ "name": "TypeScript", "kind": "programming" | "markup" | "style", "files": 96, "share": 0.738 }`.
`share` é a fração dos arquivos contados; a lista é ordenada por `files` em ordem
decrescente. Arquivos de dados e de documentação (JSON, YAML, Markdown) não são contados.

### `runtimes[]`

```json
{
  "id": "node",
  "name": "Node.js",
  "version": "22",
  "sources": [
    { "file": ".nvmrc", "raw": "22", "version": "22", "kind": "exact" },
    { "file": "package.json", "field": "engines.node", "raw": ">=22", "version": ">=22", "kind": "range" },
    { "file": "Dockerfile", "field": "FROM", "raw": "node:20-alpine", "version": "20", "kind": "exact" }
  ]
}
```

`kind` é `exact` (uma versão fixada, possivelmente parcial, como `22`), `range` (um
intervalo semver) ou `alias` (`lts/*`, `node:lts`; `version` é `null` quando o alias não
pode ser resolvido estaticamente). O `version` do nível superior é o valor a ser exibido.

### `packageManagers`

`primary` é o gerenciador de pacotes a usar nos scripts (`null` se não houver nenhum).
`detected` lista tudo o que foi encontrado: `{ id, name, version?, lockfiles[], declared, guessed?, installFrom?, evidence[] }`:

- `declared`: o campo `packageManager` ou `devEngines` indica esse gerenciador.
- `guessed`: nada foi decisivo (nenhuma declaração, nenhum lockfile inequívoco), então
  trate como um palpite.
- `installFrom`: quando você analisou um pacote dentro de um repositório maior, o
  diretório (relativo à raiz do repositório, `""` para a raiz) a partir do qual as
  dependências precisam ser instaladas.

### `workspace`

`null` em repositórios de pacote único.
`{ tools: [{ id, name, configFile }], patterns: string[], packages: [{ name, path, version?, private?, ecosystem }] }`.

### `dependencies`

`{ packages: [{ path, name, ecosystem, dependencies: [{ name, version, kind }] }], total }`, onde
`kind` é `prod`, `dev`, `peer`, `optional` ou `indirect` (Go). `total` conta nomes únicos,
sem contar os indiretos.

### `frameworks[]`, `build.tools[]`, `testing.tools[]`, `linting.tools[]`, `databases.orms[]`

Frameworks: `{ id, name, version?, category, ecosystem, packages[], confidence, evidence[] }`.
Quando os pacotes usam versões major diferentes, `version` é um resumo do intervalo, como
`"18.3.1–19.1.0"`, e `evidence` lista a declaração de cada pacote.
Ferramentas: `{ id, name, kind, version?, configFiles[], packages[], confidence, evidence[] }`.
`packages` lista os diretórios de pacote onde a ferramenta foi encontrada.

### `scripts`

`{ runner, scripts: [{ name, command, run, source, package?, category }] }`: `run` é o que
você digita (`pnpm dev`, `make test`), `command` é o corpo do script com segredos inline
mascarados, e `category` é um destes: `dev`, `start`, `build`, `test`, `lint`, `format`,
`typecheck`, `database`, `deploy`, `release`, `setup`, `other`.

### `environment`

```json
{
  "files": [{ "path": ".env", "kind": "local", "variables": 3, "ignored": true, "tracked": false }],
  "variables": [
    {
      "name": "DATABASE_URL",
      "defined": true,
      "documented": true,
      "used": true,
      "definedIn": [".env"],
      "documentedIn": [".env.example"],
      "usedIn": ["src/db.ts"],
      "fallback": false,
      "testOnly": false,
      "public": false,
      "sensitive": false,
      "endpoints": [{ "file": ".env.example", "scheme": "postgres", "port": 5432, "local": true }],
      "suspiciousValueIn": []
    }
  ],
  "usageTruncated": false
}
```

`files[].kind` diz para que serve um arquivo env:

| Tipo | Arquivos | Significado |
| --- | --- | --- |
| `local` | `.env`, `.env.local`, `.env.*.local`, `local.env`, `.envrc` | Valores de um único desenvolvedor, que nunca devem ser commitados. |
| `mode` | `.env.development`, `.env.production`, `.env.test`, `.env.staging`, `.env.ci`, `prod.env`, … | Arquivos de modo do framework, muitas vezes commitados de propósito com valores padrão que não são segredos. |
| `service` | Arquivos que um serviço do Compose carrega com `env_file` e que não se encaixam em nenhum dos anteriores (`.env.db`) | Valores para um único container. |
| `example` | `.env.example`, `.env.sample`, `.env.template`, `.env.dist`, `env.example`, … | Templates de documentação. |
| `other` | Qualquer outro, como um `.env.vault` criptografado ou um `.env.backup` | Aparece na lista, mas suas variáveis não são reportadas. |

`files[].variables` conta só atribuições ativas; linhas comentadas não contam.

- `defined`: definida em um arquivo que guarda valores (`local`, `mode` ou `service`).
- `documented`: listada em um arquivo de exemplo. Entradas comentadas contam
  (`# SENTRY_DSN=` documenta o nome sem definir a variável).
- `used`: referenciada em código ou configuração (`process.env.X`, `import.meta.env.X`,
  `os.Getenv("X")`, `env("X")` do Prisma, `${X}` do Compose, placeholders `%X%` no
  `index.html` de um projeto Vite ou Create React App, bibliotecas de schema como zod, Joi,
  envalid e t3-env, …). Comentários são ignorados.
- `usedIn`: até cinco arquivos que referenciam a variável.
- `fallback`: toda referência fornece um valor padrão (`process.env.PORT ?? 3000`, um
  default do schema), então a variável é opcional.
- `testOnly`: só testes a referenciam (arquivos de teste, diretórios de teste, configs de
  test runner).
- `public`: exposta aos bundles do navegador por causa do prefixo (`NEXT_PUBLIC_`, `VITE_`,
  `NUXT_PUBLIC_`, `PUBLIC_`, `EXPO_PUBLIC_`, `REACT_APP_`, `VUE_APP_`, …).
- `sensitive`: o nome parece ser de um segredo.
- `endpoints`: valores em formato de URL reduzidos a scheme, porta e se o host é local.
  O valor em si nunca é incluído.
- `suspiciousValueIn`: arquivos de exemplo cujo valor para esta variável parece uma
  credencial real. Só os caminhos dos arquivos são incluídos.
- `ignored` é `null` quando o RepoLens não consegue determinar, e `tracked` é `null` fora
  de um repositório Git.

### `services`

Serviços do Compose: `{ name, source, image?, build?, dockerfile?, technology?: { id, name }, kind, ports: [{ host, container, protocol, hostIp?, raw }], expose[], dependsOn[], volumes[], environment[] (só nomes), envFiles[], profiles[], healthcheck }`.
Serviços com o mesmo nome em arquivos Compose do mesmo diretório (arquivo base mais
overrides) são mesclados. `dockerfiles`: `{ path, baseImages[], stages, exposes[], args[] }`
(só os nomes dos `ARG`).

### `databases`

`{ databases: [{ id, name, kind, sources: ("dependency" | "docker" | "env" | "config")[], confidence, evidence[] }], orms: Tool[] }`.

### `routes`

`{ routes: [{ method, path, kind: "api" | "page", framework, file, line?, confidence, package?, note? }], truncated }`.
Os caminhos usam `:param` para parâmetros e `*name` para catch-alls. `note` explica uma
confiança menor ou um detalhe, por exemplo "prefix may apply" (um router montado sob um
prefixo que não pode ser resolvido estaticamente), "optional parameter", "nested route
parent" ou um valor de `next.config`/`nuxt.config` que não é literal. `truncated` é `true`
quando a análise de rotas parou no limite de arquivos ou quando a resolução de prefixos
esgotou seu orçamento de trabalho.

### `ci`

`{ providers: [{ id, name, files[] }], workflows: [{ provider, file, name?, triggers[], jobs: [{ id, name?, tasks[], runsOn[] }] }] }`,
onde `tasks` é inferido a partir de nomes de jobs, comandos e actions: `lint`, `format`,
`typecheck`, `test`, `e2e`, `build`, `deploy`, `release`, `security`, `docs`.

### `git`

`null` fora de um repositório Git.
`{ branch, head, remotes: [{ name, url, host? }], submodules[], lfs, trackedFiles, linkedWorktree }`.
Lido diretamente de `.git`; URLs de remotes nunca incluem credenciais.

### `configFiles[]`

`{ path, category, description }` para arquivos de configuração reconhecidos.

### `doctor`

```json
{
  "checks": [
    {
      "code": "MULTIPLE_LOCKFILES",
      "title": "Only one package manager lockfile is committed",
      "category": "package-manager",
      "status": "failed"
    }
  ],
  "diagnostics": [
    {
      "code": "MULTIPLE_LOCKFILES",
      "severity": "warning",
      "category": "package-manager",
      "message": "Found lockfiles for npm and pnpm: package-lock.json and pnpm-lock.yaml",
      "hint": "Delete package-lock.json and keep pnpm-lock.yaml, since package.json declares pnpm",
      "files": ["package-lock.json", "pnpm-lock.yaml"],
      "subject": "lockfiles"
    }
  ],
  "summary": { "passed": 10, "failed": 5, "skipped": 19, "disabled": 0, "errors": 0, "warnings": 7, "infos": 0 }
}
```

`status` é `passed`, `failed`, `skipped` quando uma verificação não se aplica ao
repositório (por exemplo, verificações de Docker quando não há arquivos Compose) ou
`disabled` quando um [arquivo de configuração](configuration.md) a desativou. Uma
severidade definida em `doctor.rules` substitui a severidade de todo diagnóstico que essa
verificação reporta. Veja todos os códigos em [diagnostics.md](diagnostics.md).

### `meta`

`{ files, truncated, warnings: [{ kind, file?, message, detail? }], config }`: o número de
arquivos indexados, se a indexação parou no limite de arquivos, problemas não fatais e a
configuração que foi aplicada.

`kind` é `"parse"` (não foi possível fazer o parse de um arquivo), `"size"` (um arquivo
foi ignorado por ser grande demais), `"limit"` (um limite da análise foi atingido),
`"error"` (um detector ou uma verificação falhou) ou `"config"` (um arquivo de
configuração tem uma opção que o RepoLens ignorou). `detail` traz a mensagem do parser;
ela nunca cita o conteúdo de arquivos nem caminhos absolutos.

`config` lista os [arquivos de configuração](configuration.md) que foram aplicados,
começando pelo de menor precedência, e as opções resultantes da mesclagem:

```json
{
  "sources": [{ "kind": "user" }, { "kind": "project", "file": "repolens.config.json" }],
  "settings": { "ignore": ["legacy/"], "doctor": { "rules": { "ENV_UNUSED": "off" } } }
}
```

`kind` é `"user"` (a sua configuração do usuário), `"project"` (o `repolens.config.json`
do diretório analisado ou a chave `"repolens"` do `package.json` dele) ou `"file"` (um
arquivo passado com `--config`). `file` é relativo ao diretório analisado e fica ausente
para arquivos fora dele. `sources` fica vazio quando nenhuma configuração foi aplicada.

## `repolens doctor --json`

Um documento menor, só com os resultados do doctor:

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "repolens", "version": "0.1.0" },
  "project": { "name": "acme-api", "directory": "acme-api" },
  "checks": [ … ],
  "diagnostics": [ … ],
  "summary": { … },
  "config": { "sources": [ … ], "settings": { … } }
}
```
