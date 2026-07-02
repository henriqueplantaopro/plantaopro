// /api/enviar-push.js
// Dispara notificacao push para um medico (todas as inscricoes dele).
// Uso interno: chamado por outros endpoints/telas apos um evento
// (escala, vaga aberta, transferencia). Respeita a preferencia do medico.
import webpush from 'web-push';
import { sbAdmin, json, setCors } from './_lib.js';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BKlAta-G8hOrfQ4PB6nweofnc8J_m8APNvuBjGIrMxVSe2jxp0a0WC-SRMCagxQHp2mY_vKBjEZt3_fw3gSTQhU';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';

if (VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:suporte@plantaopro.com', VAPID_PUBLIC, VAPID_PRIVATE);
}

// mapeia o "tipo" do evento para a chave de preferencia do medico
const TIPO_PREF = {
  escala: 'escalas',
  vaga: 'vagas',
  transferencia: 'transferencias',
  checkin: 'checkin',
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Metodo nao permitido' });
  if (!VAPID_PRIVATE) return json(res, 500, { erro: 'VAPID_PRIVATE nao configurada' });

  try {
    const { medico_id, titulo, corpo, url, tipo } = req.body || {};
    if (!medico_id || !corpo) return json(res, 400, { erro: 'medico_id e corpo sao obrigatorios' });

    // Respeitar preferencia do medico (se o tipo tiver uma chave mapeada)
    const prefKey = tipo ? TIPO_PREF[tipo] : null;
    if (prefKey) {
      try {
        const m = await sbAdmin(`/rest/v1/medicos?id=eq.${medico_id}&select=notif_prefs`);
        const prefs = m?.[0]?.notif_prefs;
        // se o medico desligou esse tipo explicitamente, nao envia
        if (prefs && prefs[prefKey] === false) {
          return json(res, 200, { ok: true, enviados: 0, motivo: 'desativado pelo medico' });
        }
      } catch (_) { /* sem prefs = envia por padrao */ }
    }

    const subs = await sbAdmin(`/rest/v1/push_subs?medico_id=eq.${medico_id}&select=*`);
    if (!subs || !subs.length) return json(res, 200, { ok: true, enviados: 0, motivo: 'sem inscricoes' });

    const payload = JSON.stringify({
      title: titulo || 'PlantaoPro',
      body: corpo,
      url: url || '/medico/',
    });

    let enviados = 0;
    const remover = [];
    await Promise.all(subs.map(async (s) => {
      const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(subscription, payload);
        enviados++;
      } catch (err) {
        // 404/410 = inscricao morta (app desinstalado / permissao revogada) -> limpar
        if (err.statusCode === 404 || err.statusCode === 410) remover.push(s.endpoint);
      }
    }));

    // Limpar inscricoes mortas
    for (const ep of remover) {
      try {
        await sbAdmin(`/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(ep)}`,
          { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      } catch (_) {}
    }

    return json(res, 200, { ok: true, enviados, removidos: remover.length });
  } catch (e) {
    console.error('[enviar-push]', e);
    return json(res, 500, { erro: 'Erro interno' });
  }
}
