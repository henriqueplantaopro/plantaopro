// /api/convites.js
import { sbAdmin, json, setCors } from './_lib.js';
import { exigirSessao } from './_auth.js';

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem caracteres ambíguos
function gerarCodigo() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const sessao = exigirSessao(req, res);
  if (!sessao) return;
  const adminId = sessao.adminId;

  try {
    if (req.method === 'GET') {
      const dados = await sbAdmin(
        `/rest/v1/convites?admin_id=eq.${adminId}&select=*&order=criado_em.desc`
      );
      return json(res, 200, dados || []);
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      let criado = null, tentativas = 0;
      while (!criado && tentativas < 6) {
        tentativas++;
        try {
          const r = await sbAdmin('/rest/v1/convites', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              codigo: gerarCodigo(),
              admin_id: adminId,
              nome: b.nome || null,
              crm: b.crm || null,
              email: b.email || null,
            }),
          });
          if (r && r[0]) criado = r[0];
        } catch (_) { /* colisão de código, tenta de novo */ }
      }
      if (!criado) return json(res, 500, { erro: 'Não foi possível gerar o convite' });
      return json(res, 201, criado);
    }

    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return json(res, 400, { erro: 'id obrigatório' });
      await sbAdmin(
        `/rest/v1/convites?id=eq.${id}&admin_id=eq.${adminId}`,
        { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'cancelado' }) }
      );
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { erro: 'Método não permitido' });
  } catch (e) {
    console.error('[convites]', e);
    return json(res, 500, { erro: 'Erro interno' });
  }
}
