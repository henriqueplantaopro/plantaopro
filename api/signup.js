// /api/signup.js
// ----------------------------------------------------------------------------
// Autocadastro SELF-SERVICE seguro + cobrança Asaas, tudo no servidor.
//   - hash da senha com bcrypt (nunca grava texto puro);
//   - PREÇO e LIMITE do plano vêm DESTE arquivo, não do HTML do cliente;
//   - CARTÃO: não recebe número/cvv. Cria a cobrança e devolve a invoiceUrl
//     do Asaas, pra onde o cliente é redirecionado (página PCI do Asaas).
//   - PIX/BOLETO: devolve QR code / link do boleto.
// Endpoint PÚBLICO (é assim que a 1a conta nasce).
// ----------------------------------------------------------------------------
import bcrypt from 'bcryptjs';
import { sbAdmin, json, setCors } from './_lib.js';

const ASAAS_URL = process.env.ASAAS_URL || 'https://api.asaas.com/v3';
// Para testar, defina ASAAS_URL=https://api-sandbox.asaas.com/v3 nas envs da Vercel.

// Fonte da verdade de precos/limites. O cliente NAO escolhe valor.
const PLANOS = {
  starter:    { nome: 'Starter',    limite: 100,  valor: 390 },
  growth:     { nome: 'Growth',     limite: 200,  valor: 690 },
  pro:        { nome: 'Pro',        limite: 500,  valor: 1460 },
  business:   { nome: 'Business',   limite: 1000, valor: 2780 },
  enterprise: { nome: 'Enterprise', limite: 1500, valor: 3450 },
};
const BILLING = { pix: 'PIX', boleto: 'BOLETO', cartao: 'CREDIT_CARD' };

const txt = (v) => (typeof v === 'string' ? v.trim() : v);
const num = (v) => (v || '').replace(/\D/g, '');

async function asaas(path, opts = {}) {
  const r = await fetch(ASAAS_URL + path, {
    headers: { 'Content-Type': 'application/json', access_token: process.env.ASAAS_API_KEY },
    ...opts,
  });
  const data = await r.json();
  if (data?.errors) throw new Error(JSON.stringify(data.errors));
  return data;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Metodo nao permitido' });

  try {
    const b = req.body || {};
    const empresa  = txt(b.empresa);
    const nome     = txt(b.nome);
    const email    = (txt(b.email) || '').toLowerCase();
    const telefone = num(b.telefone);
    const cargo    = txt(b.cargo) || null;
    const cnpj     = num(b.cnpj) || null;
    const senha    = b.senha || '';
    const plano    = txt(b.plano);
    const formaPagamento = txt(b.formaPagamento);

    // -- Validacoes no servidor --
    if (!empresa || !nome || !email || !telefone || !senha || !plano)
      return json(res, 400, { erro: 'Preencha todos os campos obrigatorios.' });
    if (senha.length < 8)
      return json(res, 400, { erro: 'A senha deve ter ao menos 8 caracteres.' });
    if (!PLANOS[plano])
      return json(res, 400, { erro: 'Plano invalido.' });
    if (!BILLING[formaPagamento])
      return json(res, 400, { erro: 'Forma de pagamento invalida.' });

    // -- Unicidade (service key ignora RLS) --
    const emailExiste = await sbAdmin(`/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=id`);
    if (emailExiste?.length) return json(res, 409, { erro: 'Este e-mail ja esta cadastrado. Faca login.' });
    if (cnpj) {
      const cnpjExiste = await sbAdmin(`/rest/v1/clientes?cnpj=eq.${cnpj}&select=id`);
      if (cnpjExiste?.length) return json(res, 409, { erro: 'Este CNPJ ja possui uma conta.' });
    }

    const planoInfo = PLANOS[plano];
    const senha_hash = bcrypt.hashSync(senha, 10);

    // -- Cria admin + cliente + assinatura (pendente) --
    const adminRes = await sbAdmin('/rest/v1/admins', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ nome, email, senha_hash, empresa_nome: empresa, cnpj, cargo, telefone }),
    });
    const adminId = adminRes?.[0]?.id;
    if (!adminId) throw new Error('Falha ao criar admin');

    const clienteRes = await sbAdmin('/rest/v1/clientes', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ admin_id: adminId, nome_empresa: empresa, cnpj, email, plano }),
    });
    const clienteId = clienteRes?.[0]?.id;

    const venc = new Date(); venc.setDate(venc.getDate() + 3);
    const vencISO = venc.toISOString().slice(0, 10);
    await sbAdmin('/rest/v1/assinaturas', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        admin_id: adminId, cliente_id: clienteId, status: 'pendente', plano,
        valor: planoInfo.valor, limite_medicos: planoInfo.limite,
        forma_pagamento: formaPagamento, vencimento: vencISO, pico_mes_atual: 0,
      }),
    });

    // -- Asaas: cliente + assinatura recorrente (SEM dados de cartao) --
    const customer = await asaas('/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: nome, email, mobilePhone: telefone, cpfCnpj: cnpj || '',
        externalReference: adminId,
      }),
    });

    const sub = await asaas('/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        customer: customer.id,
        billingType: BILLING[formaPagamento],
        value: planoInfo.valor,
        nextDueDate: vencISO,
        cycle: 'MONTHLY',
        description: 'PlantaoPro - Plano ' + planoInfo.nome,
        externalReference: adminId,
      }),
    });

    await sbAdmin(`/rest/v1/assinaturas?admin_id=eq.${adminId}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ asaas_subscription_id: sub.id, asaas_customer_id: customer.id }),
    });

    // -- Monta o retorno conforme a forma de pagamento --
    const pagamento = { tipo: formaPagamento };
    const cobr = await asaas(`/subscriptions/${sub.id}/payments?limit=1`);
    const prim = cobr?.data?.[0];

    if (formaPagamento === 'pix' && prim?.id) {
      const pix = await asaas(`/payments/${prim.id}/pixQrCode`);
      pagamento.pixQrCode = pix.encodedImage;
      pagamento.pixCopiaECola = pix.payload;
    } else if (formaPagamento === 'boleto' && prim?.bankSlipUrl) {
      pagamento.boletoUrl = prim.bankSlipUrl;
    } else if (formaPagamento === 'cartao' && prim?.invoiceUrl) {
      pagamento.cartaoUrl = prim.invoiceUrl;
    }

    return json(res, 201, { ok: true, adminId, pagamento });
  } catch (e) {
    console.error('[signup]', e);
    return json(res, 500, { erro: 'Erro ao processar o cadastro. Tente novamente.' });
  }
}
