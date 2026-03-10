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
  // end_date +1 dia para incluir vendas de hoje (API pode ser exclusiva no fim)
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 1);
  const dataFim = params.fim || `${amanha.getFullYear()}-${String(amanha.getMonth() + 1).padStart(2, "0")}-${String(amanha.getDate()).padStart(2, "0")}`;

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

    // 2. Buscar TODAS as vendas (sem filtro de status) para capturar todos os registros
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let todasVendas = [];
    const idsVistos = new Set();

    // Primeiro: buscar sem filtro de status para pegar tudo
    try {
      const url = `${BASE}/v1/sales?start_date=${dataInicio}&end_date=${dataFim}&page_size=100`;
      const resp = await fetch(url, { headers: HEADERS });
      if (resp.ok) {
        const data = await resp.json();
        if (data.data) {
          for (const s of data.data) {
            idsVistos.add(s.id);
            todasVendas.push({ ...s, _status: s.status || "paid" });
          }
        }
        // Paginação
        let nextPage = data.next_page_url || null;
        while (nextPage) {
          await sleep(300);
          const pageResp = await fetch(nextPage, { headers: HEADERS });
          if (pageResp.ok) {
            const pageData = await pageResp.json();
            if (pageData.data) {
              for (const s of pageData.data) {
                if (!idsVistos.has(s.id)) {
                  idsVistos.add(s.id);
                  todasVendas.push({ ...s, _status: s.status || "paid" });
                }
              }
            }
            nextPage = pageData.next_page_url || null;
          } else {
            nextPage = null;
          }
        }
      }
    } catch (e) {
      // Fallback: buscar por status individual
    }

    // Fallback: se nada veio sem filtro, buscar por status
    if (todasVendas.length === 0) {
      for (const status of ["paid", "waiting_payment", "refunded", "chargedback"]) {
        await sleep(300);
        try {
          const url = `${BASE}/v1/sales?start_date=${dataInicio}&end_date=${dataFim}&status=${status}&page_size=100`;
          const resp = await fetch(url, { headers: HEADERS });
          if (resp.ok) {
            const data = await resp.json();
            if (data.data) {
              for (const s of data.data) {
                if (!idsVistos.has(s.id)) {
                  idsVistos.add(s.id);
                  todasVendas.push({ ...s, _status: status });
                }
              }
            }
          }
        } catch (e) {
          // Skip
        }
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

    // 4. Montar lista final (sem deduplicação - cada venda individual conta)
    const statusPt = {
      paid: "Pago",
      waiting_payment: "Pendente",
      refunded: "Estornado",
      chargedback: "Estornado",
      refused: "Recusado",
    };

    const formas = {
      credit_card: "Cartao",
      pix: "PIX",
      boleto: "Boleto",
    };

    const vendas = [];
    for (const s of todasVendas) {
      const detail = detailCache[s.id] || {};
      const customer = detail.customer || s.customer || {};
      const payment = detail.payment || {};

      const valorBruto = (payment.total_amount || payment.product_base_price || s.total_amount || s.net_amount || 0) / 100;
      const valorLiquido = (payment.net_amount || s.net_amount || 0) / 100;
      const taxas = (payment.fee || 0) / 100;

      vendas.push({
        nome: customer.name || "N/A",
        telefone: customer.mobile || "",
        email: customer.email || "",
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
    const recusados = vendas.filter((v) => v.status === "Recusado");

    const resumo = {
      totalAlunos: pagos.length + pendentes.length + estornados.length,
      totalPagos: pagos.length,
      totalPendentes: pendentes.length,
      totalEstornados: estornados.length,
      totalRecusados: recusados.length,
      valorBruto: pagos.reduce((s, v) => s + v.valor, 0),
      valorLiquido: pagos.reduce((s, v) => s + v.valorLiquido, 0),
      valorPendente: pendentes.reduce((s, v) => s + v.valor, 0),
      valorEstornado: estornados.reduce((s, v) => s + v.valor, 0),
      valorRecusado: recusados.reduce((s, v) => s + v.valor, 0),
      periodo: { inicio: dataInicio, fim: dataFim },
      atualizadoEm: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-store",
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
