// /api/medicos.js
import { sbAdmin, hashSenha, json, setCors } from './_lib.js';
import { exigirSessao } from './_auth.js';
import { randomUUID } from 'crypto';
import webpush from 'web-push';

// ── VAPID (push) ─────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BKlAta-G8hOrfQ4PB6nweofnc8J_m8APNvuBjGIrMxVSe2jxp0a0WC-SRMCagxQHp2mY_vKBjEZt3_fw3gSTQhU';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
if (VAPID_PRIVATE) {
  try { webpush.setVapidDetails('mailto:suporte@plantaopro.com', VAPID_PUBLIC, VAPID_PRIVATE); } catch (_) {}
}
const TIPO_PREF = { escala: 'escalas', vaga: 'vagas', transferencia: 'transferencias', checkin: 'checkin' };

async function enviarPush({ medico_id, titulo, corpo, url, tipo }) {
  if (!VAPID_PRIVATE) return { erro: 'VAPID_PRIVATE nao configurada', status: 500 };
  if (!medico_id || !corpo) return { erro: 'medico_id e corpo obrigatorios', status: 400 };

  // Respeitar preferencia do medico
  const prefKey = tipo ? TIPO_PREF[tipo] : null;
  if (prefKey) {
    try {
      const m = await sbAdmin(`/rest/v1/medicos?id=eq.${medico_id}&select=notif_prefs`);
      const prefs = m?.[0]?.notif_prefs;
      if (prefs && prefs[prefKey] === false) return { ok: true, enviados: 0, motivo: 'desativado pelo medico' };
    } catch (_) {}
  }

  const subs = await sbAdmin(`/rest/v1/push_subs?medico_id=eq.${medico_id}&select=*`);
  if (!subs || !subs.length) return { ok: true, enviados: 0, motivo: 'sem inscricoes' };

  const payload = JSON.stringify({ title: titulo || 'PlantaoPro', body: corpo, url: url || '/medico/' });
  let enviados = 0; const remover = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      enviados++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) remover.push(s.endpoint);
    }
  }));
  for (const ep of remover) {
    try { await sbAdmin(`/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(ep)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); } catch (_) {}
  }
  return { ok: true, enviados, removidos: remover.length };
}

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
    // ── IMPORTAR EM LOTE (casar por CRM: cria novos, atualiza existentes) ─
    if (req.method === 'POST' && req.query.action === 'importar') {
      const lista = Array.isArray(req.body) ? req.body : [];
      if (!lista.length) return json(res, 400, { erro: 'Envie um array de médicos' });
      if (lista.length > 200) return json(res, 400, { erro: 'Máximo 200 por lote' });

      let criados = 0, atualizados = 0, erros = 0;
      const detalhes = [];

      // CRMs desta empresa já existentes (para decidir criar x atualizar)
      // Busca os vínculos + crm dos médicos já ligados a este admin
      let existentesPorCrm = {};
      try {
        const meus = await sbAdmin(
          `/rest/v1/medicos?select=id,crm&admin_id=eq.${adminId}`
        );
        for (const m of (meus || [])) {
          if (m.crm) existentesPorCrm[String(m.crm).trim()] = m.id;
        }
      } catch (_) {}

      for (const bruto of lista) {
        try {
          const p = sanitizar(bruto || {});
          if (!p.nome || !p.crm) { erros++; detalhes.push({ nome: bruto?.nome || '?', erro: 'sem nome ou CRM' }); continue; }
          // normalizar 'tipo' (planilha costuma vir vazia)
          const _tiposOk = ['Plantonista','Diarista','Coordenador','Residente'];
          if (!p.tipo || !_tiposOk.includes(String(p.tipo).trim())) p.tipo = 'Plantonista';
          // campos string vazios -> null (evita quebrar constraints)
          for (const k of Object.keys(p)) { if (p[k] === '') p[k] = null; }
          if (!p.nome) { erros++; continue; } // nome não pode virar null
          const crmKey = String(p.crm).trim();
          const existenteId = existentesPorCrm[crmKey];

          if (existenteId) {
            delete p.admin_id;
            await sbAdmin(`/rest/v1/medicos?id=eq.${existenteId}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify(p),
            });
            atualizados++;
          } else {
            p.admin_id = adminId;
            p.ativo = p.ativo ?? true;
            p.token_acesso = randomUUID();
            const criado = await sbAdmin('/rest/v1/medicos', {
              method: 'POST', headers: { Prefer: 'return=representation' },
              body: JSON.stringify(p),
            });
            // registrar na cache para não duplicar se o CRM repetir no mesmo lote
            if (criado?.[0]?.id) existentesPorCrm[crmKey] = criado[0].id;
            criados++;
          }
        } catch (e) {
          erros++; detalhes.push({ nome: bruto?.nome || '?', erro: String(e?.message || e) });
        }
      }
      return json(res, 200, { ok: true, criados, atualizados, erros, detalhes: detalhes.slice(0, 20) });
    }

    // ── ENVIAR PUSH (escala, vaga) ──────────────────────────────────────
    if (req.method === 'POST' && req.query.action === 'push') {
      const r = await enviarPush(req.body || {});
      return json(res, r.status || 200, r);
    }

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
