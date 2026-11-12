# claude-mod-subagentes

Mod do Claude Code que abre um painel com cada subagente e tarefa da sessão:

- status (rodando, concluído, parado)
- modelo usado
- tokens e custo estimado em US$
- linhas adicionadas e removidas
- totais da sessão principal, dos subagentes e das sessões mescladas
- processos do Gemini CLI iniciados pela sessão

Os preços ficam em `hooks/prices.ts` (US$ por milhão de tokens). Ajuste lá se a tabela mudar.

## Como instalar

Copie esta pasta para `~/.claude/mods/subagentes`:

```bash
git clone https://github.com/luecabral/claude-mod-subagentes ~/.claude/mods/subagentes
```

Depois recarregue o Claude Code.

## Estrutura

- `.claude-plugin/plugin.json`: manifesto do mod
- `hooks/register.tsx`: painel e leitura dos eventos
- `hooks/sessions.ts`: números por sessão
- `hooks/prices.ts`: tabela de preços
- `hooks/gemini-cli.ts`: leitura dos eventos do Gemini CLI
- `types/index.d.ts`: tipos do mod
- `.claude-plugin/types/`: tipos do Claude Code, gerados pelo app (fora do repositório)
