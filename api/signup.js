// /api/signup.js
// ----------------------------------------------------------------------------
// Autocadastro SELF-SERVICE seguro (Caminho B).
// A tela de cadastro (front) só coleta os dados e dá UM POST aqui.
// Toda a lógica sensível roda no servidor com a service key:
//   - hash da senha com bcrypt (nunca grava texto puro);
//   - PREÇO e LIMITE do plano vêm DESTE arquivo, não do HTML do cliente;
//   - cartão entra como TOKEN do Asaas (gerado no navegador), nunca o número.
// Endpoint PÚBLICO (não exige sessão) — é assim que a 1ª conta nasce.
// ----------------------------------------------------------------------------
import bcrypt from 'bcryptjs';
import { sbAdmin, json, setCors } from './_lib.js';

// Fonte da verdade de preços/limites. O cliente NÃO escolhe valor.
const PLANOS = {
  starter:    { nome: 'Starter',    limite: 100,  valor: 390 },
  growth:     { nome: 'Growth',     limite: 200,  valor: 690 },
  pro:        { nome: 'Pro',        limite: 500,  valor: 1460 },
  business:   { nome: 'Business',   limite: 1000, valor: 2780 },
  enterprise: { nome: 'Enterprise', limite: 1500, valor: 3450 },
};

const txt = (v) => (typeof v === 'string' ? v.trim() : v);
const num = (v) => (v || '').replace(/\D/g, '');

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  try {
    const b = req.body || {};
    const empresa  = txt(b.empresa);
    const nome     = txt(b.nome);
    const email    = (txt(b.email) || '').toLowerCase();
    const telefone = txt(b.telefone);
    const cargo    = txt(b.cargo) || null;
    const cnpj     = num(b.cnpj) || null;
    const senha    = b.senha || '';
    const plano    = txt(b.plano);
    const formaPagamento = txt(b.formaPagamento);
    const cartaoToken    = b.cartaoToken || null; // token do Asaas, NÃO o número

    // ── Validações no servidor ──────────────────────────────────────────
    if (!empresa || !nome || !email || !telefone || !senha || !plano)
      return json(res, 400, { erro: 'Preencha todos os campos obrigatórios.' });
    if (senha.length < 8)
      return json(res, 400, { erro: 'A senha deve ter ao menos 8 caracteres.' });
    if (!PLANOS[plano])
      return json(res, 400, { erro: 'Plano inválido.' });
    if (!['pix', 'boleto', 'cartao'].includes(formaPagamento))
      return json(res, 400, { erro: 'Forma de pagamento inválida.' });
    if (formaPagamento === 'cartao' && !cartaoToken)
      return json(res, 400, { erro: 'Falta o token do cartão.' });

    // ── Unicidade (service key ignora RLS) ──────────────────────────────
    const emailExiste = await sbAdmin(
      `/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=id`
    );
    if (emailExiste?.length)
      return json(res, 409, { erro: 'Este e-mail já está cadastrado. Faça login.' });
    if (cnpj) {
      const cnpjExiste = await sbAdmin(`/rest/v1/clientes?cnpj=eq.${cnpj}&select=id`);
      if (cnpjExiste?.length)
        return json(res, 409, { erro: 'Este CNPJ já possui uma conta.' });
    }

    // ── Hash da senha NO SERVIDOR ───────────────────────────────────────
    const senha_hash = bcrypt.hashSync(senha, 10);
    const planoInfo = PLANOS[plano];

    // ── Cria admin ──────────────────────────────────────────────────────
    const adminRes = await sbAdmin('/rest/v1/admins', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ nome, email, senha_hash, empresa_nome: empresa, cnpj, cargo, telefone }),
    });
    const adminId = adminRes?.[0]?.id;
    if (!adminId) throw new Error('Falha ao criar admin');

    // ── Cria cliente ────────────────────────────────────────────────────
    const clienteRes = await sbAdmin('/rest/v1/clientes', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ admin_id: adminId, nome_empresa: empresa, cnpj, email, plano }),
    });
    const clienteId = clienteRes?.[0]?.id;

    // ── Cria assinatura pendente (valor/limite vêm do servidor) ─────────
    const venc = new Date(); venc.setDate(venc.getDate() + 30);
    await sbAdmin('/rest/v1/assinaturas', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        admin_id: adminId, cliente_id: clienteId, status: 'pendente', plano,
        valor: planoInfo.valor, limite_medicos: planoInfo.limite,
        forma_pagamento: formaPagamento,
        vencimento: venc.toISOString().slice(0, 10),
        pico_mes_atual: 0,
      }),
    });

    // ── COBRANÇA NO ASAAS ───────────────────────────────────────────────
    // Aqui você reaproveita a lógica do seu criar-cobranca.js, mas recebendo
    // cartaoToken (nunca número/cvv). Saída esperada conforme a forma:
    //   pix    -> { pixQrCode, pixCopiaECola }
    //   boleto -> { boletoUrl }
    //   cartao -> { pago: true }
    // const pagamento = await criarCobrancaAsaas({
    //   adminId, clienteId, nome, email, telefone, cnpj,
    //   plano, valor: planoInfo.valor, formaPagamento, cartaoToken,
    // });
    const pagamento = { pendente: true }; // <-- trocar pelo retorno real do Asaas

    return json(res, 201, { ok: true, adminId, pagamento });
  } catch (e) {
    console.error('[signup]', e);
    return json(res, 500, { erro: 'Erro ao processar o cadastro. Tente novamente.' });
  }
}
