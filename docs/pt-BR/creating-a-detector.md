# Criando um detector

[English](../creating-a-detector.md) | **Português (Brasil)**

A maioria das contribuições cai em um de três tamanhos. Comece pelo menor que resolver.

| Você quer que o RepoLens… | Mudança |
| --- | --- |
| reconheça outro framework, test runner, linter, ferramenta de build ou ORM | adicione uma entrada em uma tabela ([1](#1-adicione-uma-entrada-de-tabela)) |
| identifique outro problema de configuração do ambiente | adicione uma regra do doctor ([2](#2-adicione-uma-regra-do-doctor)) |
| entenda um novo tipo de arquivo ou produza uma nova seção | escreva um detector ([3](#3-escreva-um-detector)) |

Seja qual for a mudança, as [regras básicas](../../CONTRIBUTING.pt-BR.md#regras-básicas)
valem: leia arquivos só através do `ctx`, nunca execute nada, nunca exiba valores de
segredos e reporte a confiança com honestidade.

## 1. Adicione uma entrada de tabela

O conhecimento sobre frameworks, ferramentas e bancos de dados fica em tabelas de dados,
então reconhecer uma nova tecnologia normalmente leva poucas linhas.

**Frameworks**: `FRAMEWORKS` em
[`src/detectors/frameworks.ts`](../../src/detectors/frameworks.ts):

```ts
{
  id: 'sveltekit',                 // id estável, também usado por Route.framework
  name: 'SvelteKit',               // nome de exibição
  category: 'fullstack',           // frontend | backend | fullstack | static-site | mobile | desktop | library
  ecosystem: 'node',               // node | go
  dependencies: ['@sveltejs/kit'], // pacotes npm ou caminhos de módulos Go
  configs: [`svelte.config.${JS}`],
},
```

A confiança depende de onde o sinal é encontrado: uma dependência de runtime (com ou sem o
arquivo de configuração dela) é `high`, só uma devDependency ou um arquivo de configuração
sem a dependência é `medium`, e só uma peer dependency é `low`. A ordem na tabela é a ordem
de exibição dentro de uma categoria.

**Test runners, linters, formatters e ferramentas de build**: `TEST_TOOLS` em
`src/detectors/testing.ts`, `LINT_TOOLS` em `src/detectors/linting.ts` e `BUILD_TOOLS`
em `src/detectors/build.ts`, todos usando `ToolSpec` de
[`src/detectors/knowledge/tools.ts`](../../src/detectors/knowledge/tools.ts):

```ts
{
  id: 'vitest',
  name: 'Vitest',
  kind: 'test',
  dependencies: ['vitest'],
  bins: ['vitest'],               // permite que `vitest --config x.ts` em um script aponte para a config
  configs: [`vitest.config.${JS}`, `vitest.workspace.${JS}`],
},
```

`ToolSpec` também suporta `dependencyPrefixes` (`@testing-library/`), `packageJsonFields`
(`"prettier": {…}`), matchers de `scripts` (`node --test`) e sinais de Python
(`pythonPackages`, `pyprojectTables`).

**Bancos de dados, drivers, ORMs e imagens Docker**:
[`src/detectors/knowledge/databases.ts`](../../src/detectors/knowledge/databases.ts)
(`NODE_DRIVERS`, `GO_DRIVERS`, `ORMS` e os mapas de valores de Prisma/Drizzle/sqlc/TypeORM) e
[`src/detectors/knowledge/images.ts`](../../src/detectors/knowledge/images.ts) (`IMAGE_RULES`:
imagem do Compose → tecnologia e tipo de serviço).

**Arquivos de configuração** exibidos na lista "Key files": `CONFIG_FILES` em
`src/detectors/config-files.ts`.

Depois, adicione um teste. O arquivo de teste que já existe para aquele detector mostra o
padrão: monte um projeto mínimo inline e faça asserções sobre o que o detector reporta.

```ts
it('detects SvelteKit from its dependency and config', async () => {
  const ctx = await contextFor(
    await makeProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@sveltejs/kit': '^2.8.0' } }),
      'svelte.config.js': 'export default {}',
    }),
  )
  const frameworks = await ctx.use(frameworksDetector)
  expect(frameworks.find((f) => f.id === 'sveltekit')).toMatchObject({ confidence: 'high', version: '2.8.0' })
})
```

Por fim, adicione a tecnologia à tabela de tecnologias suportadas no README.

## 2. Adicione uma regra do doctor

As regras do doctor ficam em [`src/doctor/rules/`](../../src/doctor/rules/), agrupadas por
categoria. Uma regra é pequena: ela lê as seções detectadas (e, se precisar, arquivos em
cache através do `ctx`) e devolve diagnósticos.

```ts
import { manifests } from '../../facts/manifests.ts'
import type { Diagnostic, DoctorRule } from '../../types.ts'

/** Lógica pura: fácil de testar unitariamente com entrada montada à mão. */
export function findTestPlaceholder(scripts: Readonly<Record<string, string>>): Diagnostic[] {
  const test = scripts.test
  if (test === undefined || !/no test specified/.test(test)) return []
  return [
    {
      code: 'SCRIPT_TEST_PLACEHOLDER',  // estável, UPPER_SNAKE, nunca renomeado depois de lançado
      severity: 'info',                 // error | warning | info
      category: 'scripts',
      message: 'The "test" script in package.json is the npm placeholder that always fails',
      hint: 'Replace it with a real test command or remove it',
      files: ['package.json'],
      subject: 'test',
    },
  ]
}

export const scriptTestPlaceholder: DoctorRule = {
  code: 'SCRIPT_TEST_PLACEHOLDER',
  category: 'scripts',
  title: 'The test script runs real tests', // escrito como o estado em que a regra passa
  applies: (scan) => scan.project.manifests.includes('package.json'), // false → "skipped"
  async check(scan, ctx) {
    const project = await ctx.use(manifests)
    return project.root ? findTestPlaceholder(project.root.scripts) : []
  },
}
```

Depois:

1. Adicione a regra à lista de regras da categoria dela (ex.: `scriptRules` em
   `src/doctor/rules/scripts.ts`), que `src/doctor/rules/index.ts` combina em `doctorRules`.
   A saída é agrupada por categoria; dentro de uma categoria, a ordem da lista é a ordem de
   exibição. Uma regra que lê `ctx.warnings` define `final: true` para rodar depois das
   outras.
2. Documente a regra em [`docs/diagnostics.md`](../diagnostics.md): uma linha na tabela de
   resumo e uma seção `### \`CODE\``. Um teste falha se algum código estiver faltando na
   documentação. Adicione a mesma seção à tradução em
   [`docs/pt-BR/diagnostics.md`](diagnostics.md).
3. Teste as duas direções: um projeto que dispara a regra e um que não dispara.
   `makeSections()` em `test/factories.ts` monta a entrada sem analisar nada.

Diretrizes:

- **Falsos positivos são piores do que deixar algo passar.** Quando uma regra não tiver
  certeza, use `info` ou não reporte nada.
- Um diagnóstico por alvo (por variável, por arquivo, por porta), com `subject` preenchido.
- As mensagens citam os arquivos e valores envolvidos, mas **nunca valores de segredos**, e
  as dicas trazem uma correção concreta. Coloque entre aspas os caminhos do repositório
  dentro de comandos sugeridos (`shellQuote`).

## 3. Escreva um detector

Um detector produz uma seção do resultado da análise (`Sections` em
[`src/types.ts`](../../src/types.ts)). Detectores são `Analyzer`s: `ctx.use(detector)`
executa cada um no máximo uma vez por análise, então um detector pode depender de outro só
aguardando (`await`) o resultado dele.

```ts
import type { Detector } from '../types.ts'

export const exampleDetector: Detector<'example'> = {
  id: 'example',
  title: 'Example',
  async run(ctx) {
    // 1. Encontre os arquivos candidatos pelo índice (sem percorrer diretórios por conta própria).
    const files = ctx.files.byName('example.config.json')
    // 2. Leia através do ctx: confinamento à raiz, verificações de links simbólicos, limites de tamanho,
    //    cache e avisos de erro de parse são tratados para você. Entrada malformada retorna null.
    const configs = await Promise.all(files.map((file) => ctx.readJson(file)))
    // 3. Coloque a lógica em funções puras e exportadas e escreva testes unitários para elas.
    return inferExample(configs)
  },
}
```

Blocos de construção úteis:

| | |
| --- | --- |
| `ctx.files` | `has`, `byName`, `byExtension`, `glob`, `isIgnored`; `ignoredFiles` guarda arquivos ignorados pelo Git, como o `.env` |
| `ctx.readText` / `readJson` / `readJsonc` / `readYaml` | leituras seguras e em cache; passe `{ cache: false }` ao analisar muitos arquivos-fonte |
| `ctx.use(manifests)` | arquivos package.json parseados (raiz, workspace, aninhados), declarações de workspace, módulos Go |
| `ctx.use(dependencies)` | toda dependência declarada: `has`, `get`, `withPrefix`, `inPackage`, `version`, `packagesWith` |
| `ctx.use(sourceFiles)` | arquivos-fonte que valem a leitura para análise de conteúdo, cada um com o pacote a que pertence |
| `ctx.warn` / `ctx.debug` | problemas não fatais (exibidos na saída detalhada e em `meta.warnings`) e logs de debug |
| `src/utils/redact.ts` | `redactCommand`, `sanitizeUrl`, `isSensitiveName` para tudo o que for reproduzido a partir de arquivos |

Para adicionar uma **nova seção**, adicione o tipo dela a `Sections` em `src/types.ts` (uma
mudança aditiva, que não quebra compatibilidade), o valor vazio dela a `src/core/empty.ts` e
o detector ao registro em `src/detectors/index.ts`. O compilador então aponta todos os
lugares que precisam saber da nova seção. Renderize a seção em `src/output/terminal/`,
`src/output/markdown.ts` e, se for útil para agentes, em `src/agent/`, e documente-a em
[json-schema.md](json-schema.md).

### Testando um detector

- Faça testes unitários das funções puras com dados simples.
- Teste o detector de ponta a ponta em um projeto inline (`makeProject` + `contextFor`) ou em
  uma cópia de uma fixture (`fixtureContext('nuxt-app')`). Nunca analise `test/fixtures/`
  diretamente no lugar.
- Inclua entrada malformada: JSON/YAML inválido, tipos errados (`"scripts": []`), arquivos
  vazios.
- Se o seu detector lê qualquer coisa que possa conter segredos, verifique com uma asserção
  que o sentinela de fixture `SECRET_SENTINEL` nunca aparece na saída dele.
- Se você adicionar uma fixture, documente-a em `test/fixtures/README.md` e siga as regras no
  topo desse arquivo.

Rode `pnpm check` antes de abrir o pull request. Obrigado por contribuir!
