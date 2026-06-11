// /api/medicos.js
// ----------------------------------------------------------------------------
// ENDPOINT-MODELO do Caminho B. Use este arquivo como TEMPLATE para criar
// os demais recursos (projetos.js, lancamentos.js, fechamentos.js, etc.).
//
// Regras que TODO endpoint de dados segue:
//   1. exigirSessao() primeiro. Sem sessão válida → 401 e return.
//   2. admin_id vem SEMPRE de sessao.adminId (token), nunca do body/query.
//   3. Toda query ao Supabase filtra por admin_id=eq.<sessao.adminId>.
//   4. Campos sensíveis (senha_hash) nunca voltam no select.
//   5. Perfis: leitura ampla; escrita conforme PERMISSOES.
//
// Front-end: troque as chamadas `sb('/rest/v1/medicos...')` por
//   fetch('/api/medicos')                      // listar
//   fetch('/api/medicos', {method:'POST', body})    // criar
//   fetch('/api/medicos?id=<id>', {method:'PATCH', body})  // editar
//   fetch('/api/medicos?id=<id>', {method:'DELETE'})       // remover
// O cookie pp_session é enviado automaticamente (mesma origem).
// ----------------------------------------------------------------------------
import { sbAdmin, json, setCors } from './_lib.js';
import { exigirSessao } from './_auth.js';

// Colunas seguras para devolver ao cliente (sem senha_hash).
const SELECT_MEDICO =
  'id,admin_id,nome,crm,rqe,especialidade,especialidades,cpf,email,telefone,' +
  'data_nascimento,tipo,valor_hora,token_acesso,primeiro_acesso,cpf_proprio,' +
  'device_id,device_registrado_em,ativo,endereco_rua,endereco_numero,' +
  'endereco_comp,endereco_bairro,endereco_cidade,endereco_uf,endereco_cep,' +
  'pessoa_juridica,razao_social,cnpj,pix_tipo,pix_chave,banco,agencia,' +
  'conta_corrente,tipo_conta,ufs_interesse,projetos_vinculados,criado_em';

// Campos que o cliente pode enviar (whitelist — ignora o resto).
const CAMPOS_PERMITIDOS = [
  'nome','crm','rqe','especialidade','especialidades','cpf','email','telefone',
  'data_nascimento','tipo','valor_hora','ativo','endereco_rua','endereco_numero',
  'endereco_comp','endereco_bairro','endereco_cidade','endereco_uf','endereco_cep',
  'pessoa_juridica','razao_social','cnpj','pix_tipo','pix_chave','banco','agencia',
  'conta_corrente','tipo_conta','ufs_interesse','projetos_vinculados',
];

function sanitizar(body) {
  const out = {};
  for (const k of CAMPOS_PERMITIDOS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // 1. Autorização — admin_id sai daqui.
  const sessao = exigirSessao(req, res);
  if (!sessao) return; // já respondeu 401
  const adminId = sessao.adminId;

  try {
    // ── LISTAR ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // select=* para não depender da lista exata de colunas da sua tabela;
      // a senha_hash é removida aqui no servidor antes de ir pro navegador.
      const dados = await sbAdmin(
        `/rest/v1/medicos?admin_id=eq.${adminId}&select=*&order=nome`
      );
      const limpos = (dados || []).map(({ senha_hash, ...resto }) => resto);
      return json(res, 200, limpos);
    }

    // ── CRIAR ───────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const payload = sanitizar(req.body || {});
      if (!payload.nome) return json(res, 400, { erro: 'Nome é obrigatório' });
      // admin_id forçado pelo token — cliente não escolhe tenant.
      payload.admin_id = adminId;
      payload.ativo = payload.ativo ?? true;

      const criado = await sbAdmin('/rest/v1/medicos', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      // Não devolve senha_hash (nem foi setada aqui).
      return json(res, 201, criado?.[0] || null);
    }

    // ── EDITAR ──────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return json(res, 400, { erro: 'id obrigatório' });
      const payload = sanitizar(req.body || {});
      delete payload.admin_id; // nunca permite trocar de tenant

      // O filtro por admin_id garante que só edita médico do próprio tenant.
      await sbAdmin(
        `/rest/v1/medicos?id=eq.${id}&admin_id=eq.${adminId}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(payload),
        }
      );
      return json(res, 200, { ok: true });
    }

    // ── REMOVER ─────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return json(res, 400, { erro: 'id obrigatório' });
      await sbAdmin(
        `/rest/v1/medicos?id=eq.${id}&admin_id=eq.${adminId}`,
        { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
      );
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { erro: 'Método não permitido' });
  } catch (e) {
    console.error('[medicos]', e);
    return json(res, 500, { erro: 'Erro interno' });
  }
}
