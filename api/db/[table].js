// /api/db/[table].js
// Encanador com escopo: repassa a query PostgREST que o painel já manda,
// mas FORÇA admin_id do token e ignora qualquer admin_id vindo do cliente.
import { sbAdmin, json, setCors } from '../_lib.js';
import { exigirSessao } from '../_auth.js';

// Tabelas com coluna admin_id — escopadas por admin_id = dono da sessão.
const ALLOW = new Set([
  'lancamentos',
  'projetos',
  'setores',
  'medicos',
  'tipos_plantao',
  'usuarios',
  'usuario_projetos',
  'fechamentos',
  'fechamento_itens',
  'remessas',
  'assinaturas',
  'log_atividades',
  'solicitacoes_senha',
  'pagamentos_log',
  'checkins',
  'ausencias',
  'candidaturas',
  'transferencias',
  'vinculos',
]);

// Tabelas que NÃO têm admin_id e se escopam pela própria chave.
// `admins`: o administrador só enxerga a si mesmo (id = adminId).
const ALLOW_POR_ID = new Set(['admins']);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const sessao = exigirSessao(req, res);
  if (!sessao) return;
  const adminId = sessao.adminId;

  const table = req.query.table;
  const porId = ALLOW_POR_ID.has(table);
  if (!ALLOW.has(table) && !porId) return json(res, 403, { erro: 'Tabela não permitida' });

  // Coluna usada para isolar a empresa nesta tabela
  const coluna = porId ? 'id' : 'admin_id';

  // Query crua do cliente, removendo qualquer tentativa de mexer no escopo.
  const i = req.url.indexOf('?');
  const qsCru = i >= 0 ? req.url.slice(i + 1) : '';
  const qs = qsCru
    .split('&')
    .filter((p) => p && !/^admin_id=/i.test(p) && !/^table=/i.test(p))
    .join('&');
  const comEscopo = () =>
    `/rest/v1/${table}?${qs ? qs + '&' : ''}${coluna}=eq.${adminId}`;

  try {
    if (req.method === 'GET') {
      const dados = await sbAdmin(comEscopo());
      return json(res, 200, dados || []);
    }

    if (req.method === 'POST') {
      // Em tabelas escopadas por admin_id, o servidor carimba o dono.
      // Em `admins` não se cria registro por aqui.
      if (porId) return json(res, 403, { erro: 'Criação não permitida nesta tabela' });
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
      const upd = await sbAdmin(comEscopo(), {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(body),
      });
      return json(res, 200, upd || []);
    }

    if (req.method === 'DELETE') {
      if (porId) return json(res, 403, { erro: 'Remoção não permitida nesta tabela' });
      const del = await sbAdmin(comEscopo(), {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      });
      return json(res, 200, del || []);
    }

    return json(res, 405, { erro: 'Método não permitido' });
  } catch (e) {
    console.error('[db]', table, e);
    return json(res, 500, { erro: String((e && e.message) || e) });
  }
}
