# Diagnósticos

[English](../diagnostics.md) | **Português (Brasil)**

O `repolens doctor` roda um conjunto de verificações no repositório analisado. Todo problema
que ele encontra é um **diagnóstico** com um **código** estável, como `ENV_UNDOCUMENTED`. Os
códigos fazem parte do contrato público: eles nunca são renomeados nem reutilizados, então
você pode filtrar por eles com segurança em scripts e no CI.

```sh
repolens doctor --json | jq '.diagnostics[] | select(.code == "ENV_UNDOCUMENTED") | .subject'
```

Cada diagnóstico tem uma `message` de uma frase, uma `hint` com uma correção sugerida, os
`files` envolvidos (relativos à raiz do projeto) e um `subject` (a variável, o arquivo, a
porta ou o pacote de que ele trata). **As mensagens nunca contêm valores de segredos**: o
RepoLens só reporta nomes de variáveis, caminhos de arquivos, versões e portas. Texto tirado
de arquivos do repositório (como padrões de workspace ou nomes de serviços do Compose) tem os
caracteres de controle removidos e o tamanho limitado antes de ser impresso, e caminhos do
repositório dentro de comandos de shell sugeridos ficam entre aspas quando contêm
metacaracteres de shell, então um nome de arquivo hostil não consegue transformar uma dica
copiada e colada em outro comando.

## Severidades

| Severidade | Significado | Faz o `repolens doctor` falhar |
| --- | --- | --- |
| `error` | Algo está inseguro ou quebrado agora (um segredo commitado, serviços que não conseguem subir juntos). | por padrão (`--fail-on error`) |
| `warning` | Provavelmente vai causar um problema para alguém que trabalha no projeto. | com `--strict` / `--fail-on warning` |
| `info` | Vale a pena saber; baixo risco ou questão de convenção. | com `--fail-on info` |

