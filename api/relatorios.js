// /api/relatorios.js
// ----------------------------------------------------------------------------
// Endpoint ÚNICO de dados de relatórios.
// Devolve os dados do período (lançamentos + nomes de projetos/médicos),
// filtrados SEMPRE pelo admin_id do token, sem campos sensíveis do médico.
// Todos os relatórios (Custo, Pagamento por médico, Previsto×Realizado, por
// setor, por tipo, etc.) são montados no FRONT-END em cima deste mesmo retorno.
// Adicionar um relatório novo NÃO exige um endpoint novo.
//
// Uso: GET /api/relatorios?inicio=2026-04-01&fim=2026-04-30
// ----------------------------------------------------------------------------
import { sbAdmin, json, setCors } from './_lib.js';
import { exigirSessao } from './_auth.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const sessao = exigirSessao(req, res);
  if (!sessao) return;
  const adminId = sessao.adminId;

  if (req.method !== 'GET') return json(res, 405, { erro: 'Método não permitido' });

  try {
    const inicio = req.query.inicio;
    const fim = req.query.fim;
    if (!inicio || !fim) {
      return json(res, 400, { erro: 'Informe inicio e fim no formato AAAA-MM-DD.' });
    }

    // Lançamentos do período (campos necessários aos relatórios).
    const lancamentos = await sbAdmin(
      `/rest/v1/lancamentos?admin_id=eq.${adminId}` +
      `&data=gte.${inicio}&data=lte.${fim}` +
      `&select=id,data,projeto_id,medico_id,setor,tipo,horas,honorario,confirmado,aberto,vagas,vagas_preenchidas,ausencia_informada`
    ) || [];

    // Nomes das unidades e dos médicos (lean — sem CPF/PIX/banco).
    const projsArr = await sbAdmin(`/rest/v1/projetos?admin_id=eq.${adminId}&select=id,nome`) || [];
    const medsArr  = await sbAdmin(`/rest/v1/medicos?admin_id=eq.${adminId}&select=id,nome,crm`) || [];

    const projetos = {};
    projsArr.forEach((p) => { projetos[p.id] = p.nome; });
    const medicos = {};
    medsArr.forEach((m) => { medicos[m.id] = { nome: m.nome, crm: m.crm }; });

    return json(res, 200, { periodo: { inicio, fim }, lancamentos, projetos, medicos });
  } catch (e) {
    console.error('[relatorios]', e);
    return json(res, 500, { erro: 'Erro ao buscar os dados do relatório.' });
  }
}
