<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img src="assets/banner-light.png" alt="mods legaizinhos: mods do Claude Code que eu uso e acho legais de ter" width="100%">
</picture>

| Mod | O que faz |
|---|---|
| [subagentes](subagentes) | Painel da sessão: limites do Claude, diff e PRs com botões, sessão principal, subagentes e fluxos de trabalho, custo e um botão pra controle remoto e computador acordado |

## Como instalar um mod

Clone o repositório e copie a pasta do mod que você quiser para `~/.claude/mods`:

```bash
git clone https://github.com/luecabral/mods-legaizinhos
cp -R mods-legaizinhos/subagentes ~/.claude/mods/subagentes
```

Depois recarregue o Claude Code.
