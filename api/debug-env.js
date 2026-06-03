// /api/debug-env.js
// DIAGNÓSTICO TEMPORÁRIO — APAGAR APÓS USO
//
// Esse endpoint NÃO expõe valores de variáveis, apenas mostra:
// - Quais variáveis estão definidas
// - O tamanho do valor (pra saber se está vazio ou tem conteúdo)
// - Os 6 primeiros caracteres (pra confirmar visualmente que é o valor certo)
//
// Acesse: https://SEU-DOMINIO.vercel.app/api/debug-env

export default function handler(req, res) {
  const vars = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'JWT_SECRET',
    'ASAAS_API_KEY',
    'ASAAS_BASE_URL',
    'ASAAS_WEBHOOK_TOKEN',
    'CRON_SECRET',
    'APP_BASE_URL',
  ];

  const diagnostico = {};

  for (const nome of vars) {
    const valor = process.env[nome];
    if (valor === undefined) {
      diagnostico[nome] = { status: '❌ NÃO EXISTE' };
    } else if (valor === '') {
      diagnostico[nome] = { status: '⚠️ VAZIA (string vazia)' };
    } else {
      diagnostico[nome] = {
        status: '✅ existe',
        tamanho_chars: valor.length,
        primeiros_6: valor.slice(0, 6),
        ultimos_4: valor.slice(-4),
      };
    }
  }

  // Lista TODAS as variáveis que começam com SUPABASE, ASAAS, JWT, CRON, APP
  const todasRelevantes = Object.keys(process.env)
    .filter(k => /^(SUPABASE|ASAAS|JWT|CRON|APP)/i.test(k))
    .sort();

  res.status(200).json({
    aviso: 'APAGUE ESTE ARQUIVO APÓS DIAGNÓSTICO',
    variaveis_esperadas: diagnostico,
    todas_variaveis_relevantes_encontradas: todasRelevantes,
    node_version: process.version,
  });
}
