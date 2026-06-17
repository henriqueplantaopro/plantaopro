// /api/medico-conta.js
import { sbAdmin, hashSenha, json, setCors, rateLimit } from './_lib.js';
import { randomUUID } from 'crypto';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 'desconhecido';
  if (!rateLimit(ip, 5, 60_000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });

  try {
    let { nome, cpf, crm, telefone, especialidade, especialidades, rqe, ufs_interesse, senha } = req.body || {};
    cpf = String(cpf || '').replace(/\D/g, '');
    if (!nome || !cpf || cpf.length < 11 || !senha) {
      return json(res, 400, { erro: 'Preencha nome, CPF e senha.' });
    }

    const hash = await hashSenha(senha);
    const existentes = await sbAdmin(`/rest/v1/medicos?cpf=eq.${cpf}&select=id,senha_hash,token_acesso`);
    const existente = existentes?.[0];

    if (existente) {
      // Já tem senha → não deixa recriar nem assumir a conta de outro.
      if (existente.senha_hash) {
        return json(res, 409, { erro: 'Já existe uma conta com esse CPF. Faça login.' });
      }
      // Cadastro feito pelo admin (sem senha): o médico define a senha agora.
      const patch = { senha_hash: hash, primeiro_acesso: false };
      if (!existente.token_acesso) patch.token_acesso = randomUUID();
      const upd = await sbAdmin(`/rest/v1/medicos?id=eq.${existente.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const { senha_hash, ...medico } = upd?.[0] || {};
      return json(res, 200, { ok: true, medico });
    }

    // Médico novo (auto-cadastro, sem empresa — fica disponível para receber convites).
    const payload = {
      nome, cpf,
      crm: crm || null,
      telefone: telefone || null,
      especialidade: especialidade || null,
      especialidades: especialidades || [],
      rqe: rqe || null,
      ufs_interesse: ufs_interesse || [],
      senha_hash: hash,
      token_acesso: randomUUID(),
      ativo: true,
      primeiro_acesso: false,
    };
    const criado = await sbAdmin('/rest/v1/medicos', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    const { senha_hash, ...medico } = criado?.[0] || {};
    return json(res, 201, { ok: true, medico });
  } catch (e) {
    console.error('[medico-conta]', e);
    return json(res, 500, { erro: 'Erro ao criar conta' });
  }
}
