# Política de segurança

[English](SECURITY.md) | **Português (Brasil)**

O RepoLens foi feito para rodar em repositórios em que você ainda não confia: um clone
recém-feito, o desafio técnico de um candidato, um código entregue por um fornecedor. Bugs
de segurança são levados a sério.

## Como reportar uma vulnerabilidade

Por favor, **não abra uma issue pública** para problemas de segurança.

Reporte de forma privada pelo GitHub:
[Security → Report a vulnerability](https://github.com/Douglas-Strey/repolens-cli/security/advisories/new).

Inclua o que você rodou, o que aconteceu e, se possível, um repositório mínimo que reproduza
o problema. Você deve receber uma primeira resposta em até uma semana. Quando a correção for
lançada, o alerta de segurança será publicado com crédito para você, a menos que você
prefira ficar anônimo.

## O que conta como vulnerabilidade

Qualquer coisa que quebre as garantias descritas em
[docs/pt-BR/security.md](docs/pt-BR/security.md), por exemplo:

- O RepoLens exibe, grava ou vaza de alguma outra forma o **valor** de uma variável de
  ambiente, token, senha ou outro segredo encontrado em um repositório analisado.
- Analisar um repositório faz o RepoLens **executar** código ou comandos desse repositório
  (scripts, arquivos de configuração, hooks do Git, o próprio `git`, Docker, …).
- Um repositório forjado faz o RepoLens **ler arquivos fora** do diretório analisado (exceto
  os metadados do Git no diretório pai, descritos no modelo de segurança), por exemplo via
  links simbólicos ou path traversal.
- Um repositório forjado faz o RepoLens travar ou usar memória sem limite (por exemplo, via
  bombas de alias no YAML, arquivos enormes ou FIFOs).

## Versões suportadas

Só a versão publicada mais recente recebe correções de segurança.
