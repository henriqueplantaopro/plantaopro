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

// Converte data BR (dd/mm/aaaa) para ISO (aaaa-mm-dd). Retorna null se inválida/vazia.
function brParaISO(v){
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // já ISO?
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/aaaa ou dd-mm-aaaa
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2,'0'), mo = m[2].padStart(2,'0'), y = m[3];
    if (+mo>=1 && +mo<=12 && +d>=1 && +d<=31) return `${y}-${mo}-${d}`;
  }
  return null; // formato desconhecido -> não grava (evita quebrar)
}


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
  'data_admissao','tipo_vinculo','status_contrato','rqes','setores_por_projeto',
  'pos_graduacoes','especializacoes',
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

// ─── STORAGE (documentos dos médicos) ────────────────────────────────
// Bucket privado 'medico-docs'. Todo acesso passa por aqui, no servidor,
// com a service role — o navegador nunca recebe a chave nem o arquivo
// direto do bucket. Upload e download usam LINKS ASSINADOS temporários.
const DOCS_BUCKET = 'medico-docs';

function stHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
  };
}

// Gera URL assinada de UPLOAD: o navegador sobe o arquivo direto no Storage
// (sem passar pela função, então sem o limite de ~4,5 MB do corpo da Vercel).
async function storageSignedUpload(path) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/upload/sign/${DOCS_BUCKET}/${path}`,
    { method: 'POST', headers: { ...stHeaders(), 'Content-Type': 'application/json' } }
  );
  if (!r.ok) throw new Error('signed-upload ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();            // { url: '/object/upload/sign/...?token=...' }
  // devolve URL absoluta pronta para o PUT do navegador
  return process.env.SUPABASE_URL + '/storage/v1' + (j.url.startsWith('/') ? j.url : '/' + j.url);
}

// Gera URL assinada de DOWNLOAD válida por alguns minutos.
async function storageSignedDownload(path, segundos = 120) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/sign/${DOCS_BUCKET}/${path}`,
    { method: 'POST', headers: { ...stHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: segundos }) }
  );
  if (!r.ok) throw new Error('signed-download ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();            // { signedURL: '/object/sign/...?token=...' }
  return process.env.SUPABASE_URL + '/storage/v1' + (j.signedURL.startsWith('/') ? j.signedURL : '/' + j.signedURL);
}

// Remove o arquivo do bucket.
async function storageRemover(path) {
  const r = await fetch(
    `${process.env.SUPABASE_URL}/storage/v1/object/${DOCS_BUCKET}/${path}`,
    { method: 'DELETE', headers: stHeaders() }
  );
  if (!r.ok && r.status !== 404) throw new Error('storage-del ' + r.status);
  return true;
}

