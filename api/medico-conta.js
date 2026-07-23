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

    // ── LANÇAMENTOS DO MÉDICO (tira a tabela `lancamentos` do navegador) ─
    if (['lanc-meus','lanc-abertos','lanc-passar','lanc-ausencia','lanc-aceitar'].includes(req.query.action)) {
      if (!rateLimit(ip, 60, 60_000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });
      const { token_acesso, dados } = req.body || {};
      const medico = await medicoPorToken(token_acesso);
      if (!medico) return json(res, 401, { erro: 'Sessão inválida. Faça login novamente.' });

      const hoje = new Date().toISOString().slice(0, 10);

      // Meus plantões (sempre escopado ao médico autenticado)
      if (req.query.action === 'lanc-meus') {
        const d1 = dados?.d1 || hoje;
        const d2 = dados?.d2 || null;
        const campos = dados?.campos || '*,projetos(nome)';
        let path = `/rest/v1/lancamentos?medico_id=eq.${medico.id}&data=gte.${d1}` +
                   `&select=${encodeURIComponent(campos)}&order=data.asc&limit=500`;
        if (d2) path += `&data=lte.${d2}`;
        const r = await sbAdmin(path);
        return json(res, 200, { ok: true, lancamentos: r || [] });
      }

      // Vagas em aberto (a filtragem por público-alvo continua no app)
      if (req.query.action === 'lanc-abertos') {
        const r = await sbAdmin(
          `/rest/v1/lancamentos?aberto=eq.true&data=gte.${hoje}` +
          `&select=*,projetos(nome,admin_id)&order=data,hora_ini&limit=500`
        );
        return json(res, 200, { ok: true, lancamentos: r || [] });
      }

      // Confere se o plantão é mesmo do médico antes de qualquer escrita
      async function meuPlantao(id) {
        if (!id) return null;
        const r = await sbAdmin(`/rest/v1/lancamentos?id=eq.${id}&select=id,medico_id&limit=1`);
        const l = r?.[0];
        return (l && l.medico_id === medico.id) ? l : null;
      }

      // Deixar o plantão em aberto para o projeto
      if (req.query.action === 'lanc-passar') {
        const l = await meuPlantao(dados?.lancamento_id);
        if (!l) return json(res, 403, { erro: 'Este plantão não é seu.' });
        await sbAdmin(`/rest/v1/lancamentos?id=eq.${l.id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            aberto: true, publico_alvo: 'projeto',
            transferido_de: medico.id, transferido_de_nome: medico.nome || '',
            medico_id: null, confirmado: false,
          }),
        });
        return json(res, 200, { ok: true });
      }

      // Avisar que não vai comparecer
      if (req.query.action === 'lanc-ausencia') {
        const l = await meuPlantao(dados?.lancamento_id);
        if (!l) return json(res, 403, { erro: 'Este plantão não é seu.' });
        await sbAdmin(`/rest/v1/lancamentos?id=eq.${l.id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ ausencia_informada: true }),
        });
        return json(res, 200, { ok: true });
      }

      // Aceitar transferência: só se existir transferência pendente para este médico
      if (req.query.action === 'lanc-aceitar') {
        const lid = dados?.lancamento_id;
        if (!lid) return json(res, 400, { erro: 'lancamento_id obrigatório' });
        const tr = await sbAdmin(
          `/rest/v1/transferencias?lancamento_id=eq.${lid}` +
          `&medico_destino_id=eq.${medico.id}&select=id,status&limit=1`
        );
        if (!tr?.length) return json(res, 403, { erro: 'Não há transferência deste plantão para você.' });
        await sbAdmin(`/rest/v1/lancamentos?id=eq.${lid}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            medico_id: medico.id, confirmado: true,
            confirmado_em: new Date().toISOString(),
          }),
        });
        return json(res, 200, { ok: true });
      }
    }

    // ── CANDIDATURAS E TRANSFERÊNCIAS DO MÉDICO ─────────────────────────
    if (['cand-minhas','cand-criar','tr-enviadas','tr-recebidas','tr-criar','tr-responder'].includes(req.query.action)) {
      if (!rateLimit(ip, 60, 60_000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });
      const { token_acesso, dados } = req.body || {};
      const medico = await medicoPorToken(token_acesso);
      if (!medico) return json(res, 401, { erro: 'Sessão inválida. Faça login novamente.' });

      // Minhas candidaturas
      if (req.query.action === 'cand-minhas') {
        const r = await sbAdmin(`/rest/v1/candidaturas?medico_id=eq.${medico.id}&select=*&limit=500`);
        return json(res, 200, { ok: true, candidaturas: r || [] });
      }

      // Candidatar-se: o servidor decide o medico_id e confere se a vaga aceita este médico
      if (req.query.action === 'cand-criar') {
        const lid = dados?.lancamento_id;
        if (!lid) return json(res, 400, { erro: 'lancamento_id obrigatório' });
        const ll = await sbAdmin(
          `/rest/v1/lancamentos?id=eq.${lid}&select=id,aberto,vagas,vagas_preenchidas,especialidades_alvo,exige_rqe&limit=1`
        );
        const l = ll?.[0];
        if (!l || !l.aberto) return json(res, 409, { erro: 'Esta vaga não está mais aberta.' });
        if ((l.vagas || 1) <= (l.vagas_preenchidas || 0)) {
          return json(res, 409, { erro: 'As vagas deste plantão já foram preenchidas.' });
        }
        // Trava de especialidade: vaga de especialista só aceita quem tem a especialidade
        const alvo = l.especialidades_alvo || [];
        if (alvo.length) {
          const minhas = []
            .concat(medico.especialidades || [])
            .concat(medico.especialidade ? [medico.especialidade] : []);
          const ok = alvo.some((e) => minhas.includes(e));
          if (!ok) return json(res, 403, { erro: 'Esta vaga exige uma especialidade que não consta no seu cadastro.' });
        }
        if (l.exige_rqe && !medico.rqe && !(medico.rqes || []).length) {
          return json(res, 403, { erro: 'Esta vaga exige RQE registrado no seu cadastro.' });
        }
        // Evita candidatura duplicada
        const ja = await sbAdmin(
          `/rest/v1/candidaturas?lancamento_id=eq.${lid}&medico_id=eq.${medico.id}&select=id&limit=1`
        );
        if (ja?.length) return json(res, 409, { erro: 'Você já se candidatou a esta vaga.' });
        const criado = await sbAdmin('/rest/v1/candidaturas', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            lancamento_id: lid, medico_id: medico.id,
            status: 'pendente', obs: dados?.obs || null,
          }),
        });
        return json(res, 200, { ok: true, candidatura: criado?.[0] || null });
      }

      // Transferências que eu enviei (para marcar "aguardando resposta")
      if (req.query.action === 'tr-enviadas') {
        const r = await sbAdmin(
          `/rest/v1/transferencias?medico_origem_id=eq.${medico.id}&status=eq.pendente&select=lancamento_id`
        );
        return json(res, 200, { ok: true, transferencias: r || [] });
      }

      // Transferências que recebi
      if (req.query.action === 'tr-recebidas') {
        const r = await sbAdmin(
          `/rest/v1/transferencias?medico_destino_id=eq.${medico.id}` +
          `&select=*,medicos!transferencias_medico_origem_id_fkey(nome,crm),lancamentos(data,hora_ini,hora_fim,setor,projetos(nome))` +
          `&order=criado_em.desc&limit=100`
        );
        return json(res, 200, { ok: true, transferencias: r || [] });
      }

      // Criar transferência: origem é sempre quem está autenticado, e o plantão precisa ser dele
      if (req.query.action === 'tr-criar') {
        const lid = dados?.lancamento_id, destino = dados?.medico_destino_id;
        if (!lid || !destino) return json(res, 400, { erro: 'Dados incompletos' });
        const ll = await sbAdmin(`/rest/v1/lancamentos?id=eq.${lid}&select=id,medico_id&limit=1`);
        if (ll?.[0]?.medico_id !== medico.id) return json(res, 403, { erro: 'Este plantão não é seu.' });
        const criado = await sbAdmin('/rest/v1/transferencias', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            lancamento_id: lid, medico_origem_id: medico.id,
            medico_destino_id: destino, mensagem: dados?.mensagem || null,
            status: 'pendente',
          }),
        });
        return json(res, 200, { ok: true, transferencia: criado?.[0] || null });
      }

      // Responder transferência: só o destinatário pode
      if (req.query.action === 'tr-responder') {
        const tid = dados?.transferencia_id, status = dados?.status;
        if (!tid || !['aceito','recusado'].includes(status)) {
          return json(res, 400, { erro: 'Dados inválidos' });
        }
        const tt = await sbAdmin(`/rest/v1/transferencias?id=eq.${tid}&select=id,medico_destino_id&limit=1`);
        if (tt?.[0]?.medico_destino_id !== medico.id) {
          return json(res, 403, { erro: 'Esta transferência não é sua.' });
        }
        await sbAdmin(`/rest/v1/transferencias?id=eq.${tid}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status, respondido_em: new Date().toISOString() }),
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