Alguns códigos escolhem a severidade conforme o contexto (por exemplo, `DOCKER_PORT_CONFLICT`
é um erro, ou um aviso quando um dos serviços só sobe com um profile do Compose). Isso está
indicado em cada código abaixo. Essas são as severidades padrão: um arquivo de configuração
pode mudá-las (veja [Configurando as verificações](#configurando-as-verificações)).

## Verificações aprovadas, puladas e desativadas

Todo código também é uma **verificação** com um título positivo (por exemplo, "Environment
variables used in code are documented"). Uma verificação fica `failed` quando produziu
diagnósticos, `passed` quando rodou e não encontrou nada, `skipped` quando não tinha nada
para verificar e `disabled` quando um arquivo de configuração a desativou (ela nem chega a
rodar). Uma verificação é pulada quando os arquivos de entrada dela não existem (verificações
de gerenciador de pacotes, de scripts e de Node.js sem um `package.json`, verificações de
Docker sem arquivos Compose, verificações de Git fora de um repositório Git, …) ou não
puderam ser parseados (um `turbo.json` quebrado faz `TURBO_PIPELINE_KEY` ser pulada;
`CONFIG_PARSE_ERROR` reporta o arquivo). Uma verificação nunca aparece como aprovada para
algo que ela não conseguiu examinar, e um diretório vazio pula todas as verificações. A
decisão de pular vem do índice de arquivos e dos resultados de parse, não só da saída dos
detectores, então um detector que falha nunca esconde um problema real. Uma verificação que
falha ao rodar também é pulada, e a falha é reportada como um aviso da análise.

Na saída `--json`, toda verificação tem um `status`, e `doctor.summary` conta as
verificações `passed`, `failed`, `skipped` e `disabled`.

## Configurando as verificações

Um [arquivo de configuração](configuration.md) pode desativar uma verificação ou mudar a
severidade dela com `doctor.rules`, por código:

```json
{ "doctor": { "rules": { "SCRIPT_MISSING_LINT": "off", "RUNTIME_EOL": "error" } } }
```

- `"off"` desativa a verificação: ela não roda e aparece como `disabled`.
- `"error"`, `"warning"` ou `"info"` reporta tudo o que a verificação encontrar com essa
  severidade, em vez das severidades listadas abaixo.

A configuração do próprio projeto (`repolens.config.json`, ou a chave `"repolens"` no
`package.json` dele) não pode desativar nem rebaixar as verificações de segurança
(`ENV_EXAMPLE_REAL_SECRET`, `TRACKED_ENV_FILE`, `ENV_FILE_NOT_IGNORED`, `ENV_PUBLIC_SECRET`):
um repositório não pode ter como esconder os próprios achados de segurança. Ela pode
elevá-las para `"error"`. A sua configuração do usuário ou um arquivo passado com `--config`
podem desativá-las. Veja [configuration.md](configuration.md#doctorrules) para os detalhes.

## Todos os códigos

| Código | Severidade | Categoria | Verificação |
| --- | --- | --- | --- |
| [`PACKAGE_JSON_INVALID`](#package_json_invalid) | error | configuration | package.json é JSON válido |
| [`CONFIG_PARSE_ERROR`](#config_parse_error) | warning | configuration | Os arquivos de configuração não têm erros de parse |
| [`ENV_EXAMPLE_REAL_SECRET`](#env_example_real_secret) | error | security | Os arquivos env de exemplo não contêm credenciais reais |
| [`TRACKED_ENV_FILE`](#tracked_env_file) | error / warning | security | Os arquivos env locais não são commitados |
| [`ENV_FILE_NOT_IGNORED`](#env_file_not_ignored) | warning | security | Os arquivos env locais são ignorados pelo Git |
| [`ENV_PUBLIC_SECRET`](#env_public_secret) | warning | security | Nenhum segredo é exposto ao navegador |
| [`ENV_UNDOCUMENTED`](#env_undocumented) | warning / info | environment | As variáveis de ambiente usadas no código estão documentadas |
| [`ENV_LOCAL_ONLY`](#env_local_only) | warning | environment | As variáveis de ambiente locais estão documentadas |
| [`ENV_EXAMPLE_MISSING`](#env_example_missing) | warning / info | environment | Um arquivo env de exemplo documenta o ambiente |
| [`ENV_UNUSED`](#env_unused) | info | environment | As variáveis de ambiente documentadas são usadas |
| [`ENV_MISSING_LOCAL`](#env_missing_local) | info | environment | O arquivo env local define todas as variáveis documentadas |
| [`MULTIPLE_LOCKFILES`](#multiple_lockfiles) | warning | package-manager | Só o lockfile de um gerenciador de pacotes é commitado |
| [`PACKAGE_MANAGER_MISMATCH`](#package_manager_mismatch) | warning | package-manager | O lockfile corresponde ao gerenciador de pacotes declarado |
| [`PACKAGE_MANAGER_UNDECLARED`](#package_manager_undeclared) | info | package-manager | O gerenciador de pacotes está declarado |
| [`LOCKFILE_MISSING`](#lockfile_missing) | info | package-manager | As dependências estão travadas |
| [`NODE_VERSION_CONFLICT`](#node_version_conflict) | warning | runtime | As versões fixadas do Node.js batem entre si |
| [`NODE_VERSION_OUT_OF_RANGE`](#node_version_out_of_range) | warning | runtime | As versões fixadas do Node.js satisfazem engines.node |
| [`RUNTIME_EOL`](#runtime_eol) | warning | runtime | Os runtimes fixados têm suporte |
| [`GO_VERSION_CONFLICT`](#go_version_conflict) | warning | runtime | Os toolchains do Go satisfazem o go.mod |
| [`WORKSPACE_DUPLICATE_CONFIG`](#workspace_duplicate_config) | warning | workspace | Os workspaces são declarados em um só lugar |
| [`WORKSPACE_PATTERN_EMPTY`](#workspace_pattern_empty) | warning | workspace | Todo padrão de workspace corresponde a um pacote |
| [`TURBO_PIPELINE_KEY`](#turbo_pipeline_key) | warning / info | workspace | turbo.json usa o schema atual |
| [`DOCKER_PORT_CONFLICT`](#docker_port_conflict) | error / warning | docker | Os serviços do Compose publicam portas do host distintas |
| [`COMPOSE_ENV_FILE_MISSING`](#compose_env_file_missing) | warning | docker | As entradas env_file do Compose existem |
| [`ENV_PORT_MISMATCH`](#env_port_mismatch) | warning | docker | As URLs em arquivos env apontam para portas publicadas pelos serviços |
| [`COMPOSE_VERSION_OBSOLETE`](#compose_version_obsolete) | info | docker | Os arquivos Compose omitem a chave obsoleta version |
| [`GITIGNORE_MISSING`](#gitignore_missing) | warning | git | O repositório tem um .gitignore |
| [`GITIGNORE_NODE_MODULES`](#gitignore_node_modules) | warning | git | node_modules é ignorado pelo Git |
| [`SCRIPT_TEST_PLACEHOLDER`](#script_test_placeholder) | info | scripts | O script test roda testes de verdade |
| [`SCRIPT_MISSING_TEST`](#script_missing_test) | info | scripts | package.json tem um script test |
| [`SCRIPT_MISSING_LINT`](#script_missing_lint) | info | scripts | Um script de lint roda o linter configurado |
| [`ESLINT_LEGACY_CONFIG`](#eslint_legacy_config) | warning / error / info | tooling | O ESLint usa flat config |
| [`GO_SUM_MISSING`](#go_sum_missing) | warning | tooling | Os módulos Go têm um go.sum commitado |
| [`NEXT_MIDDLEWARE_DEPRECATED`](#next_middleware_deprecated) | info | tooling | Os apps Next.js usam a convenção proxy |

---

## Configuração

### `PACKAGE_JSON_INVALID`

**Severidade:** error · **Categoria:** configuration

- **O que verifica:** o `package.json` da raiz existe, mas não é JSON válido.
- **Por que importa:** os gerenciadores de pacotes se recusam a instalar, os scripts não
  rodam, e toda verificação que lê o `package.json` (lockfiles, scripts, workspaces) fica
  sem ter com o que trabalhar.
- **Como corrigir:** corrija o erro de sintaxe; uma vírgula sobrando no final ou uma aspa
  faltando são o caso típico. A mensagem do parser aparece com `--verbose` (ela nunca faz
  parte do diagnóstico, porque mensagens do parser podem citar o conteúdo do arquivo).
- **Exemplo:** `package.json is not valid JSON`

### `CONFIG_PARSE_ERROR`

**Severidade:** warning · **Categoria:** configuration

- **O que verifica:** um diagnóstico por arquivo de configuração que o RepoLens não conseguiu
  parsear: YAML (arquivos Compose, `pnpm-workspace.yaml`, workflows de CI), JSON/JSONC
  (`turbo.json`, `tsconfig.json`, …) e arquivos `go.mod` sem uma linha `module`. O
  `package.json` da raiz é reportado por `PACKAGE_JSON_INVALID` em vez disso. Esta
  verificação roda depois de todas as outras, então ela também vê arquivos que só outras
  verificações leem.
- **Por que importa:** as ferramentas donas desses arquivos normalmente também vão falhar, e
  o RepoLens pulou o arquivo, então os outros achados dele podem estar incompletos.
- **Como corrigir:** corrija o erro de sintaxe. Rode com `--verbose` para ver a mensagem do
  parser.
- **Exemplo:** `Couldn't parse docker-compose.yml`

## Segurança

As verificações de arquivos env daqui e de [Ambiente](#ambiente) tratam cada arquivo env de
acordo com o tipo dele (o `kind` de cada arquivo na seção de ambiente da análise):

- **local**: os valores de um único desenvolvedor, que nunca devem ser commitados: `.env`,
  `.env.local`, `.env.*.local`, `local.env` e o `.envrc` do direnv.
- **mode**: arquivos por ambiente que os frameworks carregam e que os projetos muitas vezes
  commitam de propósito: `.env.development`, `.env.production`, `.env.test`, `.env.ci`,
  `.env.staging`, `prod.env`, … (modos `development`, `develop`, `dev`, `production`,
  `prod`, `test`, `testing`, `ci`, `staging`, `stage`, `preview`, `qa`, `uat`, `e2e`,
  `integration`).
- **service**: qualquer outro arquivo env que um serviço do Compose carrega com `env_file`
  (`.env.db`).
- **example**: templates de documentação: `.env.example`, `.env.sample`, `.env.template`,
  `env.example`, … (qualquer nome de arquivo env que contenha `example`, `sample`,
  `template`, `dist`, `defaults` ou `schema`).
- **other**: arquivos env sem propósito conhecido (`.env.backup`, `.env.old`,
  `secrets.env`). `TRACKED_ENV_FILE` e `ENV_FILE_NOT_IGNORED` só os reportam quando eles têm
  um valor com formato de credencial; nenhuma outra verificação olha para eles. O
  `.env.vault` criptografado foi feito para ser commitado e nunca é verificado.

Os arquivos env são lidos na raiz, nos diretórios de pacotes e de módulos Go, em diretórios
com um arquivo Compose e ao lado dos arquivos env que os serviços do Compose carregam, até
três diretórios de profundidade. Arquivos env ignorados pelo Git também são lidos.

### `ENV_EXAMPLE_REAL_SECRET`

**Severidade:** error · **Categoria:** security

- **O que verifica:** um arquivo env de exemplo tem um valor que corresponde a um formato
  conhecido de credencial: chave de acesso da AWS, token do GitHub, GitLab, npm ou Slack,
  chave live do Stripe, chave de API da OpenAI, Anthropic, Google ou SendGrid, ou chave
  privada. Atribuições comentadas (`# NAME=value`) também contam. Um diagnóstico por
  variável, listando todos os arquivos de exemplo em que ela tem um valor assim.
- **Por que importa:** arquivos de exemplo são commitados e compartilhados; uma credencial
  real em um deles é uma credencial vazada.
- **Como corrigir:** primeiro rotacione a credencial (removê-la do arquivo não a remove do
  histórico do Git), depois substitua o valor por um placeholder vazio (`NAME=`).
- **Exemplo:** `.env.example contains what looks like a real credential in STRIPE_SECRET_KEY`

### `TRACKED_ENV_FILE`

**Severidade:** error, ou warning para valores padrão commitados · **Categoria:** security

- **O que verifica:** um arquivo env local, de modo, de serviço ou de outro tipo está
  rastreado pelo Git (lido de `.git/index`, sem rodar o `git`). Só roda em repositórios Git.
- **Severidade:** um arquivo local (`.env`, `.env.local`, `.env.production.local`, …) é
  sempre um erro. Arquivos de modo, arquivos de serviço e o `.envrc` muitas vezes são
  commitados de propósito com valores padrão que não são segredos (Vite, Next.js, direnv),
  então eles são um aviso, ou um erro quando um dos valores deles (incluindo atribuições
  comentadas) corresponde a um formato conhecido de credencial (os formatos de
  `ENV_EXAMPLE_REAL_SECRET`). Um nome com cara de segredo, sozinho, não faz disso um erro:
  `AUTH_SECRET=test-secret-not-real` em um `.env.test` commitado é um aviso. Arquivos de modo
  e de serviço sem variáveis, e arquivos de modo que só definem variáveis expostas ao
  navegador (`VITE_API_URL`, `NEXT_PUBLIC_SITE_URL`), não são reportados, a menos que
  contenham uma credencial. Um `.envrc` sem variáveis (só `use flake`, `layout node`, …)
  nunca é reportado. Arquivos env sem propósito conhecido (`.env.backup`) só são
  reportados, como erro, quando têm um valor com formato de credencial.
- **Por que importa:** todo mundo que clona o repositório recebe os valores, e eles ficam no
  histórico do Git.
- **Como corrigir:** rode `git rm --cached .env`, adicione o arquivo ao `.gitignore` e
  rotacione qualquer segredo que ele continha. Para um arquivo de modo, deixe nele só valores
  padrão que não são segredos e coloque os segredos no arquivo `.local` correspondente
  (`.env.production.local`), que não é commitado.
- **Exemplo:** `.env is tracked by Git`, ou
  `.env.staging is tracked by Git and contains what looks like a real credential`

### `ENV_FILE_NOT_IGNORED`

**Severidade:** warning · **Categoria:** security

- **O que verifica:** um arquivo env existe, não está rastreado pelo Git e não é coberto
  pelo `.gitignore`. Todo arquivo local é reportado, exceto o `.envrc`. Arquivos env de
  modo, de serviço e de outro tipo só são reportados quando um dos valores deles (incluindo
  atribuições comentadas) corresponde a um formato conhecido de credencial; sem isso, pode
  ser que eles devam mesmo ser commitados. Arquivos que o Git já rastreia são reportados por
  `TRACKED_ENV_FILE` em vez disso. Só roda em repositórios Git, e é pulada quando a análise é
  de um subdiretório de um repositório (os arquivos `.gitignore` acima dele não ficam
  visíveis para a análise).
- **Por que importa:** o próximo `git add .` vai commitá-lo.
- **Como corrigir:** adicione o nome do arquivo ao `.gitignore`, ou `.env*` junto com
  `!.env.example`.
- **Exemplo:** `.env is not ignored by Git and could be committed by accident`

### `ENV_PUBLIC_SECRET`

**Severidade:** warning · **Categoria:** security

- **O que verifica:** uma variável (usada no código ou citada em qualquer arquivo env) com
  um prefixo de exposição ao cliente (`NEXT_PUBLIC_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_`,
  `REACT_APP_`, `VUE_APP_`, `STORYBOOK_`, `GATSBY_`, `PUBLIC_` ou `VITE_`) cujo nome contém
  `SECRET`, `SECRETS`, `SECRETKEY`, `CLIENTSECRET`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`,
  `PRIVATEKEY`, `SERVICE_ROLE` ou `SERVICEROLE` como palavra inteira entre underscores
  (`VITE_DB_PASSWORD`, mas não `NEXT_PUBLIC_SECRETARY_EMAIL`). Tokens e chaves, sozinhos,
  não bastam, já que muitos são públicos por design (`NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`,
  `…_PUBLISHABLE_KEY`, `…_ANON_KEY`).
- **Por que importa:** os frameworks embutem essas variáveis no JavaScript enviado a todo
  visitante.
- **Como corrigir:** renomeie a variável sem o prefixo (por exemplo, `JWT_SECRET`), leia-a
  só no código do servidor e rotacione o valor se ele já tiver ido para algum deploy.
- **Exemplo:** `NEXT_PUBLIC_JWT_SECRET is exposed to the browser bundle but looks like a secret`

## Ambiente

Estas verificações usam a seção de ambiente da análise: variáveis referenciadas no código e
na configuração, os nomes definidos em arquivos env locais e de modo, e os nomes
documentados em arquivos de exemplo (veja os tipos de arquivo em [Segurança](#segurança)).
Uma linha comentada em um arquivo de exemplo (`# NAME=`) também documenta o nome. Algumas
variáveis recebem tratamento especial:

- **Variáveis de plataforma** são fornecidas pelo sistema operacional, shells, terminais,
  gerenciadores de pacotes, plataformas de CI ou test runners, então estas verificações
  nunca as reportam: `NODE_ENV`, `CI`, `TZ`, `HOME`, `PATH`, `PWD`, `SHELL`, `USER`,
  `LANG`, `TERM`, `TMPDIR`, `HOSTNAME`, `DEBUG`, os equivalentes delas no Windows
  (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`), convenções de terminal
  (`NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `COLUMNS`, `LINES`, `LC_ALL`, `EDITOR`,
  `VISUAL`), os built-ins de `import.meta.env` do Vite (`MODE`, `DEV`, `PROD`, `SSR`,
  `BASE_URL`), as variáveis padrão do GitHub Actions (`GITHUB_ACTIONS`, `GITHUB_SHA`,
  `GITHUB_TOKEN`, `GITHUB_REF_NAME`, `GITHUB_RUN_ID`, …, mas não nomes de aplicação como
  `GITHUB_CLIENT_ID`), e nomes que começam com `npm_`, `RUNNER_`, `VERCEL_`, `NETLIFY`,
  `RENDER_`, `RAILWAY_`, `FLY_`, `CF_PAGES`, `NEXT_RUNTIME`, `NEXT_PHASE`, `VITEST`,
  `JEST_WORKER_ID` ou `XDG_`. `PORT` não está nesta lista: ela é configuração da
  aplicação. Variáveis listadas em `environment.provided` em um
  [arquivo de configuração](configuration.md#environmentprovided) são tratadas como
  variáveis de plataforma por estas verificações (as verificações de segurança continuam
  olhando para elas).
- **Variáveis só de teste** são referenciadas apenas em código de teste: arquivos de teste
  (`*.test.ts`, `*_test.go`, `test_*.py`, …), diretórios de teste (`test/`, `__tests__/`,
  `e2e/`, …) e configuração de test runner (`playwright.config.ts`, `vitest.config.ts`,
  …). Elas não são configuração que os desenvolvedores precisam definir. Referências em
  diretórios de fixtures, exemplos, templates, playgrounds e benchmarks não são contadas de
  jeito nenhum.
- **Variáveis com valor padrão** são lidas com um fallback em todas as referências no código
  (`process.env.PORT ?? 3000` ou `|| 3000`, um `.default()` de schema, …), então são
  opcionais.

### `ENV_UNDOCUMENTED`

**Severidade:** warning, ou info quando a variável tem valor padrão · **Categoria:** environment

- **O que verifica:** uma variável é usada no código, mas não aparece em nenhum arquivo env
  de exemplo, enquanto existe pelo menos um arquivo de exemplo que pôde ser lido. O
  diagnóstico cita o arquivo de exemplo mais próximo de onde a variável é usada
  (`apps/api/.env.example` para código em `apps/api`). Em um workspace, só contam arquivos de
  exemplo no mesmo pacote ou em um diretório acima dele; quando não há nenhum, a mensagem diz
  isso e a dica sugere criar `<package>/.env.example`. Variáveis só de teste, variáveis de
  plataforma e nomes que uma configuração do Next.js fornece pelo bloco `env` dela não são
  reportados.
- **Severidade:** um aviso, ou informativo quando toda referência tem um valor padrão no
  código: vale a pena documentar a variável, mas ela não bloqueia o setup.
- **Por que importa:** quem chega para contribuir copia o arquivo de exemplo e depois esbarra
  em um erro em tempo de execução ou em um comportamento errado silencioso.
- **Como corrigir:** adicione `NAME=` (sem valor) ao arquivo de exemplo.
- **Exemplo:** `STRIPE_SECRET_KEY is used in code but missing from .env.example`. Com valor
  padrão: `PORT is used in code (with a default) but missing from .env.example`. Em um
  pacote do workspace sem arquivo de exemplo:
  `STRIPE_KEY is used in apps/api but no example env file there documents it`

### `ENV_LOCAL_ONLY`

**Severidade:** warning · **Categoria:** environment

- **O que verifica:** uma variável está definida em um arquivo env local (`.env`,
  `.env.local`, …), mas não está documentada em nenhum arquivo de exemplo (e existe um
  arquivo de exemplo). Arquivos de modo e de serviço não contam, e o `.envrc` também não,
  porque ele guarda configurações do direnv (`AWS_PROFILE`), e não a configuração do app.
  Variáveis que também são usadas no código fora dos testes são reportadas por
  `ENV_UNDOCUMENTED` em vez disso, então cada variável é reportada uma vez só; uma variável
  que só os testes leem é reportada aqui. O diagnóstico cita o arquivo de exemplo mais
  próximo do arquivo local.
- **Por que importa:** o projeto pode depender de uma configuração que só uma máquina tem.
- **Como corrigir:** documente-a no arquivo de exemplo, ou apague-a do arquivo local se ela
  estiver obsoleta.
- **Exemplo:** `SECRET_TOKEN is set in .env but missing from .env.example`

### `ENV_EXAMPLE_MISSING`

**Severidade:** warning, ou info para bibliotecas e CLIs · **Categoria:** environment

- **O que verifica:** não existe nenhum arquivo env de exemplo, mas o código precisa de
  variáveis ou existe um arquivo env local. O código precisa de uma variável quando código
  fora dos testes a lê sem valor padrão e ela não é uma variável de plataforma nem é
  fornecida pelo bloco `env` de uma configuração do Next.js: um servidor que lê
  `process.env.PORT ?? 3000` não precisa de template. Arquivos de modo, arquivos de serviço
  e o `.envrc` não contam como arquivo env local. É reportado uma vez só; a dica lista até
  cinco nomes (as variáveis de que o código precisa e as definidas em arquivos locais).
- **Severidade:** um aviso. Para projetos detectados como biblioteca ou CLI sem um arquivo
  env local, é só informativo, já que esses projetos costumam ler configurações opcionais.
- **Por que importa:** não há como saber quais variáveis definir sem ler o código.
- **Como corrigir:** crie um `.env.example` com todos os nomes e sem valores, ao lado do
  arquivo env local ou na raiz (a dica informa o caminho).
- **Exemplo:** `No .env.example documents the 2 environment variables used in code`, ou
  `.env exists but there is no .env.example documenting which variables to set`

### `ENV_UNUSED`

**Severidade:** info · **Categoria:** environment

- **O que verifica:** uma variável está documentada em um arquivo de exemplo, mas nunca é
  referenciada no código nem na configuração. É pulada quando o projeto não tem
  arquivos-fonte ou quando a análise de uso parou antes do fim. Variáveis que outra coisa
  pode consumir não são reportadas: nomes passados para serviços do Compose
  (`environment:`), `ARG`s de Dockerfile, variáveis documentadas ao lado de um arquivo
  Compose cujos serviços carregam um `env_file`, variáveis de plataforma, nomes que aparecem
  como palavra inteira no código-fonte fora de comentários (uma biblioteca pode lê-los pelo
  nome, como em `const MODE_ENV = "GIN_MODE"`), e nomes que as ferramentas leem por conta
  própria: `PORT`, `HOST`, `NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`,
  `NODE_EXTRA_CA_CERTS`, `DO_NOT_TRACK`, `NEXT_TELEMETRY_DISABLED`, `NEXTAUTH_URL`,
  `NEXTAUTH_SECRET`, `BROWSER`, `GENERATE_SOURCEMAP`, `GIN_MODE`, configurações do toolchain
  do Go (`GOFLAGS`, `GOPROXY`, `GOPRIVATE`, `GOTOOLCHAIN`, `GOMAXPROCS`, `GOMEMLIMIT`,
  `GODEBUG`, `CGO_ENABLED`), e nomes que começam com `NUXT_`, `NITRO_`, `AUTH_`,
  `COMPOSE_`, `DOCKER_`, `TURBO_`, `PRISMA_`, `ASTRO_TELEMETRY` ou `SENTRY_`.
- **Por que importa:** documentação desatualizada deixa o setup mais longo e mais confuso.
- **Como corrigir:** remova-a do arquivo de exemplo se nada mais a lê.
- **Exemplo:** `LEGACY_FLAG is documented in .env.example but never referenced in code`

### `ENV_MISSING_LOCAL`

**Severidade:** info · **Categoria:** environment

- **O que verifica:** existe um arquivo env local na raiz (`.env`, `.env.local`, …; não o
  `.envrc`), e uma variável documentada em um arquivo de exemplo da raiz e de que o código
  precisa (usada fora dos testes, sem valor padrão, que não seja variável de plataforma) não
  está definida em nenhum arquivo env local ou de modo. Arquivos de serviço não contam: quem
  os carrega é um serviço do Compose, não o app. Variáveis documentadas só em um arquivo de
  exemplo aninhado ficam de fora, já que elas pertencem ao arquivo env daquele pacote. A
  mensagem cita o `.env` da raiz, ou o `.env.local` quando não há `.env`.
- **Por que importa:** o código lê a variável sem valor padrão, então o app provavelmente vai
  falhar quando rodar.
- **Como corrigir:** adicione a variável com o seu valor local ao `.env`.
- **Exemplo:** `DATABASE_URL is not set in .env`

## Gerenciador de pacotes

Os lockfiles são lidos do índice de arquivos na raiz do projeto: `package-lock.json`,
`npm-shrinkwrap.json` (npm), `pnpm-lock.yaml` (pnpm), `yarn.lock` (Yarn), `bun.lock`,
`bun.lockb` (Bun). Lockfiles ignorados pelo `.gitignore` não contam como commitados.

### `MULTIPLE_LOCKFILES`

**Severidade:** warning · **Categoria:** package-manager

- **O que verifica:** existem na raiz lockfiles de mais de um gerenciador de pacotes
  (`bun.lock` e `bun.lockb` juntos contam como um só).
- **Por que importa:** as pessoas instalam árvores de dependências diferentes dependendo da
  ferramenta que usam, e os lockfiles vão divergindo.
- **Como corrigir:** mantenha o lockfile do gerenciador de pacotes que a equipe usa e apague
  os outros. Quando o `package.json` declara um gerenciador de pacotes, a dica cita os
  arquivos a apagar.
- **Exemplo:** `Found lockfiles for npm and pnpm: package-lock.json and pnpm-lock.yaml`

### `PACKAGE_MANAGER_MISMATCH`

**Severidade:** warning · **Categoria:** package-manager

- **O que verifica:** o `package.json` declara um gerenciador de pacotes (`packageManager`
  ou `devEngines.packageManager`), mas o lockfile dele não existe, enquanto existe o
  lockfile de outro gerenciador de pacotes.
- **Por que importa:** o CI e o Corepack (onde estiver habilitado) usam a ferramenta
  declarada, que ignora o lockfile commitado, então as instalações não são reproduzíveis.
- **Como corrigir:** gere o lockfile certo (`pnpm import` converte lockfiles do npm e do
  Yarn) e apague o outro, ou corrija a declaração.
- **Exemplo:** `package.json declares pnpm in "packageManager", but package-lock.json is the only lockfile`

### `PACKAGE_MANAGER_UNDECLARED`

**Severidade:** info · **Categoria:** package-manager

- **O que verifica:** existe um lockfile, mas o `package.json` não tem campo
  `packageManager`, nem `devEngines.packageManager`, nem uma versão de npm, pnpm ou Yarn
  fixada pelo Volta.
- **Por que importa:** quem contribui e o CI podem usar um gerenciador de pacotes, ou uma
  versão major, diferente daquele que gerou o lockfile.
- **Como corrigir:** registre o gerenciador de pacotes e a versão no `package.json`, por
  exemplo com `npm pkg set packageManager=pnpm@$(pnpm --version)`. A dica informa a versão
  quando o repositório a revela (um `engines.pnpm` exato, ou o arquivo de release do
  `yarnPath` do Yarn). O comando não precisa do Corepack, que o Node.js 25 e mais novos não
  trazem mais; o Corepack, se você o usa, passa a rodar essa versão.
- **Exemplo:** `package.json does not declare which package manager to use (found pnpm-lock.yaml)`

### `LOCKFILE_MISSING`

**Severidade:** info · **Categoria:** package-manager

- **O que verifica:** o `package.json` da raiz (ou de um pacote do workspace) declara
  dependências, mas não há lockfile na raiz. Não é reportado quando o nome de um lockfile é
  coberto pelo `.gitignore` ou o `.npmrc` define `package-lock=false` ou `lockfile=false`
  (nesse caso, não commitar um lockfile é intencional), nem quando a raiz da análise é um
  subdiretório de um repositório Git (o lockfile costuma ficar na raiz do repositório).
- **Por que importa:** cada instalação pode resolver versões diferentes.
- **Como corrigir:** rode o comando de instalação do seu gerenciador de pacotes e commite o
  lockfile.
- **Exemplo:** `package.json declares dependencies but there is no lockfile`

## Runtime

As versões fixadas do Node.js são as versões exatas da seção de runtimes: `.nvmrc`,
`.node-version`, `.tool-versions`, Volta, `FROM node:…` de Dockerfile, `setup-node` do CI e
assim por diante. Intervalos como `engines.node` e aliases como `lts/*` não são versões
fixadas. Um arquivo que fixa várias versões major (uma matriz de testes de CI) fica de fora
destas verificações.

### `NODE_VERSION_CONFLICT`

**Severidade:** warning · **Categoria:** runtime

- **O que verifica:** versões exatas fixadas do Node.js divergem na versão major. É
  reportado uma vez só, listando todos os pares `file: version`. A dica sugere a major
  fixada mais comum que satisfaz `engines.node`, ou a menor major que `engines.node`
  permite. Um arquivo que fixa várias majors (uma matriz de testes de CI) fica de fora. Em um
  monorepo, um diretório com o próprio arquivo de versão (`apps/legacy/.nvmrc`, `volta.node`
  no `package.json` dele) pode rodar outra major de propósito: as versões fixadas dele são
  comparadas entre si e reportadas com o subject `node:<directory>`. Todas as outras versões
  fixadas (workflows de CI, Dockerfiles, pacotes sem versão fixada própria) são comparadas
  com as versões fixadas da raiz (subject `node`).
- **Por que importa:** os ambientes local, de CI e de produção rodam versões diferentes do
  Node.js.
- **Como corrigir:** fixe a mesma versão major em todos os arquivos.
- **Exemplo:** `Node.js versions disagree (.node-version: 18.20.4, .nvmrc: 20)`

### `NODE_VERSION_OUT_OF_RANGE`

**Severidade:** warning · **Categoria:** runtime

- **O que verifica:** uma versão exata fixada não consegue satisfazer o intervalo
  `engines.node` que se aplica a ela: o do pacote mais profundo que contém o arquivo que fixa
  a versão, ou então o do `package.json` da raiz. Versões completas são verificadas com
  `semver.satisfies`; versões parciais (`20`, `20.11`), com `semver.intersects`. Intervalos
  inválidos são ignorados. É pulada quando nenhum pacote declara `engines.node`.
- **Por que importa:** a versão fixada é uma que o projeto diz não suportar; os
  gerenciadores de pacotes podem se recusar a instalar (`engine-strict`) ou o código pode
  usar APIs que não existem nela.
- **Como corrigir:** atualize a versão fixada, ou atualize `engines.node`.
- **Exemplo:** `.nvmrc pins Node.js 20, which does not satisfy engines.node ">=22" in package.json`

### `RUNTIME_EOL`

**Severidade:** warning · **Categoria:** runtime

- **O que verifica:** uma versão exata fixada do Node.js cuja linha de release já chegou ao
  fim de vida na data da análise. Um diagnóstico por major, listando os arquivos. Datas de
  fim de vida:

  | Major | Fim de vida | Major | Fim de vida |
  | --- | --- | --- | --- |
  | 10 | 2021-04-30 | 19 | 2023-06-01 |
  | 12 | 2022-04-30 | 20 | 2026-04-30 |
  | 14 | 2023-04-30 | 21 | 2024-06-01 |
  | 16 | 2023-09-11 | 22 | 2027-04-30 |
  | 17 | 2022-06-01 | 23 | 2025-06-01 |
  | 18 | 2025-04-30 | 24 | 2028-04-30 |
  |  |  | 25 | 2026-06-01 |
  |  |  | 26 | 2029-04-30 |

  Majors que não estão na tabela não são reportadas. A API programática aceita uma opção
  `now` para tornar esta verificação determinística.
- **Por que importa:** releases em fim de vida não recebem mais correções de segurança.
- **Como corrigir:** atualize para uma release LTS com suporte (a dica lista as ativas).
- **Exemplo:** `Node.js 18 reached end-of-life on 2025-04-30 (pinned in .node-version)`

### `GO_VERSION_CONFLICT`

**Severidade:** warning · **Categoria:** runtime

- **O que verifica:** um toolchain do Go usado para compilar o projeto (uma imagem base
  `golang:<version>` em um Dockerfile, ou `setup-go` no CI) é mais antigo que a diretiva
  `go` do módulo que ele compila (o módulo que contém o arquivo, ou o único módulo). Tags
  flutuantes como `golang:1.25` são comparadas por major.minor; versões de patch só são
  comparadas quando a imagem fixa uma.
- **Por que importa:** as imagens oficiais `golang` definem `GOTOOLCHAIN=local`, então
  `go build` falha com "go.mod requires go >= …". No CI, o job ou baixa um toolchain mais
  novo a cada execução, ou falha. Toolchains anteriores ao Go 1.21 nem aplicam a diretiva
  `go`, então, em vez disso, o build pode falhar em recursos mais novos da linguagem; a
  mensagem avisa isso para essas versões.
- **Como corrigir:** use uma imagem mais nova (`golang:1.25`), ou `go-version-file: go.mod`
  no `actions/setup-go`.
- **Exemplo:** `Dockerfile builds with Go 1.24, but go.mod requires go 1.25.1, and the official golang image sets GOTOOLCHAIN=local so the build fails`

## Workspace

### `WORKSPACE_DUPLICATE_CONFIG`

**Severidade:** warning · **Categoria:** workspace

- **O que verifica:** os workspaces são declarados tanto no `pnpm-workspace.yaml` quanto no
  campo `workspaces` do `package.json`. Quando o `pnpm-workspace.yaml` não tem uma lista
  `packages` (só guarda configurações ou catalogs), isso só é reportado se o projeto não
  declara npm, Yarn ou Bun nem tem lockfile de nenhum deles, já que nesse caso o pnpm ignora
  a lista do `package.json`.
- **Por que importa:** o pnpm só lê o `pnpm-workspace.yaml`, enquanto npm, Yarn e Bun só
  leem o `package.json`, então as duas listas vão divergindo e as ferramentas discordam
  sobre quais são os pacotes.
- **Como corrigir:** mantenha uma declaração só: remova `workspaces` do `package.json`
  quando você usa pnpm, ou remova a lista de pacotes do `pnpm-workspace.yaml` caso
  contrário.
- **Exemplo:** `Workspaces are declared in both pnpm-workspace.yaml and package.json with different patterns, but pnpm only reads pnpm-workspace.yaml`

### `WORKSPACE_PATTERN_EMPTY`

**Severidade:** warning · **Categoria:** workspace

- **O que verifica:** um padrão (não negado) da declaração de workspace em vigor não
  corresponde a nenhum diretório que contenha um `package.json`. Padrões dentro de
  diretórios que o RepoLens não percorre (ignorados pelo Git) e análises que atingem o
  limite de arquivos são pulados.
- **Por que importa:** geralmente é uma sobra de um pacote movido ou apagado, ou um erro de
  digitação que deixa um pacote de fora do workspace sem ninguém perceber.
- **Como corrigir:** remova o padrão, ou corrija-o para corresponder ao diretório do pacote.
- **Exemplo:** `Workspace pattern "tools/*" in pnpm-workspace.yaml matches no package`

### `TURBO_PIPELINE_KEY`

**Severidade:** warning, ou info quando a versão do turbo é desconhecida · **Categoria:** workspace

- **O que verifica:** o `turbo.json` (na raiz ou em um pacote) usa a chave `pipeline`
  enquanto o `turbo` 2 ou mais novo está declarado. Não é reportado para o Turborepo 1, em
  que `pipeline` é o correto.
- **Por que importa:** o Turborepo 2 renomeou `pipeline` para `tasks` e se recusa a rodar
  com a chave antiga.
- **Como corrigir:** renomeie `pipeline` para `tasks`; `npx @turbo/codemod migrate`
  atualiza a configuração inteira.
- **Exemplo:** `turbo.json uses "pipeline", which Turborepo 2 renamed to "tasks"`

## Docker

Estas verificações leem os arquivos Compose do projeto: `compose.yaml`, `compose.yml`,
`docker-compose.yml`, `docker-compose.yaml`, os arquivos de override deles
(`docker-compose.override.yml`) e variantes (`compose.prod.yaml`), na raiz e até dois
diretórios de profundidade (`docker/`, `deploy/local/`). Arquivos em diretórios de testes,
fixtures, exemplos, templates, playgrounds e benchmarks não fazem parte do projeto e ficam
de fora. `COMPOSE_ENV_FILE_MISSING` e `COMPOSE_VERSION_OBSOLETE` encontram e leem esses
arquivos por conta própria, então funcionam mesmo quando a seção de serviços está vazia;
`DOCKER_PORT_CONFLICT` e `ENV_PORT_MISMATCH` usam a seção de serviços, que é montada a
partir dos mesmos arquivos. Um arquivo com erro de parse fica de fora (`CONFIG_PARSE_ERROR`
o reporta), e uma verificação é pulada quando nenhum dos arquivos Compose pôde ser
parseado.

### `DOCKER_PORT_CONFLICT`

**Severidade:** error, ou warning quando há um serviço com profile envolvido · **Categoria:** docker

- **O que verifica:** dois ou mais serviços publicam a mesma porta literal do host, com o
  mesmo protocolo, em IPs do host que se sobrepõem (um IP não especificado, `0.0.0.0` ou
  `::` se sobrepõe a qualquer endereço). Só são comparados serviços que rodam juntos: o
  arquivo Compose padrão de um diretório e o arquivo de override dele formam um projeto;
  outros arquivos (`docker-compose.prod.yml`) e outros diretórios são projetos separados. O
  mesmo serviço definido em um arquivo base e no override dele é um serviço só. Portas que
  usam interpolação (`${PORT}`), intervalos ou a porta `0` (uma porta efêmera) são puladas.
  Um diagnóstico por porta e projeto Compose, listando os serviços envolvidos (os oito
  primeiros e depois uma contagem).
- **Por que importa:** o segundo serviço não consegue subir e falha com "port is already
  allocated". Serviços com `profiles` só sobem quando solicitados, então nesse caso o
  conflito é um aviso.
- **Como corrigir:** dê a cada serviço a sua própria porta do host (`"8081:80"`).
- **Exemplo:** `Services admin and web in docker-compose.yml both publish host port 8080`

### `COMPOSE_ENV_FILE_MISSING`

**Severidade:** warning · **Categoria:** docker

- **O que verifica:** um serviço referencia um `env_file` (resolvido em relação ao arquivo
  Compose) que não existe. Entradas com `required: false`, interpolação, caminhos absolutos
  ou caminhos fora do projeto são puladas, assim como arquivos dentro de diretórios que o
  RepoLens não percorre (ignorados pelo Git), cuja existência é desconhecida. Arquivos que
  existem mas são ignorados pelo Git contam como existentes. Um diagnóstico por arquivo
  ausente, listando os serviços que o carregam.
- **Por que importa:** `docker compose up` falha com "env file … not found".
- **Como corrigir:** crie o arquivo; a dica sugere `cp .env.example .env` quando existe um
  exemplo (caminhos com metacaracteres de shell ficam entre aspas simples no comando
  sugerido). Ou marque a entrada como opcional com `required: false`.
- **Exemplo:** `Service app in compose.yaml loads env_file .env, which does not exist`

### `ENV_PORT_MISMATCH`

**Severidade:** warning · **Categoria:** docker

- **O que verifica:** uma variável de ambiente guarda uma URL para localhost com porta
  explícita e um scheme de banco de dados (`postgres`/`postgresql`, `mysql`, `mariadb`,
  `mongodb`, `redis`/`rediss`), enquanto serviços do Compose dessa tecnologia publicam
  portas literais do host e nenhuma delas é essa porta. Serviços com portas do host
  interpoladas são pulados. Só são usados o scheme, a porta e se o host da URL é local; a
  URL em si nunca é armazenada.
- **Por que importa:** o app não consegue se conectar ao banco de dados iniciado pelo
  Compose.
- **Como corrigir:** use a porta publicada no arquivo env, ou publique essa porta.
- **Exemplo:** `DATABASE_URL in .env.example uses port 5433, but the db service publishes 5432`

### `COMPOSE_VERSION_OBSOLETE`

**Severidade:** info · **Categoria:** docker

- **O que verifica:** um arquivo Compose tem uma chave `version` no nível superior.
- **Por que importa:** o Compose V2 a ignora e imprime "the attribute `version` is
  obsolete" em toda execução.
- **Como corrigir:** apague a linha.
- **Exemplo:** `docker-compose.yml sets the obsolete top-level "version" key`

## Git

### `GITIGNORE_MISSING`

**Severidade:** warning · **Categoria:** git

- **O que verifica:** o projeto é um repositório Git sem um `.gitignore` na raiz. É pulada
  quando a análise é de um subdiretório de um repositório.
- **Por que importa:** dependências, saída de build e arquivos env locais acabam indo parar
  em commits.
- **Como corrigir:** crie um `.gitignore`; a dica sugere entradas com base no que existe
  (`node_modules/`, `dist/`, `.env*` com `!.env.example`).
- **Exemplo:** `The repository has no .gitignore file`

### `GITIGNORE_NODE_MODULES`

**Severidade:** warning · **Categoria:** git

- **O que verifica:** o projeto tem um `package.json` na raiz e um `.gitignore` que não
  ignora `node_modules`. Regras que só correspondem ao conteúdo dele (`node_modules/*`,
  `**/node_modules/**`) contam como ignorá-lo. Não é reportado para instalações do Yarn
  Plug'n'Play, que não criam `node_modules` (um loader `.pnp.cjs`, ou um `.yarnrc.yml` sem
  um `nodeLinker` diferente de `pnp` em um projeto Yarn).
- **Por que importa:** um único `git add .` commita milhares de arquivos, muitas vezes
  binários específicos de plataforma.
- **Como corrigir:** adicione `node_modules/` ao `.gitignore`.
- **Exemplo:** `.gitignore does not ignore node_modules`

## Scripts

### `SCRIPT_TEST_PLACEHOLDER`

**Severidade:** info · **Categoria:** scripts

- **O que verifica:** o script `test` da raiz é o placeholder escrito pelo `npm init`
  (`echo "Error: no test specified" && exit 1`).
- **Por que importa:** `npm test` sempre falha, o que quebra templates de CI e ferramentas
  que o rodam.
- **Como corrigir:** substitua-o pelo comando de teste de verdade (a dica sugere um quando há
  um test runner instalado) ou remova-o.
- **Exemplo:** `The "test" script in package.json is the npm placeholder that always fails`

### `SCRIPT_MISSING_TEST`

**Severidade:** info · **Categoria:** scripts

- **O que verifica:** o pacote raiz tem um test runner (da seção de testes ou das
  dependências dele: Vitest, Jest, Mocha, AVA, Playwright, …) ou o projeto tem arquivos de
  teste JavaScript (`*.test.*`, `*.spec.*`, `__tests__/`), mas o `package.json` da raiz não
  tem um script `test`. Scripts `test:*` e um target `test` em um Makefile, justfile ou
  Taskfile da raiz contam como script de teste. Arquivos de teste em diretórios de fixtures,
  exemplos e templates não contam; sem um `package.json` ou sem nada para testar, a
  verificação é pulada.
- **Por que importa:** `npm test` é o primeiro comando que as pessoas e as ferramentas
  tentam.
- **Como corrigir:** adicione um script `test` (por exemplo, `"test": "vitest run"`).
- **Exemplo:** `Vitest is set up, but package.json has no "test" script`

### `SCRIPT_MISSING_LINT`

**Severidade:** info · **Categoria:** scripts

- **O que verifica:** um linter (ESLint, Biome, oxlint, golangci-lint, …) está configurado
  para o pacote raiz, mas nenhum script da raiz faz lint: nenhum se chama `lint`/`lint:*`,
  nenhum tem a categoria lint e nenhum roda um comando de linter. Projetos sem um
  `package.json` ou um arquivo de tarefas na raiz (Makefile, justfile, Taskfile) são
  pulados.
- **Por que importa:** quem contribui não consegue rodar com facilidade as mesmas
  verificações que o CI.
- **Como corrigir:** adicione um script `lint` (ou um target no Makefile).
- **Exemplo:** `ESLint is configured, but package.json has no lint script`

## Ferramentas

### `ESLINT_LEGACY_CONFIG`

**Severidade:** warning para ESLint 9, error para ESLint 10+, info quando a versão é desconhecida ou quando o ESLint 9 é configurado para lê-la com `ESLINT_USE_FLAT_CONFIG=false` · **Categoria:** tooling

- **O que verifica:** uma configuração legada (`.eslintrc`, `.eslintrc.js`, `.eslintrc.cjs`,
  `.eslintrc.json`, `.eslintrc.yaml`, `.eslintrc.yml`, ou um campo `eslintConfig` no
  `package.json`) na raiz ou em um diretório de pacote, enquanto esse pacote (ou a raiz)
  declara ESLint 9 ou mais novo. ESLint 8 e anteriores não são reportados.
- **Por que importa:** o ESLint 9 só lê `eslint.config.js` por padrão e o ESLint 10 removeu
  o suporte a eslintrc, então o arquivo legado é ignorado ou o lint falha. Um script de
  pacote que define `ESLINT_USE_FLAT_CONFIG=false` faz o ESLint 9 lê-lo de propósito, então
  esse caso é só informativo (a opção não existe mais no ESLint 10).
- **Como corrigir:** migre com `npx @eslint/migrate-config .eslintrc.json`.
- **Exemplo:** `.eslintrc.json is a legacy ESLint config, but ESLint 9 only reads eslint.config.js by default`

### `GO_SUM_MISSING`

**Severidade:** warning · **Categoria:** tooling

- **O que verifica:** um módulo Go tem dependências diretas (sem `// indirect`) que não são
  substituídas por um diretório local (ou, em um workspace `go.work`, fornecidas por outro
  módulo do repositório), mas não há `go.sum` ao lado do `go.mod` dele, ou o `go.sum` dele é
  ignorado pelo Git.
- **Por que importa:** os builds falham com "missing go.sum entry", e os checksums das
  dependências não são verificados.
- **Como corrigir:** rode `go mod tidy` no diretório do módulo e commite o `go.sum`.
- **Exemplo:** `go.mod requires 3 modules but there is no go.sum next to it`

### `NEXT_MIDDLEWARE_DEPRECATED`

**Severidade:** info · **Categoria:** tooling

- **O que verifica:** um pacote depende do Next.js 16 ou mais novo e tem `middleware.ts` ou
  `middleware.js` na raiz ou em `src/`, sem um `proxy.ts`/`proxy.js`. Pacotes que só
  declaram `next` como peer dependency são bibliotecas e são pulados.
- **Por que importa:** o Next.js 16 renomeou a convenção middleware para proxy; `middleware`
  está marcado como obsoleto.
- **Como corrigir:** renomeie o arquivo para `proxy.ts` e a função exportada para `proxy`.
- **Exemplo:** `middleware.ts uses the middleware convention, which Next.js 16 renamed to proxy`
