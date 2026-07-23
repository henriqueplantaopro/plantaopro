// /api/medico-perfil.js
// Concentra no servidor tudo que o app do médico fazia direto na tabela `medicos`.
// Autenticação: token_acesso do próprio médico (secreto, individual).
// Objetivo de segurança: permitir REVOKE das colunas sensíveis para o papel anon,
// sem que o app precise mais lê-las/gravá-las com a chave pública.

import { sbAdmin, hashSenha, verificarSenha, json, setCors, rateLimit } from './_lib.js';
import { randomUUID } from 'crypto';

// Campos que o próprio médico pode alterar no seu cadastro.
// Tudo que não estiver aqui é ignorado (nome, crm, cpf, valor_hora, ativo,
// admin_id, senha_hash e projetos_vinculados só mudam pelo admin).
const CAMPOS_MEDICO = [
  'telefone', 'email',
  'especialidade', 'especialidades', 'rqe', 'rqes',
  'endereco_rua', 'endereco_numero', 'endereco_comp', 'endereco_bairro',
  'endereco_cidade', 'endereco_uf', 'endereco_cep',
  'pessoa_juridica', 'razao_social', 'cnpj',
  'pix_tipo', 'pix_chave', 'banco', 'agencia', 'conta_corrente', 'tipo_conta',
  'ufs_interesse', 'notif_prefs',
];

// Nunca sai do servidor
function limpar(medico) {
  if (!medico) return null;
  const { senha_hash, ...resto } = medico;
  return resto;
}

async function buscarPorToken(token) {
  if (!token) return null;
  const r = await sbAdmin(
    `/rest/v1/medicos?token_acesso=eq.${encodeURIComponent(token)}&select=*&limit=1`
  );
  return r?.[0] || null;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 'desconhecido';
  if (!rateLimit(ip, 60, 60_000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });

  try {
    const { token_acesso, action, dados } = req.body || {};
    const medico = await buscarPorToken(token_acesso);
    if (!medico) return json(res, 401, { erro: 'Sessão inválida. Faça login novamente.' });
    if (medico.ativo === false) return json(res, 403, { erro: 'Conta inativa. Contate o administrador.' });

    // ── LER O PRÓPRIO CADASTRO ────────────────────────────────────────
    if (!action || action === 'get') {
      return json(res, 200, { ok: true, medico: limpar(medico) });
    }

    // ── ATUALIZAR DADOS DO PRÓPRIO CADASTRO ───────────────────────────
    if (action === 'update') {
      const patch = {};
      for (const k of CAMPOS_MEDICO) {
        if (dados && dados[k] !== undefined) patch[k] = dados[k];
      }
      if (!Object.keys(patch).length) return json(res, 400, { erro: 'Nada para atualizar' });
      await sbAdmin(`/rest/v1/medicos?id=eq.${medico.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      return json(res, 200, { ok: true, atualizado: Object.keys(patch) });
    }

    // ── TROCAR A SENHA (validação e hash no servidor) ──────────────────
    if (action === 'senha') {
      const atual = dados?.atual;
      const nova  = dados?.nova;
      if (!nova || String(nova).length < 6) {
        return json(res, 400, { erro: 'A nova senha deve ter pelo menos 6 caracteres.' });
      }
      // Se já existe senha definida, exige a atual. No primeiro acesso, não.
      if (medico.senha_hash && !medico.primeiro_acesso) {
        const ok = await verificarSenha(String(atual || ''), medico.senha_hash)
          .catch(() => false);
        // compatibilidade com senhas legadas gravadas em texto puro
        const okLegado = !ok && medico.senha_hash === String(atual || '');
        if (!ok && !okLegado) return json(res, 401, { erro: 'Senha atual incorreta.' });
      }
      const hash = await hashSenha(String(nova));
      await sbAdmin(`/rest/v1/medicos?id=eq.${medico.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ senha_hash: hash, primeiro_acesso: false }),
      });
      return json(res, 200, { ok: true });
    }

    // ── VINCULAR / REGISTRAR DISPOSITIVO ──────────────────────────────
    if (action === 'device') {
      const device_id = dados?.device_id;
      if (!device_id) return json(res, 400, { erro: 'device_id obrigatório' });
      // Só permite vincular se ainda não houver dispositivo (troca é pelo admin)
      if (medico.device_id && medico.device_id !== device_id) {
        return json(res, 409, { erro: 'Já existe um dispositivo vinculado. Peça a redefinição ao administrador.' });
      }
      await sbAdmin(`/rest/v1/medicos?id=eq.${medico.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ device_id, device_registrado_em: new Date().toISOString() }),
      });
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { erro: 'Ação desconhecida' });
  } catch (e) {
    console.error('[medico-perfil]', e);
    return json(res, 500, { erro: 'Erro interno' });
  }
}
