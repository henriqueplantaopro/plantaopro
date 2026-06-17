// /api/db/[table].js
// Encanador com escopo: repassa a query PostgREST que o painel já manda,
// mas FORÇA admin_id do token e ignora qualquer admin_id vindo do cliente.
import { sbAdmin, json, setCors } from '../_lib.js';
import { exigirSessao } from '../_auth.js';

// Só tabelas que têm coluna admin_id. As demais entram depois, com regra própria.
const ALLOW = new Set(['lancamentos', 'projetos', 'setores']);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const sessao = exigirSessao(req, res);
  if (!sessao) return;
  const adminId = sessao.adminId;

  const table = req.query.table;
  if (!ALLOW.has(table)) return json(res, 403, { erro: 'Tabela não permitida' });

  // Query crua do cliente, removendo qualquer admin_id que ele tente mandar.
  const i = req.url.indexOf('?');
  const qsCru = i >= 0 ? req.url.slice(i + 1) : '';
  const qs = qsCru.split('&').filter(p => p && !/^admin_id=/i.test(p)).join('&');
  const comEscopo = () => `/rest/v1/${table}?${qs ? qs + '&' : ''}admin_id=eq.${adminId}`;

  try {
    if (req.method === 'GET') {
      const dados = await sbAdmin(comEscopo());
      return json(res, 200, dados || []);
    }

    if (req.method === 'POST') {
      const forcar = (o) => ({ ...o, admin_id: adminId });
      const body = Array.isArray(req.body) ? req.body.map(forcar) : forcar(req.body || {});
      const url = qs ? `/rest/v1/${table}?${qs}` : `/rest/v1/${table}`;
      const criado = await sbAdmin(url, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(body),
      });
      return json(res, 201, criado || []);
    }

    if (req.method === 'PATCH') {
      const body = { ...(req.body || {}) };
      delete body.admin_id; // nunca deixa trocar de empresa
      await sbAdmin(comEscopo(), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(body),
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      await sbAdmin(comEscopo(), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { erro: 'Método não permitido' });
  } catch (e) {
    console.error('[db]', table, e);
    return json(res, 500, { erro: 'Erro interno' });
  }
}
