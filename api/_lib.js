// /api/_lib.js
// Helpers compartilhados pelas Vercel Functions.
// Importado via: import { sbAdmin, asaas, hashSenha, verificarSenha } from './_lib.js';

import bcrypt from 'bcryptjs';

// ─── Variáveis de ambiente (configure no painel da Vercel) ────────────────
// SUPABASE_URL                — https://hqtnnadzwtfyfkunwfcy.supabase.co
// SUPABASE_SERVICE_KEY   — service_role key (NÃO a anon!). Vem das Settings > API do Supabase
// ASAAS_API_KEY               — $aact_prod_... (produção) ou $aact_hmlg_... (sandbox)
// ASAAS_BASE_URL              — https://api.asaas.com/v3  (prod)  ou  https://api-sandbox.asaas.com/v3  (sandbox)
// ASAAS_WEBHOOK_TOKEN         — token configurado no painel Asaas em Webhooks
// JWT_SECRET                  — string aleatória de pelo menos 32 caracteres para assinar tokens de sessão
// APP_BASE_URL                — https://plantaopro-git-main-henriqueplantaopros-projects.vercel.app

// ─── Wrapper Supabase Service Role ──────────────────────────────────────────
// Service role bypassa RLS — use APENAS no servidor, nunca exposto ao browser.
export async function sbAdmin(path, opts = {}) {
  const url = process.env.SUPABASE_URL + path;
  const r = await fetch(url, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'POST' ? 'return=representation' : (opts.headers?.Prefer || ''),
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase ${r.status}: ${txt.slice(0, 200)}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

// ─── Wrapper Asaas ─────────────────────────────────────────────────────────
export async function asaas(endpoint, opts = {}) {
  const url = process.env.ASAAS_BASE_URL + endpoint;
  const r = await fetch(url, {
    ...opts,
    headers: {
      access_token: process.env.ASAAS_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'PlantaoPro/1.0',
      ...(opts.headers || {}),
    },
  });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!r.ok) {
    const msg = data?.errors?.[0]?.description || data?.raw || 'Erro Asaas';
    throw new Error(`Asaas ${r.status}: ${msg}`);
  }
  return data;
}

// ─── Senhas (bcrypt) ────────────────────────────────────────────────────────
// Custo 10 é o padrão da indústria — leva ~70ms num servidor moderno
// e torna brute-force computacionalmente caro mesmo com a tabela inteira vazada.
export async function hashSenha(senhaTextoPuro) {
  return bcrypt.hash(senhaTextoPuro, 10);
}
export async function verificarSenha(senhaTextoPuro, hashArmazenado) {
  if (!senhaTextoPuro || !hashArmazenado) return false;
  // bcrypt hashes começam com $2a$, $2b$ ou $2y$
  if (!/^\$2[aby]\$/.test(hashArmazenado)) {
    // Senha legacy em texto puro — compara direto (apenas durante migração)
    // O endpoint de login deve atualizar para hash bcrypt na primeira autenticação bem-sucedida.
    return senhaTextoPuro === hashArmazenado;
  }
  return bcrypt.compare(senhaTextoPuro, hashArmazenado);
}

// ─── Validações ─────────────────────────────────────────────────────────────
export function validarEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
export function validarCNPJ(cnpj) {
  // Apenas valida tamanho — você pode plugar uma lib se quiser DV completo
  const d = String(cnpj || '').replace(/\D/g, '');
  return d.length === 14;
}
export function limparCNPJ(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}
export function limparTelefone(tel) {
  return String(tel || '').replace(/\D/g, '');
}

// ─── Resposta JSON padronizada ──────────────────────────────────────────────
export function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(body));
}

// ─── CORS (opcional — descomentar se chamar de outro domínio) ───────────────
export function setCors(res) {
  // Só liberar a origem da sua landing — não use '*' em produção
  res.setHeader('Access-Control-Allow-Origin', process.env.APP_BASE_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ─── Rate limiting básico em memória ────────────────────────────────────────
// Limita 5 tentativas/min por IP. Para algo mais sério use Upstash Redis.
const tentativas = new Map();
export function rateLimit(ip, limite = 5, janelaMs = 60_000) {
  const agora = Date.now();
  const reg = tentativas.get(ip) || { count: 0, expira: agora + janelaMs };
  if (agora > reg.expira) { reg.count = 0; reg.expira = agora + janelaMs; }
  reg.count += 1;
  tentativas.set(ip, reg);
  return reg.count <= limite;
}

// ─── JWT simples (sem biblioteca, HMAC SHA-256) ─────────────────────────────
// Use o cookie HttpOnly retornado para autenticar requisições subsequentes.
import crypto from 'crypto';
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
export function assinarJWT(payload, expiraEmSegundos = 60 * 60 * 24 * 7) { // 7 dias
  const header = { alg: 'HS256', typ: 'JWT' };
  const corpo = { ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + expiraEmSegundos };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(corpo));
  const sig = b64url(crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}
export function verificarJWT(token) {
  if (!token || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [h, p, sig] = partes;
  const esperado = b64url(crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${h}.${p}`).digest());
  // Comparação em tempo constante
  if (esperado.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(sig))) return null;
  const corpo = JSON.parse(Buffer.from(p, 'base64').toString('utf-8'));
  if (corpo.exp && Math.floor(Date.now()/1000) > corpo.exp) return null;
  return corpo;
}
