# Roadmap

[English](ROADMAP.md) | **Português (Brasil)**

O RepoLens 0.2 cobre JavaScript/TypeScript e Go em profundidade: a visão geral, 34
verificações no doctor, o `repolens setup`, saída para terminal, JSON, Markdown e agentes, e
arquivos de configuração. Esta página lista o que vem a seguir, com detalhe suficiente para você pegar
um item e começar.

**Quer trabalhar em algo?** Cada item abaixo tem um link para a sua issue, e o
[quadro do roadmap](https://github.com/users/Douglas-Strey/projects/1) mostra o que vem a seguir, o que está em
andamento e o que já foi feito. Comente na issue dizendo que vai pegar o item, para que duas
pessoas não construam a mesma coisa (ideias de itens novos vão nas
[Discussions](https://github.com/Douglas-Strey/repolens-cli/discussions)). Depois leia o
[CONTRIBUTING.pt-BR.md](CONTRIBUTING.pt-BR.md) e o
[docs/pt-BR/creating-a-detector.md](docs/pt-BR/creating-a-detector.md). As regras básicas
de lá não são negociáveis: só análise estática, nenhum valor secreto em nenhuma saída,
resultados determinísticos.

Os tamanhos são aproximados: **P** é uma tarde, **M** algumas noites, **G** um trabalho
maior, melhor dividido em vários PRs.

## Boas primeiras contribuições

Mudanças pequenas e independentes, em geral uma entrada de tabela mais um teste.

- **Arquivos de configuração e ferramentas que faltam (P, [#1](https://github.com/Douglas-Strey/repolens-cli/issues/1)).** Se o RepoLens não reconhece um
  arquivo de configuração ou uma ferramenta que o seu projeto usa, adicione em
  `src/detectors/config-files.ts` ou `src/detectors/knowledge/tools.ts`, com um teste em
  `test/detectors/`.
- **Variáveis de plataforma (P, [#2](https://github.com/Douglas-Strey/repolens-cli/issues/2)).** Variáveis que uma plataforma de hospedagem define sozinha
  (como `RENDER_*` ou `FLY_*`) nunca devem ser reportadas como não documentadas. Adicione as
  que faltam em `PLATFORM_NAMES` / `PLATFORM_PREFIXES` em `src/doctor/rules/environment.ts`.
- **Formatos de credencial (P, [#3](https://github.com/Douglas-Strey/repolens-cli/issues/3)).** O `ENV_EXAMPLE_REAL_SECRET` reconhece credenciais de AWS,
  GitHub, GitLab, npm, Slack, Stripe, OpenAI, Anthropic, Google e SendGrid, além de chaves
  privadas. Novos formatos vão em `CREDENTIAL_PATTERNS` (`src/utils/redact.ts`). Os padrões
  precisam ser limitados (sem backtracking catastrófico; há um teste para isso), e os tokens
  de teste precisam ser montados em tempo de execução, nunca commitados.
- **Frameworks que ainda não têm rotas (M).** SvelteKit, Remix / React Router e Astro são
  detectados, mas as rotas deles não são listadas. Todos usam roteamento por arquivos, como
  os extratores de Nuxt e Next.js que já existem em `src/detectors/routes/nuxt.ts` e
  `next.ts`:
  - SvelteKit ([#4](https://github.com/Douglas-Strey/repolens-cli/issues/4)): `src/routes/**/+page.svelte` (páginas) e `+server.ts` (endpoints, uma função
    exportada por método HTTP).
  - Remix / React Router 7 ([#5](https://github.com/Douglas-Strey/repolens-cli/issues/5)): as convenções de arquivos de `app/routes/`.
  - Astro ([#6](https://github.com/Douglas-Strey/repolens-cli/issues/6)): `src/pages/**/*.astro` (páginas) e `src/pages/**/*.{ts,js}` (endpoints).

## A seguir

### Mais linguagens (G)

Hoje as outras linguagens só ganham contagem de arquivos, alvos de Makefile/justfile, CI e as
verificações genéricas. Cada ecossistema abaixo precisa das mesmas peças que o suporte a
JavaScript e Go já tem: gerenciador de pacotes e lockfile, versões fixadas do runtime,
frameworks, rotas, uso de variáveis de ambiente, scripts e verificações do doctor onde fizer
sentido. Uma linguagem por série de PRs; comece pela detecção (gerenciador de pacotes,
runtime, frameworks) e adicione as rotas depois.

- **Python ([#7](https://github.com/Douglas-Strey/repolens-cli/issues/7)):** uv (`uv.lock`), Poetry, Pipenv e pip (`requirements*.txt`); runtime a partir de
  `.python-version`, `requires-python` e `.tool-versions`; Django, Flask e FastAPI; rotas a
  partir dos decorators do FastAPI/Flask e do `urls.py` do Django; uso de variáveis de
  ambiente via `os.environ` / `os.getenv` e pydantic-settings. O
  `src/detectors/knowledge/python.ts` já lê `requirements*.txt`, `pyproject.toml` e
  `Pipfile` (para ferramentas como pytest e Ruff) e é o ponto de partida.
- **Rust ([#8](https://github.com/Douglas-Strey/repolens-cli/issues/8)):** `Cargo.toml` e `Cargo.lock`, workspaces do Cargo, `rust-toolchain.toml`; rotas de
  Axum, Actix Web e Rocket; uso de `std::env::var`.
- **PHP ([#9](https://github.com/Douglas-Strey/repolens-cli/issues/9)):** `composer.json` e `composer.lock`; Laravel (`routes/web.php`, `routes/api.php`) e
  Symfony.

### `repolens mcp`: um servidor MCP (M)

Issue [#10](https://github.com/Douglas-Strey/repolens-cli/issues/10).

Expor a análise para assistentes de IA como ferramentas MCP via stdio. A API interna já se
encaixa nas ferramentas (veja "Pronto para MCP" em
[docs/pt-BR/architecture.md](docs/pt-BR/architecture.md)), então o comando é um adaptador
fino sobre o `scan()`. O RepoLens tem três dependências de runtime, e adicionar uma precisa
de discussão: antes de começar, abra uma issue sobre usar o SDK oficial ou uma
implementação pequena de JSON-RPC.

### Configuração: ignorar um achado específico (M)

Issue [#11](https://github.com/Douglas-Strey/repolens-cli/issues/11).

O `doctor.rules` desliga uma verificação inteira. Os projetos também precisam silenciar um
achado só (uma variável, um arquivo) e manter a verificação. Formato proposto:

```json
{ "doctor": { "ignore": [{ "code": "ENV_UNDOCUMENTED", "subject": "LEGACY_TOKEN" }] } }
```

Precisa seguir as regras de [docs/pt-BR/configuration.md](docs/pt-BR/configuration.md): o
arquivo do próprio projeto não pode esconder achados de segurança, e a saída diz quantos
achados foram ignorados. Mexe em `src/config/`, `src/doctor/index.ts`,
`schema/config.schema.json` e na documentação nos dois idiomas.

### Melhorias menores (P–M)

- **`include:` e `extends:` do Compose, `include:` do GitLab CI ([#12](https://github.com/Douglas-Strey/repolens-cli/issues/12)).** Seguir os includes locais
  (nunca URLs) para que serviços e jobs de CI definidos em outros arquivos apareçam.
  `src/facts/compose.ts`, `src/detectors/ci.ts`.
- **Procurar a configuração a partir de um subdiretório ([#13](https://github.com/Douglas-Strey/repolens-cli/issues/13)).** Ao analisar `apps/web`, ler
  também o `repolens.config.json` da raiz do repositório, do jeito que o `.git` já é
  encontrado acima do diretório analisado. `src/config/load.ts`.
- **`.gitignore` dos diretórios pai e `core.excludesFile` ([#14](https://github.com/Douglas-Strey/repolens-cli/issues/14)).** Ao analisar um subdiretório de
  um repositório, aplicar os arquivos de ignore acima dele, ainda sem rodar o `git`.
  `src/core/walker.ts`.
- **homebrew-core ([#15](https://github.com/Douglas-Strey/repolens-cli/issues/15)).** Enviar a fórmula para que `brew install repolens` funcione sem o tap,
  quando o projeto atender aos requisitos de notoriedade do Homebrew.

## Mais adiante

- **API de plugins** ([#16](https://github.com/Douglas-Strey/repolens-cli/issues/16)) para detectors de terceiros (`@repolens/detector-*`). Precisa de uma
  interface de detector estável e de um modelo de confiança: plugins executam código, as
  análises nunca executam.
- **Grafos de arquitetura e de dependências** ([#17](https://github.com/Douglas-Strey/repolens-cli/issues/17)), por exemplo uma saída em Mermaid dos pacotes do
  workspace e dos serviços com que eles falam.
- **Extensões para editores** ([#18](https://github.com/Douglas-Strey/repolens-cli/issues/18)) construídas sobre o `repolens --json`.
- **Saída da CLI traduzida ([#19](https://github.com/Douglas-Strey/repolens-cli/issues/19)).** A documentação está em inglês e português; a CLI só fala
  inglês. Precisa de um catálogo de mensagens; os códigos de diagnóstico e a saída JSON
  continuam iguais.

## Fora dos planos

Qualquer coisa que quebre as regras básicas: executar código do projeto ou o `git`, fazer
upload de qualquer coisa, telemetria, ou exigir uma API de IA.
