// api/criar-cobranca.js
// Cria cliente e assinatura no Asaas após cadastro

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  const ASAAS_KEY  = process.env.ASAAS_API_KEY; // Chave da API do Asaas
  const ASAAS_URL  = 'https://api.asaas.com/v3'; // prod; use https://sandbox.asaas.com/api/v3 para testes

  const { adminId, clienteId, nome, email, tel, cnpj, plano, valor, formaPagamento, cartao } = req.body;

  const BILLING_TYPE = {pix:'PIX', boleto:'BOLETO', cartao:'CREDIT_CARD'}[formaPagamento] || 'PIX';

  try {
    const headers = {
      'Content-Type': 'application/json',
      'access_token': ASAAS_KEY
    };

    // 1. Criar ou recuperar cliente no Asaas
    const clienteAsaas = await fetch(ASAAS_URL + '/customers', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: nome,
        email,
        mobilePhone: tel.replace(/\D/g,''),
        cpfCnpj: cnpj || '',
        externalReference: adminId // nosso ID para o webhook
      })
    }).then(r => r.json());

    if (clienteAsaas.errors) throw new Error(JSON.stringify(clienteAsaas.errors));
    const asaasCustomerId = clienteAsaas.id;

    // 2. Criar assinatura recorrente mensal
    const hoje = new Date();
    const venc = new Date(hoje); venc.setDate(venc.getDate() + 3); // 3 dias para pagar

    const body = {
      customer: asaasCustomerId,
      billingType: BILLING_TYPE,
      value: valor,
      nextDueDate: venc.toISOString().slice(0,10),
      cycle: 'MONTHLY',
      description: 'PlantaoPro - Plano ' + plano,
      externalReference: adminId,
    };

    // Cartão de crédito: adicionar dados tokenizados
    if (BILLING_TYPE === 'CREDIT_CARD' && cartao) {
      const [mesAno] = (cartao.validade || '/').split('/');
      body.creditCard = {
        holderName: cartao.nome,
        number: cartao.numero,
        expiryMonth: cartao.validade.slice(0,2),
        expiryYear: '20' + cartao.validade.slice(3,5),
        ccv: cartao.cvv
      };
      body.creditCardHolderInfo = {
        name: nome,
        email,
        cpfCnpj: cnpj || '',
        mobilePhone: tel.replace(/\D/g,'')
      };
    }

    const assinaturaRes = await fetch(ASAAS_URL + '/subscriptions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }).then(r => r.json());

    if (assinaturaRes.errors) throw new Error(JSON.stringify(assinaturaRes.errors));

    // 3. Salvar ID da assinatura Asaas no Supabase
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    await fetch(SUPABASE_URL + '/rest/v1/assinaturas?admin_id=eq.' + adminId, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        asaas_subscription_id: assinaturaRes.id,
        asaas_customer_id: asaasCustomerId
      })
    });

    // 4. Se PIX, buscar QR code da primeira cobrança
    let pixQrCode = null, pixCopiaECola = null, boletoUrl = null;

    if (BILLING_TYPE === 'PIX') {
      // Buscar primeira cobrança gerada pela assinatura
      const cobRes = await fetch(ASAAS_URL + '/subscriptions/' + assinaturaRes.id + '/payments?limit=1', {headers}).then(r=>r.json());
      const primCob = cobRes.data?.[0];
      if (primCob?.id) {
        const pixRes = await fetch(ASAAS_URL + '/payments/' + primCob.id + '/pixQrCode', {headers}).then(r=>r.json());
        pixQrCode    = pixRes.encodedImage;
        pixCopiaECola = pixRes.payload;
      }
    } else if (BILLING_TYPE === 'BOLETO') {
      const cobRes = await fetch(ASAAS_URL + '/subscriptions/' + assinaturaRes.id + '/payments?limit=1', {headers}).then(r=>r.json());
      const primCob = cobRes.data?.[0];
      if (primCob?.bankSlipUrl) boletoUrl = primCob.bankSlipUrl;
    }

    return res.status(200).json({
      ok: true,
      asaasSubscriptionId: assinaturaRes.id,
      pixQrCode,
      pixCopiaECola,
      boletoUrl
    });

  } catch(e) {
    console.error('Criar cobrança erro:', e);
    return res.status(500).json({error: e.message});
  }
}
