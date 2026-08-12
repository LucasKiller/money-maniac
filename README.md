# Money Maniac

Money Maniac é um runtime de agente de IA para pesquisa de mercado, análise de concorrência, inteligência de negócios e automações supervisionadas.

O objetivo não é entregar autonomia irrestrita. O objetivo é permitir que um agente trabalhe continuamente dentro de limites explícitos, com observabilidade, rastreabilidade, proteção contra entradas não confiáveis e bloqueios financeiros independentes.

> **Estado de segurança:** o deployment padrão é inerte (`safe-idle`). Execução autônoma e operações financeiras são opt-in. A chave privada ainda é carregada pelo processo principal no runtime completo; portanto, fundos de produção não devem ser usados até a implementação de um signer isolado.

## Casos de uso

- Pesquisa de mercado e mapeamento de oportunidades.
- Análise de concorrentes, preços e posicionamento.
- Síntese de inteligência de negócios.
- Avaliação supervisionada de anúncios e projetos freelance.
- Preparação de escopos, relatórios e propostas para revisão humana.
- Automação futura de rotinas com políticas, auditoria e limites de gasto.

O Money Maniac não envia propostas, contata pessoas ou movimenta fundos por conta própria na configuração padrão.

## Modos de execução

### Safe-idle — padrão

O container permanece saudável, mas não carrega wallet, não provisiona contas, não executa pagamentos e não inicia o loop do agente.

```env
AUTOMATON_START_MODE=idle
AUTOMATON_FINANCIAL_MODE=disabled
```

### One-shot supervisionado

Executa exatamente uma inferência OpenAI e encerra:

```bash
node dist/index.js --once --prompt "Avalie esta oportunidade e apresente aderência, riscos e próximos passos."
```

Esse modo não carrega wallet, Conway, banco, skills, heartbeat, social inbox, child agents ou ferramentas. Tool calls são rejeitadas, o prompt é limitado a 4.000 caracteres e o timeout padrão é de 30 segundos.

O prompt estratégico do Money Maniac já é aplicado como instrução-base nesse modo. O texto da tarefa deve informar apenas o mercado, país, capital disponível, competências e objetivo da análise; não é necessário repetir toda a missão estratégica em cada execução.

Exemplo para iniciar a missão:

```bash
node dist/index.js --once --prompt "Execute a etapa inicial da missão para o mercado brasileiro. Capital máximo para validação: US$ 50. Priorize serviços B2B que possam gerar receita em até 30 dias. Separe fatos, estimativas, hipóteses e variáveis desconhecidas."
```

A instrução estratégica orienta análise e planejamento, mas não amplia autoridade. No modo supervisionado, verbos como pesquisar, lançar, operar e escalar significam produzir recomendações e planos até que uma ferramenta e uma aprovação humana existam.

```bash
AUTOMATON_ONCE_TIMEOUT_MS=60000 node dist/index.js --once --prompt "Produza uma análise objetiva."
```

O timeout aceito fica entre 1 e 60 segundos. Em containers reiniciáveis, mantenha `AUTOMATON_START_MODE=idle` e invoque `--once` manualmente para evitar repetição acidental de inferências faturáveis.

### Runtime contínuo

```bash
node dist/index.js --run
```

Inicializa identidade, configuração, memória, PolicyEngine, TreasuryGate, ferramentas, heartbeat e o ciclo contínuo do agente. Esse modo deve ser usado somente após revisão da configuração persistida e dos limites operacionais.

## Arquitetura

```text
Entradas externas
      |
      v
Proveniência + defesa de conteúdo
      |
      v
LLM / planejamento
      |
      v
Solicitação de ferramenta
      |
      v
PolicyEngine
      |
      +-------------------+
      |                   |
      v                   v
Ferramentas normais   TreasuryGate
      |                   |
      v                   v
Execução             Signer atual
                          |
                          v
                    Blockchain / x402
```

Principais proteções já implementadas:

