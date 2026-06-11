// /api/signup.js
// ----------------------------------------------------------------------------
// Autocadastro SELF-SERVICE seguro + cobrança Asaas, tudo no servidor.
//   - senha com hashSenha (bcrypt) — nunca grava texto puro;
//   - PREÇO e LIMITE vêm DESTE arquivo, não do HTML do cliente;
//   - CARTÃO: não recebe número/cvv. Devolve a invoiceUrl do Asaas (página PCI
//     deles) pra onde o cliente é redirecionado;
//   - PIX/BOLETO: devolve QR code / link do boleto;
//   - rate limit por IP pra evitar spam de cadastro.
// Usa os helpers do seu _lib.js (sbAdmin, asaas com ASAAS_BASE_URL, etc.).
// ----------------------------------------------------------------------------
import {
  sbAdmin, asaas, hashSenha, json, setCors,
  validarEmail, limparCNPJ, limparTelefone, rateLimit,
} from './_lib.js';

// Fonte da verdade de preços/limites. O cliente NÃO escolhe valor.
const PLANOS = {
  standard:  { nome: 'Standard',  limite: 100,  valor: 390 },
  essencial: { nome: 'Essencial', limite: 200,  valor: 690 },
  avancado:  { nome: 'Avançado',  limite: 500,  valor: 1460 },
  business:  { nome: 'Business',  limite: 1000, valor: 2780 },
  pro:       { nome: 'Pro',       limite: 1500, valor: 3450 },
};
const BILLING = { pix: 'PIX', boleto: 'BOLETO', cartao: 'CREDIT_CARD' };

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconhecido';
  if (!rateLimit(ip)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde um minuto.' });

  try {
    const b = req.body || {};
    const empresa  = (b.empresa || '').trim();
    const nome     = (b.nome || '').trim();
    const email    = (b.email || '').trim().toLowerCase();
    const telefone = limparTelefone(b.telefone);
    const cargo    = (b.cargo || '').trim() || null;
    const cnpj     = limparCNPJ(b.cnpj) || null;
    const senha    = b.senha || '';
    const plano    = (b.plano || '').trim();
    const formaPagamento = (b.formaPagamento || '').trim();

    // -- Validações no servidor --
    if (!empresa || !nome || !email || !telefone || !senha || !plano)
      return json(res, 400, { erro: 'Preencha todos os campos obrigatórios.' });
    if (!validarEmail(email))
      return json(res, 400, { erro: 'E-mail inválido.' });
    if (senha.length < 8)
      return json(res, 400, { erro: 'A senha deve ter ao menos 8 caracteres.' });
    if (!PLANOS[plano])
      return json(res, 400, { erro: 'Plano inválido.' });
    if (!BILLING[formaPagamento])
      return json(res, 400, { erro: 'Forma de pagamento inválida.' });

    // -- Unicidade (service key ignora RLS) --
    const emailExiste = await sbAdmin(`/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=id`);
    if (emailExiste?.length) return json(res, 409, { erro: 'Este e-mail já está cadastrado. Faça login.' });
    if (cnpj) {
      const cnpjExiste = await sbAdmin(`/rest/v1/clientes?cnpj=eq.${cnpj}&select=id`);
      if (cnpjExiste?.length) return json(res, 409, { erro: 'Este CNPJ já possui uma conta.' });
    }

    const planoInfo = PLANOS[plano];
    const senha_hash = await hashSenha(senha);

    // -- Cria admin + cliente + assinatura (pendente) --
    const adminRes = await sbAdmin('/rest/v1/admins', {
      method: 'POST',
      body: JSON.stringify({ nome, email, senha_hash, empresa_nome: empresa, cnpj, cargo, telefone }),
    });
    const adminId = adminRes?.[0]?.id;
    if (!adminId) throw new Error('Falha ao criar admin');

    const clienteRes = await sbAdmin('/rest/v1/clientes', {
      method: 'POST',
      body: JSON.stringify({ admin_id: adminId, nome_empresa: empresa, cnpj, email, plano }),
    });
    const clienteId = clienteRes?.[0]?.id;

    const venc = new Date(); venc.setDate(venc.getDate() + 3);
    const vencISO = venc.toISOString().slice(0, 10);
    await sbAdmin('/rest/v1/assinaturas', {
      method: 'POST',
      body: JSON.stringify({
        admin_id: adminId, cliente_id: clienteId, status: 'pendente', plano,
        valor: planoInfo.valor, limite_medicos: planoInfo.limite,
        forma_pagamento: formaPagamento, vencimento: vencISO, pico_mes_atual: 0,
      }),
    });

    // -- Asaas: cliente + assinatura recorrente (SEM dados de cartão) --
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
        description: 'PlantãoPro - Plano ' + planoInfo.nome,
        externalReference: adminId,
      }),
    });

    await sbAdmin(`/rest/v1/assinaturas?admin_id=eq.${adminId}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ asaas_subscription_id: sub.id, asaas_customer_id: customer.id }),
    });

    // -- Retorno conforme a forma de pagamento --
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
