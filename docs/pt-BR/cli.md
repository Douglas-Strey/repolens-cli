# Referência da CLI

[English](../cli.md) | **Português (Brasil)**

```
repolens [path] [options]          Scan a repository (default command)
repolens scan [path] [options]     Same as above
repolens doctor [path] [options]   Check for setup problems and inconsistencies
repolens report [path] [options]   Generate a Markdown report
repolens agent [init] [path] [options]  Generate context for coding agents (experimental)
repolens config [path] [options]   Show the configuration files and settings in effect
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
| `--json` | Imprime as verificações e os diagnósticos como JSON. |
| `-q, --quiet` | Oculta as categorias que passaram e as dicas. |

```sh
repolens doctor                   # falha (código 1) só com erros
repolens doctor --strict          # também falha com avisos
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
      - run: npx --yes repolens-cli doctor --fail-on error
```

## `repolens report`

Gera um relatório em Markdown para onboarding, auditorias técnicas, documentação ou para
entregar a um assistente de IA.

```sh
repolens report                     # imprime em stdout
repolens report --output repolens.md
repolens report --verbose           # inclui achados de baixa confiança
```

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

## Códigos de saída

| Código | Significado |
| --- | --- |
| `0` | Sucesso. Para `doctor`: nenhum achado no nível de `--fail-on` ou acima. |
| `1` | `doctor` encontrou problemas no nível de `--fail-on` ou acima. |
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
import { scan, renderMarkdown } from 'repolens-cli'

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
import { loadProjectConfig, loadUserConfig, scan } from 'repolens-cli'

const user = await loadUserConfig(process.env, process.platform, process.cwd())
const project = await loadProjectConfig(dir)
const result = await scan({ cwd: dir, config: [user, project].filter((c) => c !== null) })
```
