#!/bin/sh
# Falha se algum dado de empresa específica aparecer no código, nos testes ou na documentação.
# Os termos são montados por pedaços para este arquivo não casar com a própria busca.
cd "$(dirname "$0")/.." || exit 2
padrao="$(printf '%s' 'res''erva|rsv''-ink|Emanuel''Facundo|lue''cabral|Gustavo''Guarany|Jorge''LucasCM|Cucu''ricos|Snif''fers|dumet''zker|Johnn''Anon|Gregorio''Neto')"
if grep -rniE --exclude-dir=.claude-plugin "$padrao" . ; then
  echo "Achei dados de empresa específica acima. Tire do código." >&2
  exit 1
fi
echo "ok: nenhum dado de empresa específica"
