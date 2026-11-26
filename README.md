<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img src="assets/banner-light.png" alt="mods legaizinhos: mods do Claude Code que eu uso e acho legais de ter" width="100%">
</picture>

| Mod | O que faz |
|---|---|
| [subagentes](subagentes) | Painel da sessão: limites do Claude, diff e PRs com botões, sessão principal, subagentes e fluxos de trabalho, custo e um botão pra controle remoto e computador acordado |
| [radar-time](radar-time) | Radar do time: o que cada pessoa está fazendo no GitHub (e no Linear, se quiser) em linguagem simples, com PRs, tamanho, complexidade e avisos de PR novo. Funciona com qualquer org: você monta os times no próprio painel (`/radar`) |

## Como instalar um mod

Clone o repositório e copie a pasta do mod que você quiser para `~/.claude/mods`:

```bash
git clone https://github.com/luecabral/mods-legaizinhos
cp -R mods-legaizinhos/subagentes ~/.claude/mods/subagentes
```

Depois recarregue o Claude Code.

Para o `radar-time` é a mesma coisa: `cp -R mods-legaizinhos/radar-time ~/.claude/mods/radar-time`. Precisa do [GitHub CLI](https://cli.github.com) logado.