- Proveniência de entradas preservada até a decisão de política.
- Sanitização de conteúdo separada de autorização.
- TreasuryGate durável com intents idempotentes e reconciliação.
- Auto-topup, shell do host e workers locais desabilitados por padrão.
- Destinatários de transferências sujeitos a allowlist exata.
- Pagamentos incertos bloqueiam novas tentativas até reconciliação.
- Arquivos sensíveis e módulos centrais protegidos contra self-modification.
- MCP pode ser registrado, mas transporte e `callTool` ainda não estão implementados; chamadas falham de forma fechada.

Limitação atual: o signer permanece no mesmo processo do runtime. Isolamento por usuário de sistema ou serviço separado é requisito antes de autonomia financeira de produção.

## Deploy com Docker Compose

Requisitos de desenvolvimento:

- Node.js 20 ou superior.
- Node.js 22.12.0 usado na imagem Docker.
- pnpm 10.28.1.

Build local:

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
docker compose up --build -d
```

O Compose aplica:

- filesystem raiz read-only;
- volume persistente apenas para o estado do agente;
- `/tmp` limitado e sem execução;
- remoção de capabilities Linux;
- `no-new-privileges`;
- limites de CPU, memória e processos;
- rotação de logs;
- healthcheck periódico.

O container não recebe Docker socket, diretórios do host, dispositivos ou portas por padrão.

## Uso operacional

### Run autônomo restrito a pesquisa

```env
AUTOMATON_START_MODE=run
AUTOMATON_AUTONOMY_PROFILE=research
AUTOMATON_FINANCIAL_MODE=disabled
AUTOMATON_KILL_SWITCH=false
AUTOMATON_OPENAI_DAILY_BUDGET_CENTS=25
AUTOMATON_OPENAI_HOURLY_BUDGET_CENTS=5
AUTOMATON_OPENAI_PER_CALL_CEILING_CENTS=2
AUTOMATON_MAX_TURNS_PER_CYCLE=3
AUTOMATON_MAX_TURNS_PER_DAY=12
AUTOMATON_MIN_TURN_INTERVAL_MS=900000
LANG=C.UTF-8
LC_ALL=C.UTF-8
```

Nesse perfil, somente pesquisa web pública, análise, memória interna, planejamento e `sleep` são expostos ao modelo. Wallet, pagamentos, x402, shell, escrita de arquivos, self-modification, social inbox, envio de propostas, child agents, skills externas e orchestration ficam fora da lista de ferramentas.

A pesquisa web aceita apenas HTTPS público na porta 443, resolve DNS antes da conexão, bloqueia endereços privados, limita redirects e respostas e marca todo conteúdo retornado como não confiável. Para interromper novos ciclos, altere `AUTOMATON_KILL_SWITCH=true` e faça redeploy.

Comandos de leitura e diagnóstico:

```bash
node dist/index.js --help
node dist/index.js --version
node dist/index.js --status
```

Exemplos supervisionados:

```bash
node dist/index.js --once --prompt "Crie uma oferta de análise de concorrência para uma pequena empresa."

node dist/index.js --once --prompt "Transforme os dados fornecidos em um relatório executivo com recomendações."

