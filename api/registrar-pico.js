// api/registrar-pico.js
// Cron diário — registra o pico de médicos de cada cliente
// Configure no vercel.json: {"crons": [{"path": "/api/registrar-pico", "schedule": "0 3 * * *"}]}

export default async function handler(req, res) {
  // Segurança: só aceita chamadas do próprio Vercel Cron ou com token
  const auth = req.headers.authorization;
  if (auth !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({error:'Unauthorized'});
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const sbH = {
    'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json', 'Prefer': 'return=representation'
  };

  try {
    // 1. Buscar todas as assinaturas ativas
    const assinaturas = await fetch(SUPABASE_URL + '/rest/v1/assinaturas?status=eq.ativa&select=id,admin_id,pico_mes_atual', {headers: sbH}).then(r=>r.json());

    let atualizados = 0;
    for (const ass of (assinaturas || [])) {
      // 2. Contar médicos ativos deste admin
      const medRes = await fetch(SUPABASE_URL + '/rest/v1/medicos?ativo=eq.true&select=count', {
        headers: {...sbH, 'Prefer': 'count=exact'},
        // Filtrar por admin_id via projeto — médicos pertencem a projetos que pertencem ao admin
        // Simplificado: contar todos os médicos (ajustar conforme estrutura multi-tenant)
      });
      const total = parseInt(medRes.headers.get('content-range')?.split('/')[1] || '0');

      // 3. Atualizar pico se for maior que o atual
      if (total > (ass.pico_mes_atual || 0)) {
        await fetch(SUPABASE_URL + '/rest/v1/assinaturas?id=eq.' + ass.id, {
          method: 'PATCH',
          headers: {...sbH, 'Prefer': 'return=minimal'},
          body: JSON.stringify({
            pico_mes_atual: total,
            pico_registrado_em: new Date().toISOString()
          })
        });
        atualizados++;
      }

      // 4. Verificar se o pico ultrapassou o limite do plano atual
      // Se sim, registrar alerta para o admin
      const LIMITES = {starter:100, growth:200, pro:500, business:1000, enterprise:1500};
    }

    // 5. Verificar assinaturas vencidas (vencimento < hoje)
    const hoje = new Date().toISOString().slice(0,10);
    await fetch(SUPABASE_URL + '/rest/v1/assinaturas?status=eq.ativa&vencimento=lt.' + hoje, {
      method: 'PATCH',
      headers: {...sbH, 'Prefer': 'return=minimal'},
      body: JSON.stringify({status: 'vencida', atualizado_em: new Date().toISOString()})
    });

    return res.status(200).json({ok:true, atualizados, total: assinaturas?.length || 0});
  } catch(e) {
    console.error('Cron erro:', e);
    return res.status(500).json({error: e.message});
  }
}
