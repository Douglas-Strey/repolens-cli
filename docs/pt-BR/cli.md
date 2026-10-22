# Referência da CLI

[English](../cli.md) | **Português (Brasil)**

```
repolens [path] [options]          Scan a repository (default command)
repolens scan [path] [options]     Same as above
repolens doctor [path] [options]   Check for setup problems and inconsistencies
repolens report [path] [options]   Generate a Markdown report
repolens setup [path] [options]    Set up the project: env file, services, dependencies
repolens agent [init] [path] [options]  Generate context for coding agents (experimental)
repolens config [path] [options]   Show the configuration files and settings in effect
repolens mcp [path] [options]      Serve the scan to AI assistants over MCP (stdio)
repolens help [command]            Show help for a command
```

Por padrão, `path` é o diretório atual. Você também pode passá-lo com `--cwd`/`-C`, mas não
os dois ao mesmo tempo. Um comando digitado errado é detectado em vez de ser tratado como
caminho: `repolens doktor` imprime `Unknown command "doktor". Did you mean "doctor"?`.

## Opções globais

| Opção | Descrição |
| --- | --- |
| `-C, --cwd <path>` | Diretório a analisar. |
| `--json` | Imprime JSON legível por máquina (veja [Saída JSON](json-schema.md)). |
| `--markdown` | Imprime o relatório em Markdown em vez da visualização do terminal. |
| `-o, --output <file>` | Grava a saída em um arquivo em vez de stdout. Os arquivos são gravados sem cores, com largura fixa de 100 colunas, e nunca através de um link simbólico que leve para fora do diretório analisado. |
| `-q, --quiet` | Imprime só o que precisa de atenção. |
| `-v, --verbose` | Mostra achados de baixa confiança, as evidências de cada detecção, todas as variáveis, rotas e scripts, e detalhes técnicos como erros de parser. |
| `--no-color` | Desativa as cores. `NO_COLOR` também é respeitada. |
| `--color` | Força as cores mesmo quando stdout não é um terminal. |
| `--max-files <n>` | Para de indexar depois de `n` arquivos (padrão 100.000, ou `maxFiles` de um [arquivo de configuração](configuration.md)). |
| `--config <file>` | Usa este [arquivo de configuração](configuration.md) em vez do `repolens.config.json` do projeto. A sua configuração do usuário continua valendo. |
| `--no-config` | Ignora todos os arquivos de configuração, os seus e os do projeto. |
| `-V, --version` | Imprime a versão. |
| `-h, --help` | Mostra a ajuda. `repolens <command> --help` mostra a ajuda do comando. |

Opções que só fazem sentido para um comando são rejeitadas nos outros (código de saída 2)
em vez de serem ignoradas em silêncio: `--fail-on`/`--strict` só valem para `doctor`,
`--force` só para `agent init`, e `--quiet` não pode ser combinada com `--verbose`.
`report` sempre gera Markdown (use `repolens --json` para JSON), `doctor` imprime a
própria visualização ou `--json`, e `agent` imprime Markdown.

## `repolens` / `repolens scan`

Imprime uma visão geral do repositório: tipo de projeto, linguagens, gerenciador de
pacotes, runtimes, frameworks, pacotes do workspace, uma sugestão de início rápido,
serviços Docker, bancos de dados, variáveis de ambiente, scripts, rotas, CI, ferramentas e
possíveis problemas.

Uma análise concluída **sempre sai com código 0**, mesmo que encontre problemas, então
incluí-la em um log de CI nunca quebra um build. Use `doctor` para fazer builds falharem.

```sh
repolens                           # o diretório atual
repolens ../another-project        # outro diretório
repolens --json > repolens.json    # legível por máquina
repolens --markdown -o REPOLENS.md # relatório em Markdown em um arquivo
repolens -v                        # inclui achados de baixa confiança e evidências
```

## `repolens doctor`

Roda todas as verificações e imprime os resultados agrupados por categoria, com uma
correção sugerida para cada achado. Todo achado tem um código estável, como
`ENV_UNDOCUMENTED` ou `MULTIPLE_LOCKFILES`; veja a [lista de diagnósticos](diagnostics.md).

