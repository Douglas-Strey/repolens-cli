# Configuração

[English](../configuration.md) | **Português (Brasil)**

O RepoLens funciona sem nenhuma configuração. Quando você quiser mudar o que ele analisa
ou o quão rigoroso o `repolens doctor` é, adicione um arquivo JSON. Existem dois tipos:

- **A sua configuração do usuário** vale para todo repositório que você analisa:
  verificações que não importam para você, o seu nível preferido de `--fail-on`, cores.
- **Uma configuração do projeto** fica no repositório, então todo mundo que o analisa (e o
  CI) obtém os mesmos resultados: caminhos a deixar de fora, variáveis que a plataforma
  fornece, verificações que não se encaixam no projeto.

```sh
repolens config          # quais arquivos valem aqui e as configurações em vigor
```

## Onde ficam os arquivos

| Arquivo | Local |
| --- | --- |
| Configuração do usuário | `~/.config/repolens/config.json`. `$XDG_CONFIG_HOME/repolens/config.json` quando `XDG_CONFIG_HOME` está definida, `%APPDATA%\repolens\config.json` no Windows, ou qualquer caminho em `REPOLENS_CONFIG`. |
| Configuração do projeto | `repolens.config.json` no diretório analisado, ou uma chave `"repolens"` no `package.json` dele. Só o diretório analisado é pesquisado, não os diretórios acima dele. |

Os dois usam o mesmo formato: JSON, com comentários e vírgulas no final permitidos. O
RepoLens só lê esses arquivos como dados; ele nunca executa uma configuração em
JavaScript.

## Exemplo

```jsonc
// repolens.config.json
{
  "$schema": "https://unpkg.com/repolens-cli/schema/config.schema.json",

  // Código gerado e uma cópia vendorizada de um app antigo: não fazem parte do projeto.
  "ignore": ["legacy/", "src/generated/"],

  "doctor": {
    // O CI também falha com avisos.
    "failOn": "warning",
    "rules": {
      // As variáveis estão documentadas em docs/setup.md em vez de .env.example.
      "ENV_EXAMPLE_MISSING": "off",
      "ENV_UNDOCUMENTED": "off",
      // Um lockfile ausente quebra os nossos deploys.
      "LOCKFILE_MISSING": "error"
    }
  },

  "environment": {
    // Definidas pelo Fly.io em tempo de execução.
    "provided": ["FLY_*", "PRIMARY_REGION"]
  }
}
```

As mesmas configurações no `package.json`:

```json
{
  "name": "acme-api",
  "repolens": {
    "doctor": { "failOn": "warning" }
  }
}
```

A linha `$schema` dá autocompletar e validação nos editores com suporte a JSON Schema
(VS Code, IDEs da JetBrains, Zed…). O schema também vem no pacote como
`repolens-cli/schema/config.schema.json`.

## Configurações

### `ignore`

