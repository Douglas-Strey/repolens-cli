# Desenvolvimento

[English](../development.md) | **Português (Brasil)**

## Preparação do ambiente

Você precisa do Node.js 24 (veja o `.nvmrc`; o Node 22.18+ também funciona) e do pnpm. A
versão do pnpm está fixada no `package.json` (`packageManager`): instale com
`npm install -g pnpm@11` ou com `corepack enable`, se você tiver o Corepack (ele não vem mais
junto com o Node.js 25+).

```sh
git clone https://github.com/Douglas-Strey/repolens-cli.git
cd repolens-cli
pnpm install
git config core.hooksPath .githooks   # hook de commit-msg (remove trailers de atribuição de IA)
pnpm test
pnpm dev -- ../some-project        # roda a CLI a partir do código-fonte em qualquer diretório
```

`pnpm dev` roda `src/cli.ts` diretamente, com o suporte nativo do Node a TypeScript. Não há
etapa de build nem watcher para deixar rodando.

## Scripts

| Script | O que faz |
| --- | --- |
| `pnpm dev -- [args]` | Roda a CLI a partir do código-fonte, ex.: `pnpm dev -- doctor ../app --verbose`. |
| `pnpm test` | Roda a suíte de testes uma vez (Vitest). |
| `pnpm test:watch` | Roda os testes de novo a cada mudança. |
| `pnpm coverage` | Testes com relatório de cobertura em `coverage/`. |
| `pnpm lint` | Lint e checagem de formatação (Biome). `pnpm lint:fix` corrige o que conseguir. |
| `pnpm typecheck` | Checagem de tipos de tudo (TypeScript, sem gerar arquivos). |
| `pnpm build` | Compila `src/` para `dist/`. |
| `pnpm bench [path]` | Mede o tempo de análises de um diretório (padrão: este repositório). `--generate <n>` faz o benchmark de um monorepo sintético com `n` pacotes. |
| `pnpm check` | Lint, typecheck e testes, que é o que o CI roda. |

## Estrutura do projeto

```
src/
  cli.ts              entrada do bin (mantenha mínima)
  cli/                parsing de argumentos, texto de ajuda, despacho de comandos, códigos de saída
  core/               walker, índice de arquivos, leitura segura de arquivos, parsing, orquestração da análise
  config/             arquivos de configuração: carregamento, validação, mesclagem
  facts/              analisadores compartilhados: manifests, índice de dependências, arquivos-fonte, Git
  detectors/          um detector por seção do resultado da análise
  doctor/             executor e regras do doctor (rules/*.ts)
  output/             renderizadores de terminal, Markdown e JSON
  agent/              gerador do contexto para agentes em .repolens/
  utils/              helpers pequenos (caminhos, globs, mascaramento, versões)
  types.ts            todos os tipos públicos; o contrato da saída JSON
  index.ts            API programática
test/
  fixtures/           repositórios pequenos e realistas (veja fixtures/README.md)
  helpers.ts          copyFixture, makeProject, runCli, gitInit, …
  factories.ts        resultados de análise montados à mão para testes de renderizadores e do doctor
docs/                 documentação para usuários e contribuidores
schema/               JSON Schema dos arquivos de configuração (distribuído no pacote)
scripts/              benchmark, helpers de release, gerador de screenshots
```

Veja [architecture.md](architecture.md) para entender como as peças se encaixam e
[creating-a-detector.md](creating-a-detector.md) para adicionar suporte a uma tecnologia.

## Testes

- **Detectores** são testados contra cópias das fixtures em `test/fixtures/` e contra
  projetos pequenos montados inline com `makeProject({ 'package.json': '…' })`.
- **Renderizadores** são testados com arquivos de snapshot gerados a partir de
  `test/factories.ts`. Quando você mudar a saída de propósito, atualize os snapshots com
  `pnpm vitest run -u` e revise o diff.
- **Comportamento de segurança** tem testes dedicados: valores sentinela de segredos nas
  fixtures nunca podem aparecer em nenhuma saída, links simbólicos não conseguem escapar da
  raiz, FIFOs não travam a análise e o binário `git` nunca é executado.
- Os testes sempre analisam uma **cópia** da fixture em um diretório temporário, para que o
  `.git` deste repositório nunca vaze para os resultados.

Alguns testes criam links simbólicos, FIFOs ou arquivos sem permissão de leitura. Eles são
pulados automaticamente nas plataformas que não dão suporte a isso (por exemplo, FIFOs no
Windows).

## Depuração

```sh
pnpm dev -- ../app --verbose                  # evidências, achados de baixa confiança, erros de parser
REPOLENS_DEBUG=1 pnpm dev -- ../app --json    # também tempos por detector e arquivos pulados no stderr
pnpm dev -- ../app --json | jq .meta
```

As linhas de debug vão para o stderr, então ficam separadas da saída de `--json`.

## Publicando versões

1. Atualize o `CHANGELOG.md` (mova os itens de "Unreleased" para uma nova seção de versão).
2. Suba a versão: `npm version <patch|minor|major> --no-git-tag-version` e depois faça o
   commit.
3. Crie a tag e faça o push: `git tag v1.2.3 && git push origin main --tags`.

O [workflow de release](../../.github/workflows/release.yml) roda a suíte completa de
verificações e publica no npm com **trusted publishing** (OIDC, com provenance). Nenhum token
do npm fica guardado no repositório. Em seguida, ele cria uma release no GitHub a partir da
seção do changelog.

Antes da primeira release automatizada, o pacote precisa existir no npm e ter um trusted
publisher configurado. Publique a primeira versão manualmente (`npm publish --access public`)
e depois, no npmjs.com, abra as configurações do pacote, escolha
**Trusted publisher → GitHub Actions** e informe o repositório (`Douglas-Strey/repolens-cli`),
o arquivo do workflow (`release.yml`) e o ambiente (`npm`). Depois, faça o push da tag dessa
versão normalmente: o workflow vê que a versão já está no npm, pula a publicação e ainda
cria a release no GitHub e atualiza o tap do Homebrew.

### Homebrew

`brew install douglas-strey/tap/repolens` instala a partir do repositório
[`Douglas-Strey/homebrew-tap`](https://github.com/Douglas-Strey/homebrew-tap).
A fórmula instala o tarball publicado no npm com o Node.js do Homebrew, que é o padrão para
CLIs em Node. Quem gera a fórmula é o `scripts/homebrew-formula.ts`:

```sh
node scripts/homebrew-formula.ts 0.1.0                        # calcula o hash do tarball no npm
node scripts/homebrew-formula.ts 0.1.0 --tarball repolens-cli-0.1.0.tgz   # antes de publicar
```

O job `homebrew` do workflow de release regenera `Formula/repolens.rb` no tap e faz o push
dele depois de cada release no npm. Configuração, feita uma única vez:

1. Crie o repositório público `Douglas-Strey/homebrew-tap` com um diretório `Formula/`
   vazio. O prefixo `homebrew-` é o que faz `douglas-strey/tap` funcionar.
2. Crie um personal access token do tipo fine-grained, limitado a esse repositório, com
   **Contents: read and write**, e defina uma data de expiração para ele.
3. Adicione o token a este repositório como o segredo do Actions `HOMEBREW_TAP_TOKEN`
   (ambiente `npm`). Sem o segredo, o job é pulado e a fórmula pode ser atualizada
   manualmente com o script acima.

Quando o projeto atender aos requisitos de notabilidade do Homebrew, a mesma fórmula poderá
ser submetida ao `homebrew-core`.