| Opção | Descrição |
| --- | --- |
| `--fail-on <level>` | Sai com código 1 quando um achado tem pelo menos esta severidade: `error` (padrão, ou `doctor.failOn` de um [arquivo de configuração](configuration.md)), `warning`, `info` ou `never`. |
| `--strict` | Atalho para `--fail-on warning`. |
| `--online` | Também consulta as versões exatas dos seus lockfiles no [OSV.dev](https://osv.dev) (`DEPENDENCY_VULNERABLE`). A única opção que usa a rede: envia nomes e versões de pacotes, mais nada ([segurança](security.md#8-a-rede-só-é-usada-com-o-repolens-doctor---online)). |
| `--json` | Imprime as verificações e os diagnósticos como JSON. |
| `-q, --quiet` | Oculta as categorias que passaram e as dicas. |

```sh
repolens doctor                   # falha (código 1) só com erros
repolens doctor --strict          # também falha com avisos
repolens doctor --online          # também verifica as dependências no OSV.dev
repolens doctor --json | jq '.diagnostics[] | select(.code == "ENV_UNDOCUMENTED")'
```

### No CI

```yaml
# .github/workflows/repolens.yml
name: RepoLens
on: [pull_request]
permissions:
  contents: read
jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npx --yes @douglas-strey/repolens doctor --fail-on error
```

## `repolens report`

Gera um relatório em Markdown para onboarding, auditorias técnicas, documentação ou para
entregar a um assistente de IA.

```sh
repolens report                     # imprime em stdout
repolens report --output repolens.md
repolens report --verbose           # inclui achados de baixa confiança
```

## `repolens setup`

Prepara um projeto que você acabou de clonar: cria o arquivo de env local a partir do
exemplo, sobe os serviços de apoio com o Docker Compose e instala as dependências. São os
passos do início rápido, executados para você.

```sh
repolens setup                    # mostra o plano, pergunta e depois executa
repolens setup --dry-run          # mostra o plano e para
repolens setup --yes              # executa o plano sem perguntar (CI, scripts)
repolens setup --ignore-scripts   # instala sem scripts de ciclo de vida
```

O setup é o único comando que executa alguma coisa, então ele mostra o plano antes:

```
Setup plan for web

  1. cp .env.example .env     create your local environment file
     · Then fill in your own values: the file starts as a copy of .env.example.
  2. docker compose up -d db  start the backing services
     · Pulls images if needed: postgres:17
  3. pnpm install             install dependencies
     · Runs these scripts from the repository:
       postinstall (package.json): node scripts/setup.js
     · Dependencies may run install scripts too; --ignore-scripts skips them all.

Run these 3 steps? [y/N]
```

- **Ele executa só o que o plano mostra.** Cada passo é um comando que o próprio RepoLens
  monta: copiar o arquivo de env de exemplo, `docker compose up -d` e o `install` do
  gerenciador de pacotes (`npm`, `pnpm`, Yarn, Bun) ou `go mod download`. Scripts do
  projeto, como `make setup` ou `pnpm db:up`, aparecem em "Skipped" para você rodar.
- **Ele diz o que mais vai rodar.** Instalar roda os scripts de ciclo de vida do projeto
  (`preinstall`, `postinstall`, `prepare`, …) e os das dependências, então o plano lista os
  do projeto; `--ignore-scripts` pula todos. Os passos do Compose listam as imagens que
  baixam ou constroem.
- **Ele pergunta antes.** Sem um terminal para perguntar, o setup se recusa a rodar, a
  menos que você passe `--yes`.
- **Ele nunca mexe nos seus valores.** O arquivo de env só é criado quando não existe (com
  permissão só para o dono no macOS e no Linux), e nunca é sobrescrito nem preenchido.
- **Ele confere o Node.js antes.** Quando o `node` ativo está fora do `engines.node`, nada
  roda. Uma versão diferente da fixada no `.nvmrc` (ou `.node-version`, `.tool-versions`,
  mise) é apontada, não imposta.
- **Ele para no primeiro passo que falhar.** Rode de novo depois de corrigir: um arquivo de
  env existente é preservado e instalar de novo não faz mal.

Ao terminar, o setup analisa o projeto de novo e diz se o `repolens doctor` ainda encontra
problemas e como iniciar o projeto. Veja em
[segurança](security.md#7-o-repolens-setup-executa-só-o-que-mostra-para-você) como os
programas são encontrados e executados.

## `repolens agent` (experimental)

Gera um contexto curto e estruturado sobre o repositório para agentes de programação
(Claude Code, Codex, Cursor, Copilot e outros). Não é um dump do repositório: ele lista os
comandos a rodar, as convenções que o RepoLens consegue sustentar com evidências
(gerenciador de pacotes, versões de runtime, verificações do CI), a estrutura, os
serviços, os nomes das variáveis de ambiente e os problemas conhecidos.

```sh
repolens agent                    # imprime agent-context.md em stdout
repolens agent -o context.md      # grava em um arquivo
repolens agent -o docs/           # um diretório existente: grava docs/agent-context.md
repolens agent init               # grava .repolens/*.md no projeto
repolens agent init -o docs/agents
repolens agent init --force       # sobrescreve arquivos que não foram gerados pelo RepoLens
```

Com `init`, `-o` indica o diretório de todos os arquivos; sem ele, `-o` indica o arquivo
do `agent-context.md` (ou um diretório onde colocá-lo).

`agent init` grava `overview.md`, `architecture.md`, `commands.md`, `environment.md`,
`services.md`, `routes.md`, `development.md` e `agent-context.md`. Arquivos que o RepoLens
gerou antes são regenerados no lugar. Arquivos existentes que o RepoLens não gerou nunca
são sobrescritos, a menos que você passe `--force`.

Para usar, aponte para ele no arquivo de instruções do seu agente, por exemplo em
`AGENTS.md` ou `CLAUDE.md`:

```md
Project context (generated): see .repolens/agent-context.md
```

Revise os arquivos gerados antes de fazer o commit deles. Eles nunca contêm valores de
segredos, mas descrevem o seu projeto.

## `repolens config`

Mostra quais [arquivos de configuração](configuration.md) se aplicam a um diretório, quais
deles existem e as configurações em vigor depois de combiná-los. Use para descobrir onde
fica a sua configuração do usuário ou para conferir o que o `repolens.config.json` de um
repositório muda.

```sh
repolens config                   # o diretório atual
repolens config ../another-project
repolens config --json            # { files, settings, output }
```

Todo comando imprime problemas de configuração (uma configuração desconhecida, um código de
verificação que não existe) em stderr, para que nunca se misturem com a saída `--json`.

## `repolens mcp`

Roda um servidor [Model Context Protocol](https://modelcontextprotocol.io) pela entrada e
saída padrão, para que um assistente de IA possa perguntar sobre o projeto. O seu cliente
MCP o inicia; você não o roda à mão.

```sh
repolens mcp                  # the current directory, or $CLAUDE_PROJECT_DIR
repolens mcp ../my-project
repolens mcp --no-config      # ignore every config file
```

| Ferramenta | Responde com |
| --- | --- |
| `get_project_overview` | Visão geral, início rápido, arquitetura, linguagens, frameworks, CI, ferramentas e Git |
| `get_services` | Serviços do Docker Compose, Dockerfiles, bancos de dados e ORMs |
| `get_environment_variables` | Nomes das variáveis, onde cada uma é documentada ou definida, e quais são secretas |
| `get_routes` | Rotas de API e páginas |
| `get_scripts` | O início rápido, scripts do package.json, alvos de Makefile e justfile |
| `get_diagnostics` | Todo achado do `doctor`, com os arquivos e a correção sugerida |

Toda ferramenta aceita dois argumentos opcionais:

- `path`: um diretório dentro do projeto, relativo a ele (`apps/web`). Caminhos fora do
  projeto, e links que levam para fora dele, são recusados.
- `format`: `markdown` (o padrão, a parte correspondente do `repolens report`) ou `json` (a
  parte correspondente do `repolens --json`).

Cada chamada analisa os arquivos como estão, com os arquivos de configuração daquele
diretório, como `repolens <dir>`. Achados de baixa confiança ficam de fora, como na
visualização padrão do terminal. `--max-files`, `--config` e `--no-config` valem para todas
as chamadas.

Sem um caminho, o servidor usa o diretório atual, ou `$CLAUDE_PROJECT_DIR` quando ela está
definida: o Claude Code a define com a raiz do projeto porque não garante iniciar os
servidores lá.

O servidor fala a revisão 2026-07-28 do MCP, em que toda requisição carrega a sua versão, e
as revisões anteriores que começam com `initialize` (da 2025-11-25 até a 2024-11-05). Ele
implementa o protocolo por conta própria, sem o SDK do MCP e as dependências dele. A saída
padrão leva apenas mensagens do protocolo: avisos de configuração e a saída do
`REPOLENS_DEBUG` vão para stderr. O servidor para quando a entrada padrão é fechada.

Claude Code:

```sh
claude mcp add repolens -- npx -y @douglas-strey/repolens mcp
```

Codex:

```sh
codex mcp add repolens -- npx -y @douglas-strey/repolens mcp
```

ou no `~/.codex/config.toml` (ou no `.codex/config.toml` de um projeto confiável):

```toml
[mcp_servers.repolens]
command = "npx"
args = ["-y", "@douglas-strey/repolens", "mcp"]
startup_timeout_sec = 30
```

A primeira execução do `npx` baixa o RepoLens, o que pode levar mais que o tempo limite
padrão de 10 segundos do Codex para iniciar um servidor, daí o `startup_timeout_sec`. Com o
RepoLens instalado, use `command = "repolens"` e `args = ["mcp"]`. O Codex não informa aos
servidores onde fica o projeto: se ele os iniciar em outro lugar, passe o projeto como
argumento ou defina `cwd`.

Cursor (`.cursor/mcp.json` no projeto, ou `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "repolens": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@douglas-strey/repolens", "mcp", "${workspaceFolder}"]
    }
  }
}
```

Outros clientes usam o mesmo comando: `npx -y @douglas-strey/repolens mcp <project>`, ou
`repolens mcp <project>` com o RepoLens instalado. Prefira o comando instalado para
repositórios em que você não confia (veja
[security.md](security.md#rodando-o-próprio-repolens-com-segurança)).

## Códigos de saída

| Código | Significado |
| --- | --- |
| `0` | Sucesso. Para `doctor`: nenhum achado no nível de `--fail-on` ou acima. |
| `1` | `doctor` encontrou problemas no nível de `--fail-on` ou acima, ou o `setup` não terminou (um passo falhou, falta uma ferramenta, a versão do Node.js não serve ou você respondeu não). |
| `2` | Uso inválido (opção desconhecida, valor inválido), diretório ilegível ou inexistente, uma configuração do usuário ou um arquivo `--config` que não existe ou não é JSON válido, ou um arquivo de saída que não pôde ser gravado. |
| `3` | Erro interno inesperado (um bug; reporte com a saída de `--verbose`, por favor). |

## Variáveis de ambiente

| Variável | Efeito |
| --- | --- |
| `NO_COLOR` | Desativa as cores ([no-color.org](https://no-color.org)). |
| `FORCE_COLOR` | Força as cores ligadas (`1`) ou desligadas (`0`). `--no-color`, `--color` e `NO_COLOR` têm precedência. |
| `REPOLENS_ASCII=1` | Usa símbolos de status ASCII (`+`, `!`, `x`) em vez de `✓`, `⚠`, `✗`, inclusive nos arquivos de `--output`. É escolhido automaticamente em terminais sem suporte a Unicode. |
| `COLUMNS` | Largura da saída quando stdout não é um terminal (limitada a 40–140). |
| `REPOLENS_DEBUG=1` | Imprime linhas de debug (arquivos pulados, tempo de cada detector) em stderr. |
| `REPOLENS_CONFIG` | Caminho do seu arquivo de configuração do usuário (padrão `~/.config/repolens/config.json`; veja [configuração](configuration.md)). |

## Uso programático

```ts
import { scan, renderMarkdown } from '@douglas-strey/repolens'

const result = await scan({ cwd: '/path/to/repo' })
console.log(result.frameworks.map((f) => f.name))
console.log(renderMarkdown(result))
```

`scan()` retorna o mesmo objeto que `repolens --json --verbose`, incluindo os achados de
baixa confiança. Use `filterByConfidence(result, 'medium')` para obter o que a CLI mostra
por padrão.

`scan()` aplica o próprio `repolens.config.json` do diretório analisado. Passe
`config: false` para ignorá-lo, ou escolha os arquivos você mesmo:

```ts
import { loadProjectConfig, loadUserConfig, scan } from '@douglas-strey/repolens'

const user = await loadUserConfig(process.env, process.platform, process.cwd())
const project = await loadProjectConfig(dir)
const result = await scan({ cwd: dir, config: [user, project].filter((c) => c !== null) })
```

`scan()` aplica os arquivos `.gitignore` e o `info/exclude` do repositório, mas não o seu
arquivo global de exclusões do Git, a menos que você o passe, para que o resultado não
dependa da configuração do Git da máquina. A CLI o passa:

```ts
import { gitExcludesFile, scan } from '@douglas-strey/repolens'

const result = await scan({ cwd: dir, gitExcludesFile: await gitExcludesFile(process.env, process.platform) })
```
