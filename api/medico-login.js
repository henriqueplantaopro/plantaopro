// /api/medico-login.js
import { sbAdmin, verificarSenha, hashSenha, json, setCors, rateLimit } from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 'desconhecido';
  if (!rateLimit(ip, 8, 60_000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });

  try {
    let { cpf, senha } = req.body || {};
    cpf = String(cpf || '').replace(/\D/g, '');
    if (!cpf || cpf.length < 11) return json(res, 400, { erro: 'Digite um CPF válido.' });
    if (!senha) return json(res, 400, { erro: 'Digite sua senha.' });

    const lista = await sbAdmin(`/rest/v1/medicos?cpf=eq.${cpf}&select=*`);
    const med = lista?.[0];

    // Mensagem genérica de propósito: não revela quais CPFs existem no sistema.
    if (!med || !(await verificarSenha(senha, med.senha_hash))) {
      await new Promise(r => setTimeout(r, 150 + Math.random() * 150));
      return json(res, 401, { erro: 'CPF ou senha incorretos.' });
    }
    if (med.ativo === false) return json(res, 403, { erro: 'Conta inativa. Contate o administrador.' });

    // Migração suave: se a senha estava em texto puro, vira bcrypt no primeiro login certo.
    if (!/^\$2[aby]\$/.test(med.senha_hash || '')) {
      const novo = await hashSenha(senha);
      await sbAdmin(`/rest/v1/medicos?id=eq.${med.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ senha_hash: novo }),
      }).catch(() => {});
    }

    const { senha_hash, ...medico } = med;
    return json(res, 200, { ok: true, medico });
  } catch (e) {
    console.error('[medico-login]', e);
    return json(res, 500, { erro: 'Erro interno' });
  }
}
