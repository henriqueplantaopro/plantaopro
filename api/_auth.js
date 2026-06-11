// /api/_auth.js
// ----------------------------------------------------------------------------
// Middleware de autorização do Caminho B.
// Toda Function que acessa dados deve começar chamando exigirSessao(req,res).
// Ela lê o cookie HttpOnly 'pp_session', valida o JWT (assinado no login),
// e devolve { sub, tipo, admin_id, perfil }. Se inválido, responde 401 e
// retorna null — a Function deve apenas `return` nesse caso.
//
// IMPORTANTE: o admin_id SEMPRE vem do token, NUNCA do body/query do cliente.
// É isso que impede um tenant de ler dados de outro.
// ----------------------------------------------------------------------------
import { verificarJWT, json } from './_lib.js';

// Lê um cookie específico do header Cookie.
function lerCookie(req, nome) {
  const raw = req.headers?.cookie || '';
  for (const parte of raw.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Exige sessão válida. Retorna o payload do token ou null (já respondeu 401).
export function exigirSessao(req, res) {
  const token = lerCookie(req, 'pp_session');
  const payload = verificarJWT(token);
  if (!payload || !payload.admin_id) {
    json(res, 401, { erro: 'Sessão inválida ou expirada. Faça login novamente.' });
    return null;
  }
  return {
    sub: payload.sub,
    tipo: payload.tipo,                 // 'admin' | 'usuario'
    adminId: payload.admin_id,          // tenant — use SEMPRE este nos filtros
    perfil: payload.perfil || 'administrador',
    isAdmin: payload.tipo === 'admin',
  };
}

// Exige que a sessão tenha um dos perfis permitidos. Retorna a sessão ou null.
export function exigirPerfil(req, res, perfisPermitidos) {
  const sessao = exigirSessao(req, res);
  if (!sessao) return null;
  if (!perfisPermitidos.includes(sessao.perfil)) {
    json(res, 403, { erro: 'Você não tem permissão para esta ação.' });
    return null;
  }
  return sessao;
}

// Helper: encerra a sessão (logout) limpando o cookie.
export function limparSessao(res) {
  const parts = [
    'pp_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