node dist/index.js --once --prompt "Avalie o anúncio abaixo e estime esforço, riscos e preço sugerido: ..."
```

O one-shot não pesquisa a internet nem executa ferramentas. Inclua no prompt os dados que devem ser analisados.

Comandos interativos do runtime completo:

```bash
node dist/index.js --configure
node dist/index.js --pick-model
node dist/index.js --setup
node dist/index.js --init
node dist/index.js --provision
```

`--setup`, `--init` e `--provision` podem criar identidade, gerar wallet, assinar SIWE ou gravar credenciais. Não os execute em produção sem um procedimento de segurança aprovado.

## Estado persistente

O volume Docker mantém os dados em:

```text
/home/automaton/.automaton/
├── automaton.json
├── state.db
├── heartbeat.yml
├── wallet.json
├── SOUL.md
└── skills/
```

- `automaton.json`: configuração do agente.
- `state.db`: memória, turnos, auditoria e registros financeiros.
- `heartbeat.yml`: agenda de tarefas periódicas.
- `wallet.json`: material de assinatura altamente sensível.
- `SOUL.md`: identidade evolutiva.
- `skills/`: instruções especializadas.

Não publique, copie para logs ou edite manualmente `wallet.json`. Não armazene seed phrase, chave privada, credenciais da Binance ou códigos 2FA no Git, em prompts ou em variáveis compartilhadas.

## Segurança financeira

Operações financeiras exigem duas habilitações independentes:

```jsonc
// ~/.automaton/automaton.json
{
  "enableFinancialOperations": true
}
```

```env
AUTOMATON_FINANCIAL_MODE=treasury-gated
```

Sem ambas, a execução financeira é negada. O TreasuryGate também aplica:

- valor máximo por operação;
- limites horário e diário;
- reserva mínima;
- máximo de pagamento x402;
- allowlist de domínios x402;
- allowlist de destinatários;
- máximo de transferências por turno;
- orçamento diário de inferência;
- idempotência e reconciliação.

Auto-topup permanece desabilitado por padrão. Falha ao consultar saldo não é interpretada como saldo zero. Valores acima do limite de confirmação são negados porque ainda não existe um canal seguro de aprovação humana assíncrona.

Até a entrega do signer isolado, use no máximo uma wallet descartável com limite de perda explicitamente aceito. Nunca use a carteira principal.

## OpenAI e Ollama

- **OpenAI:** recomendado para análise estratégica, relatórios e decisões complexas. O modo `--once` exige uma chave OpenAI e um modelo OpenAI compatível.
- **Ollama:** útil para triagem, classificação, resumos em volume e redução de custo no runtime completo.

O modelo ativo pode ser alterado com:

```bash
node dist/index.js --pick-model
```

## Desenvolvimento

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:security
corepack pnpm test:financial
corepack pnpm build
```

Scripts relevantes:

| Script | Função |
|---|---|
| `pnpm typecheck` | Validação TypeScript sem emitir arquivos. |
| `pnpm test` | Suíte Vitest completa. |
| `pnpm test:security` | Testes focados em segurança, injection e policy. |
| `pnpm test:financial` | Testes de gastos e TreasuryGate. |
| `pnpm build` | Compila o runtime e os workspaces. |

Não use `pnpm dev` ou `node dist/index.js --run` como teste genérico: esses comandos podem iniciar processos persistentes ou o runtime completo.

## Estrutura do projeto

```text
src/
├── agent/           # Loop, prompts, ferramentas, PolicyEngine e TreasuryGate
├── conway/          # Cliente Conway, topup, HTTP e x402
├── heartbeat/       # Scheduler e tarefas periódicas
├── identity/        # Wallet, chains e provisioning SIWE
├── inference/       # Registro e estratégia de modelos
├── memory/          # Contexto, ingestão e memória persistente
├── orchestration/   # Task graph e workers
├── replication/     # Child agents e funding protocol
├── runtime/         # Modos de execução supervisionados
├── security/        # Kill switches e controles de segurança
├── self-mod/        # Alterações versionadas e validação
├── skills/          # Loader e registro de skills
├── social/          # Inbox e comunicação entre agentes
├── state/           # SQLite, schema e migrations
└── survival/        # Créditos e níveis de sobrevivência
```

## Operação recomendada hoje

1. Mantenha o Coolify em `idle` e finanças em `disabled`.
2. Use `--once` para análises supervisionadas.
3. Revise toda saída antes de agir externamente.
4. Envie propostas e contatos manualmente.
5. Monitore gastos diretamente no provedor de inferência.
6. Implemente e valide o signer isolado antes de depositar fundos.
7. Só habilite autonomia em ambiente descartável, com limites pequenos e rollback testado.

## Origem e licença

Money Maniac deriva do [Conway Research Automaton](https://github.com/Conway-Research/automaton).

Licenciado sob a [MIT License](LICENSE).
