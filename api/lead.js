// /api/lead.js
// Recebe submissão da landing (formulário de demonstração) e salva como lead no Supabase.
// Não cria conta, não gera cobrança — só registra interesse pra você responder manualmente.

import { sbAdmin, validarEmail, json, setCors, rateLimit } from './_lib.js';
import crypto from 'crypto';

// Lista válida de planos (qualquer outro valor é rejeitado)
const PLANOS_VALIDOS = ['starter', 'growth', 'pro', 'business', 'enterprise'];

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  // Rate limit: 3 leads/min por IP (protege contra spam)
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 'desconhecido';
  if (!rateLimit(ip, 3, 60_000)) {
    return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });
  }

  try {
    const {
      plano,
      razaoSocial, cnpj, qtdMedicos, cidadeUf,
      nome, cargo, email, whatsapp, contatoPreferido,
      observacoes,
    } = req.body || {};

    // ─── Validações ────────────────────────────────────────────────
    if (!razaoSocial || !nome || !email || !whatsapp) {
      return json(res, 400, { erro: 'Preencha empresa, nome, e-mail e WhatsApp' });
    }
    if (!validarEmail(email)) {
      return json(res, 400, { erro: 'E-mail inválido' });
    }
    if (plano && !PLANOS_VALIDOS.includes(plano)) {
      return json(res, 400, { erro: 'Plano inválido' });
    }
    // WhatsApp: aceita só dígitos depois de limpar formatação
    const whatsappLimpo = String(whatsapp).replace(/\D/g, '');
    if (whatsappLimpo.length < 10) {
      return json(res, 400, { erro: 'WhatsApp inválido (mínimo 10 dígitos)' });
    }

    // Tamanho máximo das observações pra evitar spam de texto longo
    const obsTruncada = String(observacoes || '').slice(0, 1000);

    // ─── Hash do IP (privacidade básica + dedup) ──────────────────
    const ipHash = crypto.createHash('sha256').update(ip + (process.env.JWT_SECRET || 'salt')).digest('hex').slice(0, 16);

    // ─── Salvar no Supabase ────────────────────────────────────────
    await sbAdmin('/rest/v1/leads', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        plano: plano || null,
        razao_social: razaoSocial.trim().slice(0, 200),
        cnpj: String(cnpj || '').replace(/\D/g, '').slice(0, 14) || null,
        qtd_medicos: qtdMedicos || null,
        cidade_uf: (cidadeUf || '').trim().slice(0, 100) || null,
        nome: nome.trim().slice(0, 200),
        cargo: (cargo || '').trim().slice(0, 100) || null,
        email: email.trim().toLowerCase().slice(0, 200),
        whatsapp: whatsappLimpo,
        contato_preferido: contatoPreferido || 'whatsapp',
        observacoes: obsTruncada || null,
        user_agent: (req.headers['user-agent'] || '').slice(0, 300),
        ip_hash: ipHash,
      }),
    });

    return json(res, 200, { ok: true });

  } catch (e) {
    console.error('[lead]', e);
    return json(res, 500, { erro: 'Não foi possível enviar. Tente novamente.' });
  }
}
