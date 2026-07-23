// /api/medico-conta.js
import { sbAdmin, hashSenha, verificarSenha, json, setCors, rateLimit } from './_lib.js';
import { randomUUID } from 'crypto';
import webpush from 'web-push';

// ── VAPID (push) ─────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BKlAta-G8hOrfQ4PB6nweofnc8J_m8APNvuBjGIrMxVSe2jxp0a0WC-SRMCagxQHp2mY_vKBjEZt3_fw3gSTQhU';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
if (VAPID_PRIVATE) {
  try { webpush.setVapidDetails('mailto:suporte@plantaopro.com', VAPID_PUBLIC, VAPID_PRIVATE); } catch (_) {}
}

async function enviarPushMedico(medico_id, titulo, corpo, url, prefKey) {
  if (!VAPID_PRIVATE || !medico_id || !corpo) return { ok: true, enviados: 0 };
  // Respeitar preferência do médico
  if (prefKey) {
    try {
      const m = await sbAdmin(`/rest/v1/medicos?id=eq.${medico_id}&select=notif_prefs`);
      const prefs = m?.[0]?.notif_prefs;
      if (prefs && prefs[prefKey] === false) return { ok: true, enviados: 0, motivo: 'desativado' };
    } catch (_) {}
  }
  const subs = await sbAdmin(`/rest/v1/push_subs?medico_id=eq.${medico_id}&select=*`);
  if (!subs || !subs.length) return { ok: true, enviados: 0, motivo: 'sem inscricoes' };
  const payload = JSON.stringify({ title: titulo || 'PlantaoPro', body: corpo, url: url || '/medico/' });
  let enviados = 0; const remover = [];
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); enviados++; }
    catch (err) { if (err.statusCode === 404 || err.statusCode === 410) remover.push(s.endpoint); }
  }));
  for (const ep of remover) {
    try { await sbAdmin(`/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(ep)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); } catch (_) {}
  }
  return { ok: true, enviados };
}

// ── PERFIL DO MÉDICO (tira do navegador o acesso direto à tabela `medicos`) ──
// Campos que o próprio médico pode alterar. Nome, CRM, CPF, valor_hora,
// ativo, admin_id e projetos_vinculados continuam só pelo admin.
const CAMPOS_MEDICO = [
  'telefone', 'email',
  'especialidade', 'especialidades', 'rqe', 'rqes',
  'endereco_rua', 'endereco_numero', 'endereco_comp', 'endereco_bairro',
  'endereco_cidade', 'endereco_uf', 'endereco_cep',
  'pessoa_juridica', 'razao_social', 'cnpj',
  'pix_tipo', 'pix_chave', 'banco', 'agencia', 'conta_corrente', 'tipo_conta',
  'ufs_interesse', 'notif_prefs',
];

function limparMedico(m) {
  if (!m) return null;
  const { senha_hash, ...resto } = m;
  return resto;
}

async function medicoPorToken(token) {
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

  try {
    // ── PERFIL: ler/atualizar o próprio cadastro, senha e dispositivo ───
    if (['perfil','perfil-update','perfil-senha','perfil-device'].includes(req.query.action)) {
      if (!rateLimit(ip, 60, 60_000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });
      const { token_acesso, dados } = req.body || {};
      const medico = await medicoPorToken(token_acesso);
      if (!medico) return json(res, 401, { erro: 'Sessão inválida. Faça login novamente.' });
      if (medico.ativo === false) return json(res, 403, { erro: 'Conta inativa. Contate o administrador.' });

      if (req.query.action === 'perfil') {
        return json(res, 200, { ok: true, medico: limparMedico(medico) });
      }

      if (req.query.action === 'perfil-update') {
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

      if (req.query.action === 'perfil-senha') {
        const atual = dados?.atual, nova = dados?.nova;
        if (!nova || String(nova).length < 6) {
          return json(res, 400, { erro: 'A nova senha deve ter pelo menos 6 caracteres.' });
        }
        if (medico.senha_hash && !medico.primeiro_acesso) {
          const ok = await verificarSenha(String(atual || ''), medico.senha_hash).catch(() => false);
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

      if (req.query.action === 'perfil-device') {
        const device_id = dados?.device_id;
        if (!device_id) return json(res, 400, { erro: 'device_id obrigatório' });
        if (medico.device_id && medico.device_id !== device_id) {
          return json(res, 409, { erro: 'Já existe um dispositivo vinculado. Peça a redefinição ao administrador.' });
        }
        await sbAdmin(`/rest/v1/medicos?id=eq.${medico.id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ device_id, device_registrado_em: new Date().toISOString() }),
        });
        return json(res, 200, { ok: true });
      }
    }

    // ── NOTIFICAR TRANSFERÊNCIA ─────────────────────────────────────────
    // Chamado pelo app do médico após criar a solicitação. Trava anti-spam:
    // só dispara se a transferência existir e estiver pendente.
    if (req.query.action === 'notif-transfer') {
      if (!rateLimit(ip, 20, 60_000)) return json(res, 429, { erro: 'Muitas tentativas.' });
      const { transferencia_id } = req.body || {};
      if (!transferencia_id) return json(res, 400, { erro: 'transferencia_id obrigatório' });

      // Confere a transferência no banco (fonte de verdade — não confia no corpo)
      const tr = await sbAdmin(
        `/rest/v1/transferencias?id=eq.${transferencia_id}&select=id,status,medico_destino_id,medico_origem_id&limit=1`
      );
      const t0 = tr?.[0];
      if (!t0 || t0.status !== 'pendente') {
        return json(res, 200, { ok: true, enviados: 0, motivo: 'transferencia inexistente ou não pendente' });
      }

      // Nome do médico de origem (para a mensagem)
      let origemNome = 'Um médico';
      try {
        const o = await sbAdmin(`/rest/v1/medicos?id=eq.${t0.medico_origem_id}&select=nome`);
        if (o?.[0]?.nome) origemNome = 'Dr(a). ' + o[0].nome.split(' ')[0];
      } catch (_) {}

      const r = await enviarPushMedico(
        t0.medico_destino_id,
        'PlantaoPro',
        `${origemNome} quer transferir um plantão para você.`,
        '/medico/',
        'transferencias'
      );
      return json(res, 200, r);
    }

    // ── CRIAR CONTA / DEFINIR SENHA ─────────────────────────────────────
    if (!rateLimit(ip, 5, 60_000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });

    let { nome, cpf, crm, telefone, especialidade, especialidades, rqe, ufs_interesse, senha } = req.body || {};
    cpf = String(cpf || '').replace(/\D/g, '');
    if (!nome || !cpf || cpf.length < 11 || !senha) {
      return json(res, 400, { erro: 'Preencha nome, CPF e senha.' });
    }

    const hash = await hashSenha(senha);
    const existentes = await sbAdmin(`/rest/v1/medicos?cpf=eq.${cpf}&select=id,senha_hash,token_acesso`);
    const existente = existentes?.[0];

    if (existente) {
      if (existente.senha_hash) {
        return json(res, 409, { erro: 'Já existe uma conta com esse CPF. Faça login.' });
      }
      const patch = { senha_hash: hash, primeiro_acesso: false };
      if (!existente.token_acesso) patch.token_acesso = randomUUID();
      const upd = await sbAdmin(`/rest/v1/medicos?id=eq.${existente.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      });
      const { senha_hash, ...medico } = upd?.[0] || {};
      return json(res, 200, { ok: true, medico });
    }

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
    return json(res, 500, { erro: 'Erro interno' });
  }
}