Caminhos a deixar de fora da análise, na
[sintaxe do .gitignore](https://git-scm.com/docs/gitignore), relativos ao diretório
analisado. O RepoLens já pula tudo o que os seus arquivos `.gitignore` ignoram, além de
`node_modules`, `vendor`, caches de build e outros diretórios gerados, então isto serve
para arquivos commitados que não fazem parte do projeto: cópias vendorizadas, código
gerado, fixtures, apps arquivados.

```json
{ "ignore": ["legacy/", "*.generated.ts", "examples/*", "!examples/basic/"] }
```

Como no `.gitignore`, um padrão com `!` traz de volta algo que um padrão anterior deixou
de fora, mas não dentro de um diretório deixado de fora por inteiro: `examples/*` mais
`!examples/basic/` mantém um exemplo, `examples/` não manteria. Uma regra `!` em um
arquivo `.gitignore` não traz de volta o que esses padrões deixam de fora.

O RepoLens lê até 1.000 padrões e recusa padrões com mais de três segmentos `**`, porque a
correspondência com eles é lenta demais.

Ignorar um arquivo não faz o RepoLens fingir que o Git o ignora: um `.env` local listado
aqui continua sendo reportado por `ENV_FILE_NOT_IGNORED` se o Git fosse incluí-lo em um
commit.

### `maxFiles`

Para de indexar depois desta quantidade de arquivos, de 1 a 1.000.000 (padrão 100.000).
`--max-files` tem precedência.

### `doctor.failOn`

O valor padrão de `--fail-on`: `error` (o padrão), `warning`, `info` ou `never`. As opções
de linha de comando `--fail-on` e `--strict` têm precedência.

### `doctor.rules`

Configurações de verificações individuais, por [código](diagnostics.md):

- `"off"` desativa a verificação. Ela aparece como `disabled` na saída `--json` e é
  contada no resumo.
- `"error"`, `"warning"` ou `"info"` reporta tudo o que a verificação encontrar com essa
  severidade.

```json
{ "doctor": { "rules": { "SCRIPT_MISSING_LINT": "off", "RUNTIME_EOL": "error" } } }
```

Um código digitado errado é reportado com uma sugestão (`Unknown check "ENV_UNDOCUMNTED" …
did you mean ENV_UNDOCUMENTED?`), e a configuração é ignorada.

**Verificações de segurança** (`ENV_PUBLIC_SECRET`, `ENV_EXAMPLE_REAL_SECRET`,
`TRACKED_ENV_FILE`, `ENV_FILE_NOT_IGNORED`) não podem ser desativadas nem rebaixadas por
uma configuração do projeto: o RepoLens costuma rodar em repositórios que ninguém revisou
ainda, e esses repositórios não podem ter como esconder os próprios achados de segurança.
Uma configuração do projeto pode elevá-las para `"error"`. Para desativar uma delas, use a
sua configuração do usuário ou um arquivo passado com `--config`.

### `environment.provided`

Variáveis que a sua plataforma ou as suas ferramentas definem, e que por isso nunca
precisam estar em um arquivo env. Assim como `CI` ou `NODE_ENV`, o doctor passa a nunca
reportá-las como não documentadas, ausentes, só locais ou não usadas. `*` corresponde a
quaisquer caracteres.

```json
{ "environment": { "provided": ["FLY_*", "RAILWAY_*", "INTERNAL_METRICS_URL"] } }
```

As variáveis continuam aparecendo na seção de ambiente da análise.

### `output` (somente na configuração do usuário)

Preferências do terminal. Um projeto não pode defini-las: elas são suas.

```json
{ "output": { "color": "never", "ascii": true } }
```

- `color`: `auto` (o padrão), `always` ou `never`. `--color`, `--no-color`, `NO_COLOR`
  e `FORCE_COLOR` têm precedência.
- `ascii`: usa `+`, `!` e `x` em vez de `✓`, `⚠` e `✗`, como `REPOLENS_ASCII=1`.

## Precedência

Da menor para a maior:

1. A sua configuração do usuário.
2. A configuração do projeto, ou o arquivo passado com `--config`.
3. Opções de linha de comando (`--fail-on`, `--strict`, `--max-files`, `--color`…).

Fontes posteriores sobrescrevem valores únicos (`maxFiles`, `doctor.failOn`, cada entrada
de `doctor.rules`). Listas (`ignore`, `environment.provided`) se acumulam.

## Opções de linha de comando

| Opção | Efeito |
| --- | --- |
| `--config <file>` | Usa este arquivo em vez da configuração do próprio projeto. A sua configuração do usuário continua valendo. |
| `--no-config` | Ignora todos os arquivos de configuração, os seus e os do projeto. |

`repolens config [path]` mostra quais arquivos se aplicam a um diretório e as
configurações combinadas; adicione `--json` para uma versão legível por máquina.

## Configurações inválidas

Um problema de configuração nunca faz uma análise falhar. Chaves desconhecidas, tipos
errados e valores fora do intervalo são reportados em stderr e ignorados, então uma
configuração escrita para um RepoLens mais novo continua funcionando com um mais antigo:

```
⚠ Unknown setting "doctor.failon" in repolens.config.json (did you mean "failOn"?)
```

Eles também aparecem na saída `--json` em `meta.warnings`, com `"kind": "config"`. Uma
configuração do projeto que o RepoLens não consegue interpretar é ignorada do mesmo jeito.
A sua configuração do usuário e um arquivo `--config` são diferentes: se não existirem ou
não forem JSON válido, o RepoLens para com código de saída 2 para que você os corrija.

## Revisando um repositório não confiável

Uma configuração do projeto molda os resultados, então o RepoLens sempre avisa quando uma
foi aplicada:

```
Configured by repolens.config.json: 2 checks turned off, 1 ignore pattern.
```

A saída `--json` a lista em `meta.config`. Quando você estiver avaliando um repositório em
que não confia, rode com `--no-config` para vê-lo sem as configurações dele. Em nenhum dos
casos o repositório consegue desativar as verificações de segurança.
