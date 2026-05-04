// api/webhook-asaas.js
// Vercel Serverless Function — recebe notificações do Asaas
// Configure no Asaas: Configurações > Integrações > Webhook > URL: https://plantaopro-pi.vercel.app/api/webhook-asaas

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key (não a anon)

  try {
    const event = req.body;
    const tipo  = event.event; // PAYMENT_RECEIVED, PAYMENT_OVERDUE, PAYMENT_DELETED, etc.
    const pag   = event.payment;

    if (!tipo || !pag) return res.status(200).json({ok:true});

    // Buscar assinatura pelo externalReference (admin_id que gravamos ao criar cobrança)
    const adminId = pag.externalReference;
    if (!adminId) return res.status(200).json({ok:true});

    const sbHeaders = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    };

    if (tipo === 'PAYMENT_RECEIVED' || tipo === 'PAYMENT_CONFIRMED') {
      // Pagamento confirmado — ativar assinatura por 30 dias
      const vencimento = new Date();
      vencimento.setDate(vencimento.getDate() + 30);

      await fetch(SUPABASE_URL + '/rest/v1/assinaturas?admin_id=eq.' + adminId, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({
          status: 'ativa',
          vencimento: vencimento.toISOString().slice(0,10),
          ultimo_pagamento: new Date().toISOString().slice(0,10),
          asaas_payment_id: pag.id,
          pico_mes_atual: 0, // resetar pico ao renovar
          atualizado_em: new Date().toISOString()
        })
      });

      // Gravar log de pagamento
      await fetch(SUPABASE_URL + '/rest/v1/pagamentos_log', {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          admin_id: adminId,
          asaas_payment_id: pag.id,
          valor: pag.value,
          status: 'pago',
          forma: pag.billingType,
          pago_em: new Date().toISOString()
        })
      });

    } else if (tipo === 'PAYMENT_OVERDUE') {
      // Pagamento vencido — suspender acesso
      await fetch(SUPABASE_URL + '/rest/v1/assinaturas?admin_id=eq.' + adminId, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({
          status: 'vencida',
          atualizado_em: new Date().toISOString()
        })
      });

    } else if (tipo === 'PAYMENT_DELETED' || tipo === 'SUBSCRIPTION_DELETED') {
      // Cancelamento
      await fetch(SUPABASE_URL + '/rest/v1/assinaturas?admin_id=eq.' + adminId, {
        method: 'PATCH',
        headers: sbHeaders,
        body: JSON.stringify({
          status: 'cancelada',
          atualizado_em: new Date().toISOString()
        })
      });
    }

    return res.status(200).json({ok:true});
  } catch(e) {
    console.error('Webhook error:', e);
    return res.status(500).json({error: e.message});
  }
}
