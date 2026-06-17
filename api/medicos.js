// /api/medicos.js
import { sbAdmin, hashSenha, json, setCors } from './_lib.js';
import { exigirSessao } from './_auth.js';
import { randomUUID } from 'crypto';

// Colunas seguras (referência — o GET usa select=* e remove senha_hash no servidor).
const SELECT_MEDICO =
  'id,admin_id,nome,crm,rqe,especialidade,especialidades,cpf,email,telefone,' +
  'data_nascimento,tipo,valor_hora,token_acesso,primeiro_acesso,cpf_proprio,' +
  'device_id,device_registrado_em,ativo,endereco_rua,endereco_numero,' +
  'endereco_comp,endereco_bairro,endereco_cidade,endereco_uf,endereco_cep,' +
  'pessoa_juridica,razao_social,cnpj,pix_tipo,pix_chave,banco,agencia,' +
  'conta_corrente,tipo_conta,ufs_interesse,projetos_vinculados,criado_em';

const CAMPOS_PERMITIDOS = [
  'nome','crm','rqe','especialidade','especialidades','cpf','email','telefone',
  'data_nascimento','tipo','valor_hora','ativo','endereco_rua','endereco_numero',
  'endereco_comp','endereco_bairro','endereco_cidade','endereco_uf','endereco_cep',
  'pessoa_juridica','razao_social','cnpj','pix_tipo','pix_chave','banco','agencia',
  'conta_corrente','tipo_conta','ufs_interesse','projetos_vinculados',
  'device_id','device_registrado_em', // reset de dispositivo
];

function sanitizar(body) {
  const out = {};
  for (const k of CAMPOS_PERMITIDOS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

function gerarSenhaProvisoria() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const sessao = exigirSessao(req, res);
  if (!sessao) return; // já respondeu 401
  const adminId = sessao.adminId;

  try {
    // ── LISTAR ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const dados = await sbAdmin(
        `/rest/v1/medicos?select=*,vinculos!inner(admin_id,status)&vinculos.admin_id=eq.${adminId}&vinculos.status=eq.ativo&order=nome`
      );
      const limpos = (dados || []).map(({ senha_hash, vinculos, ...resto }) => resto);
      return json(res, 200, limpos);
    }

    // ── CRIAR ───────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const payload = sanitizar(req.body || {});
      if (!payload.nome) return json(res, 400, { erro: 'Nome é obrigatório' });
      payload.admin_id = adminId;             // tenant vem do token
      payload.ativo = payload.ativo ?? true;
      payload.token_acesso = randomUUID();    // garante link de acesso

      const criado = await sbAdmin('/rest/v1/medicos', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      const { senha_hash, ...resto } = criado?.[0] || {};
      return json(res, 201, resto);
    }

    // ── EDITAR / AÇÕES ──────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return json(res, 400, { erro: 'id obrigatório' });

      // Confirma que o médico está vinculado à minha empresa (isolamento)
      const vinc = await sbAdmin(
        `/rest/v1/vinculos?medico_id=eq.${id}&admin_id=eq.${adminId}&select=medico_id`
      );
      if (!vinc || !vinc.length) {
        return json(res, 403, { erro: 'Médico não pertence à sua empresa' });
      }

      // Ação especial: redefinir senha (servidor gera + faz o hash)
      if (req.query.action === 'reset-senha') {
        const provisoria = gerarSenhaProvisoria();
        const hash = await hashSenha(provisoria);
        await sbAdmin(`/rest/v1/medicos?id=eq.${id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ senha_hash: hash }),
        });
        return json(res, 200, { ok: true, senha: provisoria });
      }

      // Edição normal
      const payload = sanitizar(req.body || {});
      delete payload.admin_id;
      await sbAdmin(`/rest/v1/medicos?id=eq.${id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(payload),
      });
      return json(res, 200, { ok: true });
    }

    // ── REMOVER = desvincular da minha empresa ──────────────────────────
    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return json(res, 400, { erro: 'id obrigatório' });
      await sbAdmin(
        `/rest/v1/vinculos?medico_id=eq.${id}&admin_id=eq.${adminId}`,
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
