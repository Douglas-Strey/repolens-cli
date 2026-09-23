# Contribuindo com o RepoLens

[English](CONTRIBUTING.md) | **Português (Brasil)**

Obrigado por ajudar! O RepoLens melhora toda vez que alguém ensina a ele um framework, um
arquivo de configuração ou um erro de setup que ele ainda não conhecia.

## Formas de ajudar

- **Pegue um item do [roadmap](ROADMAP.pt-BR.md).** Cada um diz por onde começar e qual o
  tamanho do trabalho.
- **Teste nos seus repositórios** e [abra uma issue](https://github.com/Douglas-Strey/repolens-cli/issues/new/choose)
  quando ele errar alguma coisa. Uma detecção errada é um bug, e uma que faltou é um pedido de detector.
- **Adicione ou melhore um detector.** Veja [docs/pt-BR/creating-a-detector.md](docs/pt-BR/creating-a-detector.md);
  a maioria das adições é uma entrada numa tabela mais um teste.
- **Adicione uma verificação ao doctor** para um problema de setup que fez você perder tempo.
- **Melhore a documentação.** Se algo confundiu você, vai confundir outras pessoas.

## Ambiente de desenvolvimento

```sh
git clone https://github.com/Douglas-Strey/repolens-cli.git
cd repolens-cli
pnpm install
git config core.hooksPath .githooks
pnpm test
pnpm dev -- ../some-project
```

Você precisa do Node.js 24 (Node 22.18+ funciona) e do pnpm 11 (`npm install -g pnpm@11`; a
versão exata está fixada no `package.json`). O [docs/pt-BR/development.md](docs/pt-BR/development.md)
cobre os scripts, a estrutura do projeto e a depuração.

## Regras básicas

Elas mantêm o RepoLens confiável em repositórios não confiáveis. PRs que as violam não podem
ser mergeados, por mais úteis que sejam em outros aspectos.

1. **Só análise estática.** Nunca execute código do projeto, arquivos de configuração,
   scripts, `git`, Docker ou comandos de shell. Leia arquivos por meio de `ctx.readText` /
   `readJson` / `readJsonc` / `readYaml`.
2. **Nunca exiba valores de segredos.** Variáveis de ambiente são reportadas pelo nome. Tudo
   o que for reproduzido de arquivos commitados passa pelos helpers de `src/utils/redact.ts`.
3. **Prefira deixar algo passar a gerar um falso positivo.** Use `confidence` com honestidade
   e preencha `evidence`. Achados de baixa confiança ficam ocultos por padrão.
4. **Saída determinística.** Coleções ordenadas, sem timestamps, sem caminhos absolutos.
5. **Nenhuma dependência de runtime nova** sem antes discutir em uma issue.

## Pull requests

- Mantenha os PRs focados: o ideal é um detector, uma verificação ou uma correção por PR.
- Adicione testes. Lógica de detecção precisa de uma fixture ou de um projeto de teste
  inline, e mudanças na saída precisam de snapshots atualizados (`pnpm vitest run -u`, depois
  revise o diff).
- Rode `pnpm check` (lint + typecheck + testes) antes de dar push. O CI roda lint e
  typecheck no Linux e os testes no Linux, macOS e Windows com Node.js 22, 24 e 26.
- Atualize a documentação quando o comportamento mudar: `docs/json-schema.md` para a saída
  JSON, `docs/diagnostics.md` para as verificações do doctor e a tabela de tecnologias
  suportadas no README para novos detectors.
- Adicione uma linha em **Unreleased** no `CHANGELOG.md` para mudanças visíveis ao usuário.
- Mensagens de commit: um assunto curto no imperativo ("Detect SvelteKit routes"), mais um
  corpo explicando o *porquê* quando não for óbvio. Não adicione trailers de atribuição a IA;
  o hook `commit-msg` em `.githooks/` remove esses trailers.

## Traduções

A documentação está disponível em inglês e em português do Brasil (`README.pt-BR.md`,
`CONTRIBUTING.pt-BR.md`, `SECURITY.pt-BR.md`, `ROADMAP.pt-BR.md` e `docs/pt-BR/`). O inglês é a fonte da
verdade. Se você alterar um documento que tem tradução, atualize a tradução no mesmo PR, se
puder; se não puder, avise no PR e ela será atualizada separadamente. Código, comandos,
exemplos de JSON e códigos de diagnóstico nunca são traduzidos, e um teste verifica se todo
documento tem uma tradução com os mesmos exemplos de código.

## Garantias de estabilidade

- Códigos de diagnóstico (`ENV_UNDOCUMENTED`, …) nunca são renomeados nem reutilizados.
- Dentro de uma `schemaVersion`, a saída JSON só ganha campos opcionais. Remover ou alterar
  um campo exige uma nova versão do schema.

## Código de conduta

Este projeto segue o [Contributor Covenant](CODE_OF_CONDUCT.md). Seja gentil; presuma
boa-fé.

## Problemas de segurança

Por favor, não abra issues públicas para vulnerabilidades. Veja o
[SECURITY.pt-BR.md](SECURITY.pt-BR.md).
