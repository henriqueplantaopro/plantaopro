// /api/login.js
// Substitui a comparação insegura de senha que era feita no browser.
// Tenta autenticar primeiro como usuário da equipe, depois como admin master.

import {
  sbAdmin, verificarSenha, hashSenha, validarEmail,
  assinarJWT, json, setCors, rateLimit
} from './_lib.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  // Rate limit: 5 tentativas/min por IP (protege contra força bruta)
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 'desconhecido';
  if (!rateLimit(ip, 5, 60_000)) {
    return json(res, 429, { erro: 'Muitas tentativas. Aguarde 1 minuto.' });
  }

  try {
    const { email, senha } = req.body || {};
    if (!email || !senha)       return json(res, 400, { erro: 'E-mail e senha obrigatórios' });
    if (!validarEmail(email))   return json(res, 400, { erro: 'E-mail inválido' });

    const emailLower = email.trim().toLowerCase();

    // ─── 1. Tentar como usuário da equipe ─────────────────────────────
    const usuarios = await sbAdmin(
      `/rest/v1/usuarios?email=eq.${encodeURIComponent(emailLower)}&select=id,nome,email,senha_hash,perfil,admin_id,ativo`
    );
    const usuario = usuarios?.[0];
    if (usuario && usuario.ativo !== false) {
      const ok = await verificarSenha(senha, usuario.senha_hash);
      if (ok) {
        // Migração transparente: se a senha estava em texto puro, atualiza para hash bcrypt
        if (!/^\$2[aby]\$/.test(usuario.senha_hash || '')) {
          const novoHash = await hashSenha(senha);
          await sbAdmin(`/rest/v1/usuarios?id=eq.${usuario.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ senha_hash: novoHash }),
          }).catch(() => {});
        }
        return responderSucesso(res, {
          tipo: 'usuario',
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          perfil: usuario.perfil,
          admin_id: usuario.admin_id,
          isAdmin: false,
        });
      }
    }

    // ─── 2. Tentar como admin master ──────────────────────────────────
    const admins = await sbAdmin(
      `/rest/v1/admins?email=eq.${encodeURIComponent(emailLower)}&select=id,nome,email,senha_hash,empresa_nome,cnpj,cargo,telefone`
    );
    const admin = admins?.[0];
    if (admin) {
      const ok = await verificarSenha(senha, admin.senha_hash);
      if (ok) {
        // Migração transparente
        if (!/^\$2[aby]\$/.test(admin.senha_hash || '')) {
          const novoHash = await hashSenha(senha);
          await sbAdmin(`/rest/v1/admins?id=eq.${admin.id}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ senha_hash: novoHash }),
          }).catch(() => {});
        }
        return responderSucesso(res, {
          tipo: 'admin',
          id: admin.id,
          nome: admin.nome,
          email: admin.email,
          empresa_nome: admin.empresa_nome,
          cnpj: admin.cnpj,
          cargo: admin.cargo,
          telefone: admin.telefone,
          isAdmin: true,
        });
      }
    }

    // ─── 3. Nenhum acerto — resposta genérica (não revela qual campo falhou) ──
    // Pequeno delay aleatório atrapalha timing attacks
    await new Promise(r => setTimeout(r, 200 + Math.random() * 200));
    return json(res, 401, { erro: 'E-mail ou senha incorretos' });

  } catch (e) {
    console.error('[login]', e);
    return json(res, 500, { erro: 'Erro interno' });
  }
}

function responderSucesso(res, dadosUsuario) {
  // Gerar JWT pra sessão
  const token = assinarJWT({
    sub: dadosUsuario.id,
    tipo: dadosUsuario.tipo,
    admin_id: dadosUsuario.admin_id || dadosUsuario.id,
    perfil: dadosUsuario.perfil || 'administrador',
  });

  // Cookie HttpOnly (não acessível por JS — protege contra XSS)
  // SameSite=Lax permite redirect normal mas bloqueia CSRF
  const cookieParts = [
    `pp_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + (60 * 60 * 24 * 7), // 7 dias
  ];
  if (process.env.NODE_ENV === 'production') cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));

  return json(res, 200, {
    ok: true,
    usuario: dadosUsuario,
    // Token também no body — pra você guardar em memória se quiser
    // (não use localStorage por segurança contra XSS)
    token,
  });
}
