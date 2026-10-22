# Modelo de segurança

[English](../security.md) | **Português (Brasil)**

O RepoLens foi feito para ser a primeira coisa que você roda em um repositório que ainda não
conhece. Isso só funciona se rodá-lo for seguro, então as regras abaixo são restrições
rígidas, não metas. Violar qualquer uma delas é um bug de segurança; por favor,
[reporte de forma privada](../../SECURITY.pt-BR.md). Elas valem para todos os comandos,
exceto o `repolens setup`, cujo trabalho é executar o setup do projeto e que tem regras
próprias ([7](#7-o-repolens-setup-executa-só-o-que-mostra-para-você)).

## Garantias

### 1. O RepoLens nunca executa nada do repositório

- Nenhum script do `package.json`, hook de ciclo de vida, target de Makefile ou comando de
  shell.
- Nenhum arquivo de configuração JavaScript ou TypeScript é importado ou avaliado.
  `nuxt.config.ts`, `next.config.mjs`, `vite.config.ts` e companhia são lidos como texto e
  analisados com padrões conservadores.
- **O RepoLens não roda o binário `git`.** A configuração do Git no nível do repositório
  pode fazer o `git` executar programas arbitrários (`core.fsmonitor`, `core.pager`, drivers
  de diff/merge, filtros), então a branch, o HEAD, os remotes e a lista de arquivos
  rastreados são lidos direto de `.git/HEAD`, `.git/config`, `packed-refs` e do arquivo
  binário `.git/index`. Existe um teste que planta um comando em `core.fsmonitor` e confirma
  que ele nunca roda.
- Nenhuma chamada a Docker ou banco de dados, e nenhuma chamada de rede a menos que você
  peça a consulta de dependências ([8](#8-a-rede-só-é-usada-com-o-repolens-doctor---online)).
  Arquivos Compose e Dockerfiles são parseados; nada é iniciado nem contatado.

### 2. Valores de segredos nunca chegam à saída

- Arquivos no estilo `.env` são processados por um parser dedicado (`src/core/dotenv.ts`)
  que guarda só o **nome** da variável e alguns fatos derivados: se o valor está vazio, o
  scheme da URL, a porta e se o host é local (usado para detectar portas que não batem). O
  valor em si é descartado dentro do parser e nunca é armazenado, registrado em log nem
  lançado em um erro.
- Blocos `environment:` do Docker Compose contribuem só com nomes.
- Arquivos de exemplo como `.env.example` são comparados com formatos conhecidos de
  credenciais (chaves da AWS, tokens do GitHub/GitLab/npm, chaves live do Stripe, chaves
  privadas, …). Uma correspondência é reportada como "`.env.example` contains what looks
  like a real credential in `NAME`", nunca com o valor.
- O texto que o RepoLens reproduz a partir de arquivos commitados (scripts do package.json,
  intervalos de versão das dependências, remotes do Git) passa por mascaramento: credenciais
  em URLs, atribuições `SECRET_NAME=value`, opções `--password`/`--token` e formatos de
  token conhecidos são substituídos por `***`.
- A suíte de testes analisa fixtures em que todos os valores de segredos contêm uma string
  sentinela e confirma que essa sentinela não aparece em nenhum formato de saída (terminal,
  JSON, Markdown, arquivos de agente).

### 3. O RepoLens só lê dentro do diretório que você indicar

- Todo arquivo do projeto é lido por uma única função (`readTextWithin` em
  `src/core/fs.ts`) que rejeita caminhos absolutos e travessia com `..` e resolve o caminho
  **real** (seguindo links simbólicos, inclusive diretórios pais que são links simbólicos)
  antes de conferir se ele continua dentro da raiz do projeto.
- O código que percorre os diretórios nunca segue links simbólicos de diretório, então
  loops de links simbólicos não conseguem prendê-lo e links não conseguem levá-lo para fora
  da raiz. Links simbólicos de arquivo só são indexados quando resolvem para um arquivo
  regular dentro da raiz.
- **Uma exceção deliberada:** quando você analisa um subdiretório de um repositório Git, o
  RepoLens procura para cima o diretório `.git` que o contém (como o próprio `git` faria)
  para reportar a branch e os arquivos rastreados, e usa o índice do Git para ver quais
  lockfiles existem nos diretórios acima (para dizer onde rodar o `install`). Lá ele só lê
  arquivos de metadados do Git. Um *arquivo* `.git` (worktrees vinculadas, submódulos) só é
  seguido quando o diretório Git que ele indica aponta de volta para este checkout, então um
  arquivo `.git` forjado não consegue fazer o RepoLens reportar outro repositório da sua
  máquina.
- **Uma segunda exceção:** nesse caso, o RepoLens também lê a configuração da raiz do
  repositório (`repolens.config.json`, ou a chave `"repolens"` do `package.json` dela), para
  que as configurações compartilhadas de um monorepo valham no pacote que você analisa. Ele
  lê só esses dois arquivos, só na raiz do repositório que contém a pasta, com as mesmas
  proteções de qualquer arquivo do projeto: o caminho precisa ficar dentro do repositório
  (um link que leve para fora é recusado), e o arquivo tem os limites de uma configuração do
  projeto (§5).
- **Uma terceira exceção:** as regras de ignore do Git também vêm de fora do diretório
  analisado, então o RepoLens as lê onde o Git lê: o `.gitignore` de cada diretório entre a
  raiz do repositório e o diretório analisado, e o `info/exclude` do repositório. Um
  `.gitignore` ali precisa ser um arquivo regular (o Git também não segue um que seja link
  simbólico), e o `info/exclude` não pode levar para fora do diretório Git. A CLI também
  aplica o seu arquivo global de exclusões: o `core.excludesFile` da sua própria
  configuração do Git (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` ou
  `$GIT_CONFIG_GLOBAL`), ou então `~/.config/git/ignore`. O próprio `.git/config` de um
  repositório não pode escolher esse arquivo: ele poderia apontar para qualquer arquivo da
  sua máquina. Todos eles têm os limites dos arquivos `.gitignore` (§4) e, quando
  ignorariam o próprio diretório analisado, ficam de fora, para que a análise continue
  mostrando o que há nele.
- **As ferramentas do `repolens mcp`** recebem um `path` que precisa ficar dentro do
  diretório para o qual o servidor foi iniciado: caminhos absolutos, `..` e links que levam
  para fora dele são recusados, então um assistente (ou instruções injetadas nele) não
  consegue apontar o RepoLens para outros diretórios da sua máquina. As respostas seguem
  todas as regras desta página: variáveis de ambiente só pelo nome, sem caminhos absolutos.

### 4. Entradas hostis não conseguem travar nem esgotar o RepoLens

| Entrada | Proteção |
| --- | --- |
| Arquivos enormes | Arquivos acima de 1 MiB são ignorados (arquivos-fonte analisados em busca de rotas/uso de env: 512 KiB). |
| Arquivos binários | Ignorados quando aparece um byte NUL nos primeiros 8 KB. |
| FIFOs, sockets, dispositivos | Nunca são abertos para leitura (verificação com `stat` mais `O_NONBLOCK` em POSIX). |
| Repositórios enormes | A indexação para em 100.000 arquivos (`--max-files`) e 20 níveis de diretório, e avisa que a análise está incompleta. |
| Bombas de alias em YAML | Documentos que se expandiriam para mais de 1.000.000 de nós, que têm aninhamento profundo demais ou que usam aliases recursivos são rejeitados. |
| Arquivos `.gitignore` hostis | No máximo 2.000 regras de ignore se aplicam a um mesmo caminho e 50.000 no total (com um aviso); o casamento de globs roda em tempo linear. |
| JSON/YAML/JSONC malformado | Reportado como aviso; o restante da análise continua. As mensagens do parser informam linha e coluna, nunca o conteúdo do arquivo. |
| Arquivos-fonte patológicos | Arquivos-fonte acima de 512 KiB são ignorados, e os padrões de rotas e de variáveis de ambiente são escritos para evitar backtracking catastrófico (testados com entradas adversariais). |
| Um bug em um detector | A seção que falhou fica vazia e um aviso é registrado; as outras seções não são afetadas. |

### 5. A configuração do próprio repositório não consegue esconder os problemas dele

Um repositório analisado pode trazer um `repolens.config.json` (veja
[configuration.md](configuration.md)). O RepoLens lê esse arquivo como JSON, nunca o
executa, e limita o que ele pode fazer:

- Ele não pode desativar nem rebaixar as verificações de **segurança** (`ENV_PUBLIC_SECRET`,
  `ENV_EXAMPLE_REAL_SECRET`, `TRACKED_ENV_FILE`, `ENV_FILE_NOT_IGNORED`, `RUNTIME_VULNERABLE`,
  `DEPENDENCY_VULNERABLE`). Só a sua
  configuração do usuário ou um arquivo que você passar com `--config` podem fazer isso.
- Os padrões de `ignore` dele deixam caminhos de fora da análise, mas não mudam o que o
  RepoLens considera ignorado pelo Git: um `.env` local listado ali continua sendo
  reportado se o Git fosse commitá-lo.
- Ele não pode definir preferências de terminal, e o `maxFiles` dele é limitado a
  1.000.000.
- O arquivo é lido como qualquer outro arquivo do projeto: dentro da raiz, no máximo
  256 KiB, sem links simbólicos apontando para fora, sem FIFOs. Um arquivo que o RepoLens
  não consegue usar é ignorado com um aviso.
- Sempre que ele é aplicado, a saída avisa ("Configured by repolens.config.json: 2 checks
  turned off"), e `--json` o lista em `meta.config`. Use `--no-config` para ver um
  repositório não confiável sem as configurações dele.

Os avisos sobre configuração citam nomes de opções e códigos de verificações, nunca os
valores que estão no arquivo.

### 6. A escrita de arquivos tem o mesmo cuidado

`--output` e `repolens agent init` nunca escrevem através de um link simbólico e nunca
abrem um FIFO no caminho de destino, então um repositório analisado não consegue
redirecioná-los. O `agent init` também se recusa a sobrescrever arquivos que ele não gerou,
a menos que você passe `--force`.

### 7. O `repolens setup` executa só o que mostra para você

Preparar um projeto significa executar coisas: instalar dependências roda scripts de ciclo
de vida, e o Compose baixa ou constrói imagens. O `repolens setup` é o único comando que faz
isso, de propósito e às claras:

- **Só comandos que o RepoLens monta.** Copiar o arquivo de env de exemplo,
  `docker compose up -d` e o `install` do gerenciador de pacotes (ou `go mod download`).
  Scripts do projeto (`make setup`, `pnpm db:up`) nunca são executados; o setup os lista
  para você. Um nome de arquivo ou de serviço do Compose que não seja um nome simples
  (começa com `-`, ou tem espaços ou caracteres de shell) também vira só uma sugestão.
- **Mostrado antes de rodar, com o que mais vai rodar.** O plano lista cada comando, os
  scripts de ciclo de vida de instalação do projeto com o conteúdo deles (com segredos
  ocultados, como qualquer outro texto repetido) e as imagens que o Compose baixa ou
  constrói. `--ignore-scripts` instala sem nenhum script de ciclo de vida, nem do projeto
  nem das dependências.
- **Perguntado antes de rodar.** O setup espera um sim no terminal. Sem terminal, ele se
  recusa a rodar a menos que você passe `--yes`, então uma entrada redirecionada não
  responde por você.
- **Programas do seu PATH, nunca do repositório.** O próprio RepoLens encontra `pnpm`,
  `docker` e afins e os executa pelo caminho absoluto, sem shell. Entradas do PATH relativas
  (`.`, `bin`) ou dentro do repositório (`node_modules/.bin`) são ignoradas, assim como um
  programa no PATH que seja um link para dentro do repositório. Isso importa principalmente
  no Windows, onde o diretório atual seria pesquisado primeiro. Os shims `.cmd` do Windows
  (npm, pnpm, Yarn) só rodam com argumentos que o `cmd.exe` não consegue reinterpretar.
- **O seu arquivo de env é seu.** O exemplo é lido como qualquer outro arquivo do projeto
  (só dentro do repositório, nunca através de um link que saia dele) e copiado para um
  arquivo novo que só você pode ler. Um arquivo existente, ou um link no lugar dele, nunca é
  sobrescrito.
- **Nada verificado pela metade.** Programas ausentes e uma versão do Node.js fora do
  `engines.node` são detectados antes do primeiro passo, e o setup para no primeiro passo
  que falhar.

### 8. A rede só é usada com o `repolens doctor --online`

O `repolens doctor --online` consulta as versões exatas dos seus lockfiles no
[OSV.dev](https://osv.dev), o banco aberto de vulnerabilidades do Google, e é a única parte
do RepoLens que faz requisições de rede:

- **Só quando você passa a flag.** Nenhuma configuração nem variável de ambiente a liga, o
  `doctor` sem ela e todos os outros comandos continuam offline, e o `repolens mcp` nunca a
  usa.
- **Só nomes e versões de pacotes.** O RepoLens envia o ecossistema (`npm`, `Packagist`,
  `Go`), o nome e a versão de cada pacote para `https://api.osv.dev`. Nenhum conteúdo de
  arquivo, caminho, nome de projeto ou qualquer outra coisa sobre a sua máquina.
- **Lidos como qualquer arquivo do projeto.** Os lockfiles são lidos com as proteções do
  [3](#3-o-repolens-só-lê-dentro-do-diretório-para-o-qual-você-aponta), até 32 MiB cada; as
  respostas são interpretadas como dados, nunca executadas.
- **Com limites.** Cada requisição expira em 15 segundos e uma execução busca no máximo 500
  advisories. Se o OSV.dev não responder, um aviso diz isso e a verificação é pulada; o
  restante da execução não é afetado. Nada é guardado em cache nem gravado em disco.

## Privacidade

- **Sem telemetria.** O RepoLens não tem analytics, relatório de falhas nem verificação de
  atualizações, e não faz nenhuma requisição de rede a menos que você rode o
  `repolens doctor --online` ([8](#8-a-rede-só-é-usada-com-o-repolens-doctor---online)). Se a telemetria for considerada algum
  dia, ela será opt-in, desativada por padrão e anunciada no changelog.
- A saída nunca inclui caminhos absolutos da sua máquina. Os caminhos são relativos ao
  diretório analisado, e o projeto é identificado pelo nome do diretório.

## Rodando o próprio RepoLens com segurança

O RepoLens só consegue proteger você depois que já está rodando. Quando você usa
`npx @douglas-strey/repolens` *dentro* de um repositório não confiável, o npm resolve o
pacote primeiro, e o npm respeita o `.npmrc` desse repositório (que pode apontar para outro
registry) e o `node_modules` dele (que pode conter um pacote com o mesmo nome). Em vez
disso, rode de fora do repositório:

```sh
cd ~ && npx @douglas-strey/repolens ~/code/unknown-repo
# ou instale uma vez e use o binário
npm install -g @douglas-strey/repolens && repolens ~/code/unknown-repo
```

## O que a saída contém

Trate a saída do RepoLens como uma descrição do seu repositório: tudo bem compartilhá-la
onde o seu código pode ser compartilhado. Ela inclui caminhos de arquivos, nomes e versões
de dependências, comandos de scripts (mascarados como descrito acima), **nomes** de
variáveis de ambiente, nomes de serviços, imagens e portas do Docker, caminhos de rotas,
nomes de jobs de CI, a branch do Git e URLs de remotes sanitizadas.

`repolens agent init` grava esses fatos em `.repolens/`. Revise esses arquivos antes de
commitá-los.

## Limitações conhecidas

- O mascaramento do texto reproduzido é defesa em profundidade, não uma garantia: um
  segredo commitado em um formato incomum dentro de um script do `package.json` ainda pode
  ser exibido, porque ele já está no repositório. Com valores de variáveis de ambiente é
  diferente: eles nunca são exibidos, em nenhum formato.
- O casamento de padrões de ignore diferencia maiúsculas de minúsculas, como no Linux.
  Seções `[include]` da sua configuração do Git não são seguidas na busca pelo
  `core.excludesFile`, e a configuração de sistema do Git não é lida.