// Confere que o médico pertence a este admin (mesmo isolamento do PATCH).
async function medicoDoAdmin(medicoId, adminId) {
  const v = await sbAdmin(
    `/rest/v1/vinculos?medico_id=eq.${medicoId}&admin_id=eq.${adminId}&select=medico_id`
  );
  return !!(v && v.length);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const sessao = exigirSessao(req, res);
  if (!sessao) return; // já respondeu 401
  const adminId = sessao.adminId;

  try {
    // ── DOCUMENTOS: pedir URL de upload assinada ────────────────────────
    // Body: { medico_id, nome_arquivo }. Devolve { upload_url, storage_path }.
    if (req.method === 'POST' && req.query.action === 'doc-upload-url') {
      const { medico_id, nome_arquivo } = req.body || {};
      if (!medico_id || !nome_arquivo) return json(res, 400, { erro: 'medico_id e nome_arquivo obrigatórios' });
      if (!(await medicoDoAdmin(medico_id, adminId))) return json(res, 403, { erro: 'Médico não pertence à sua empresa' });
      const ext = String(nome_arquivo).includes('.') ? String(nome_arquivo).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : 'bin';
      const path = `${adminId}/${medico_id}/${randomUUID()}.${ext}`;
      const upload_url = await storageSignedUpload(path);
      return json(res, 200, { upload_url, storage_path: path });
    }

    // ── DOCUMENTOS: registrar metadados depois do upload ────────────────
    // Body: { medico_id, tipo_id, nome_arquivo, storage_path, tamanho, content_type }
    if (req.method === 'POST' && req.query.action === 'doc-registrar') {
      const b = req.body || {};
      if (!b.medico_id || !b.storage_path || !b.nome_arquivo) return json(res, 400, { erro: 'dados incompletos' });
      if (!(await medicoDoAdmin(b.medico_id, adminId))) return json(res, 403, { erro: 'Médico não pertence à sua empresa' });
      const reg = await sbAdmin('/rest/v1/documentos_medico', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          admin_id: adminId, medico_id: b.medico_id, tipo_id: b.tipo_id || null,
          nome_arquivo: b.nome_arquivo, storage_path: b.storage_path,
          tamanho: b.tamanho || null, content_type: b.content_type || null,
        }),
      });
      return json(res, 201, reg?.[0] || {});
    }

    // ── DOCUMENTOS: todos os do admin (para calcular pendências na lista) ─
    if (req.method === 'GET' && req.query.action === 'doc-todos') {
      const docs = await sbAdmin(
        `/rest/v1/documentos_medico?admin_id=eq.${adminId}&select=id,medico_id,tipo_id,nome_arquivo`
      );
      return json(res, 200, docs || []);
    }

    // ── DOCUMENTOS: listar os de um médico ──────────────────────────────
    if (req.method === 'GET' && req.query.action === 'doc-listar') {
      const medico_id = req.query.medico_id;
      if (!medico_id) return json(res, 400, { erro: 'medico_id obrigatório' });
      if (!(await medicoDoAdmin(medico_id, adminId))) return json(res, 403, { erro: 'Médico não pertence à sua empresa' });
      const docs = await sbAdmin(
        `/rest/v1/documentos_medico?medico_id=eq.${medico_id}&admin_id=eq.${adminId}&select=*&order=criado_em.asc`
      );
      return json(res, 200, docs || []);
    }

    // ── DOCUMENTOS: link de download assinado de um documento ───────────
    if (req.method === 'GET' && req.query.action === 'doc-url') {
      const id = req.query.id;
      if (!id) return json(res, 400, { erro: 'id obrigatório' });
      const d = await sbAdmin(`/rest/v1/documentos_medico?id=eq.${id}&admin_id=eq.${adminId}&select=storage_path,nome_arquivo`);
      if (!d || !d.length) return json(res, 404, { erro: 'documento não encontrado' });
      const url = await storageSignedDownload(d[0].storage_path, 120);
      return json(res, 200, { url, nome_arquivo: d[0].nome_arquivo });
    }

    // ── DOCUMENTOS: excluir ─────────────────────────────────────────────
    if (req.method === 'DELETE' && req.query.action === 'doc-del') {
      const id = req.query.id;
      if (!id) return json(res, 400, { erro: 'id obrigatório' });
      const d = await sbAdmin(`/rest/v1/documentos_medico?id=eq.${id}&admin_id=eq.${adminId}&select=storage_path`);
      if (!d || !d.length) return json(res, 404, { erro: 'documento não encontrado' });
      try { await storageRemover(d[0].storage_path); } catch (_) {}
      await sbAdmin(`/rest/v1/documentos_medico?id=eq.${id}&admin_id=eq.${adminId}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' },
      });
      return json(res, 200, { ok: true });
    }

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
          // data de nascimento: BR -> ISO (ou null se inválida)
          if (p.data_nascimento !== undefined) p.data_nascimento = brParaISO(p.data_nascimento);
          if (!p.nome) { erros++; continue; } // nome não pode virar null
          // normalizar data_nascimento DD/MM/AAAA -> AAAA-MM-DD (senão null)
          if (p.data_nascimento) {
            const v = String(p.data_nascimento).trim();
            let iso = null;
            let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) iso = m[1]+'-'+m[2]+'-'+m[3];
            else {
              m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
              if (m && +m[2]>=1 && +m[2]<=12 && +m[1]>=1 && +m[1]<=31)
                iso = m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
            }
            p.data_nascimento = iso; // inválida -> null (não quebra o insert)
          }
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

    // ── VINCULAR MÉDICO À MINHA EMPRESA (aprovação de vaga pública) ──────
    // Idempotente: se já existe vínculo, apenas garante status ativo.
    if (req.method === 'POST' && req.query.action === 'vincular') {
      const { medico_id, projeto_id } = req.body || {};
      if (!medico_id) return json(res, 400, { erro: 'medico_id obrigatório' });

      let ja_vinculado = false;
      const v = await sbAdmin(
        `/rest/v1/vinculos?medico_id=eq.${medico_id}&admin_id=eq.${adminId}&select=id,status`
      );
      if (v && v.length) {
        ja_vinculado = true;
        if (v[0].status !== 'ativo') {
          await sbAdmin(`/rest/v1/vinculos?id=eq.${v[0].id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'ativo' }),
          });
        }
      } else {
        await sbAdmin('/rest/v1/vinculos', {
          method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ medico_id, admin_id: adminId, status: 'ativo' }),
        });
      }

      // Soma o projeto aos projetos do médico (só se o projeto for desta empresa)
      let projeto_adicionado = false;
      if (projeto_id) {
        const p = await sbAdmin(
          `/rest/v1/projetos?id=eq.${projeto_id}&admin_id=eq.${adminId}&select=id`
        );
        if (p && p.length) {
          const m = await sbAdmin(`/rest/v1/medicos?id=eq.${medico_id}&select=projetos_vinculados`);
          const atuais = m?.[0]?.projetos_vinculados || [];
          if (!atuais.includes(projeto_id)) {
            await sbAdmin(`/rest/v1/medicos?id=eq.${medico_id}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ projetos_vinculados: [...atuais, projeto_id] }),
            });
            projeto_adicionado = true;
          }
        }
      }
      return json(res, 200, { ok: true, ja_vinculado, projeto_adicionado });
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
