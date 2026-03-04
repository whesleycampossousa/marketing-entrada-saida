// Netlify Function - Proxy para API do Kiwify
// Busca pagamentos via OAuth2, retorna JSON limpo

export async function handler(event) {
  const CLIENT_ID = process.env.KIWIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.KIWIFY_CLIENT_SECRET;
  const ACCOUNT_ID = process.env.KIWIFY_ACCOUNT_ID;
  const BASE = "https://public-api.kiwify.com";

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (!CLIENT_ID || !CLIENT_SECRET || !ACCOUNT_ID) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "KIWIFY credentials nao configuradas" }),
    };
  }

  // Pegar datas do query string (default: mes atual)
  const params = event.queryStringParameters || {};
  const hoje = new Date();
  const anoMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const dataInicio = params.inicio || `${anoMes}-01`;
  const dataFim = params.fim || `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;

  try {
    // 1. Autenticar via OAuth2
    const tokenResp = await fetch(`${BASE}/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    });

    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      throw new Error(`Auth failed: ${err}`);
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;

    const HEADERS = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "x-kiwify-account-id": ACCOUNT_ID,
    };

    // 2. Buscar vendas por status
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let todasVendas = [];

    for (const status of ["paid", "waiting_payment", "refunded"]) {
      await sleep(300);
      try {
        const url = `${BASE}/v1/sales?start_date=${dataInicio}&end_date=${dataFim}&status=${status}&page_size=100`;
        const resp = await fetch(url, { headers: HEADERS });
        if (resp.ok) {
          const data = await resp.json();
          if (data.data) {
            todasVendas = todasVendas.concat(
              data.data.map((s) => ({ ...s, _status: status }))
            );
          }
        }
      } catch (e) {
        // Skip status errors
      }
    }

    // 3. Buscar detalhes (telefone, CPF) para cada venda
    const detailCache = {};
    for (let i = 0; i < todasVendas.length; i++) {
      const s = todasVendas[i];
      const sid = s.id;
      if (detailCache[sid]) continue;
      await sleep(500);
      try {
        const resp = await fetch(`${BASE}/v1/sales/${sid}`, { headers: HEADERS });
        if (resp.ok) {
          detailCache[sid] = await resp.json();
        }
      } catch (e) {
        // Skip
      }
    }

    // 4. Deduplicar por email do cliente - manter melhor status
    const prioridade = { paid: 1, waiting_payment: 2, refunded: 3 };
    const porCliente = {};

    for (const s of todasVendas) {
      const email = (s.customer?.email || "").toLowerCase().trim();
      if (!email) continue;
      const pri = prioridade[s._status] || 9;

      if (!porCliente[email]) {
        porCliente[email] = s;
      } else {
        const atualPri = prioridade[porCliente[email]._status] || 9;
        if (pri < atualPri) {
          porCliente[email] = s;
        }
      }
    }

    // 5. Montar lista final
    const statusPt = {
      paid: "Pago",
      waiting_payment: "Pendente",
      refunded: "Estornado",
    };

    const formas = {
      credit_card: "Cartao",
      pix: "PIX",
      boleto: "Boleto",
    };

    const vendas = [];
    for (const [email, s] of Object.entries(porCliente)) {
      const detail = detailCache[s.id] || {};
      const customer = detail.customer || s.customer || {};
      const payment = detail.payment || {};

      const valorBruto = (payment.product_base_price || s.net_amount || 0) / 100;
      const valorLiquido = (payment.net_amount || s.net_amount || 0) / 100;
      const taxas = (payment.fee || 0) / 100;

      vendas.push({
        nome: customer.name || "N/A",
        telefone: customer.mobile || "",
        email: customer.email || email,
        valor: valorBruto,
        valorLiquido,
        taxas,
        status: statusPt[s._status] || s._status,
        forma: formas[s.payment_method || detail.payment_method] || s.payment_method || "",
        data: (s.created_at || "").substring(0, 10),
      });
    }

    // Ordenar por data (mais recente primeiro)
    vendas.sort((a, b) => b.data.localeCompare(a.data));

    // 6. Calcular resumo
    const pagos = vendas.filter((v) => v.status === "Pago");
    const pendentes = vendas.filter((v) => v.status === "Pendente");
    const estornados = vendas.filter((v) => v.status === "Estornado");

    const resumo = {
      totalAlunos: vendas.length,
      totalPagos: pagos.length,
      totalPendentes: pendentes.length,
      totalEstornados: estornados.length,
      valorBruto: pagos.reduce((s, v) => s + v.valor, 0),
      valorLiquido: pagos.reduce((s, v) => s + v.valorLiquido, 0),
      valorPendente: pendentes.reduce((s, v) => s + v.valor, 0),
      valorEstornado: estornados.reduce((s, v) => s + v.valor, 0),
      periodo: { inicio: dataInicio, fim: dataFim },
      atualizadoEm: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "public, max-age=18000", // 5 horas
      },
      body: JSON.stringify({ resumo, vendas }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
