// Netlify Function - Proxy para API do Kiwify
// Busca pagamentos via OAuth2, retorna JSON limpo
// Otimizado para Netlify (max 30s timeout)

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

  const params = event.queryStringParameters || {};
  const hoje = new Date();
  const anoMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const dataInicio = params.inicio || `${anoMes}-01`;
  const hojeSpParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(hoje);
  const hojeSp = `${hojeSpParts.find((p) => p.type === "year").value}-${hojeSpParts.find((p) => p.type === "month").value}-${hojeSpParts.find((p) => p.type === "day").value}`;
  const amanha = new Date(hoje);
  amanha.setDate(amanha.getDate() + 2);
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

    // 2. Buscar vendas - uma unica request, sem paginacao extra, sem detalhes individuais
    const url = `${BASE}/v1/sales?start_date=${dataInicio}&end_date=${dataFim}&page_size=100`;
    const resp = await fetch(url, { headers: HEADERS });

    let todasVendas = [];
    if (resp.ok) {
      const data = await resp.json();
      if (data.data) {
        todasVendas = data.data.map((s) => ({ ...s, _status: s.status || "paid" }));
      }

      // Apenas 1 pagina extra se necessario (evitar timeout)
      if (data.next_page_url) {
        try {
          const page2 = await fetch(data.next_page_url, { headers: HEADERS });
          if (page2.ok) {
            const p2 = await page2.json();
            if (p2.data) {
              const ids = new Set(todasVendas.map((s) => s.id));
              for (const s of p2.data) {
                if (!ids.has(s.id)) {
                  todasVendas.push({ ...s, _status: s.status || "paid" });
                }
              }
            }
          }
        } catch (e) { /* skip */ }
      }
    }

    // 3. Montar lista final direto dos dados da listagem (sem fetch individual)
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

    const firstPresent = (...values) => {
      for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim() !== "") return value;
      }
      return null;
    };

    const asIsoDate = (value) => {
      if (!value) return null;
      if (typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString().substring(0, 10);
      }
      const text = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.substring(0, 10);
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().substring(0, 10);
    };

    const getCurrentPeriodEnd = (s) => {
      const subscription = s.subscription || s.subscription_data || s.subscription_info || {};
      return asIsoDate(firstPresent(
        s.current_period_end,
        s.currentPeriodEnd,
        s.subscription_current_period_end,
        s.subscriptionCurrentPeriodEnd,
        subscription.current_period_end,
        subscription.currentPeriodEnd,
        subscription.period_end,
        subscription.periodEnd,
        subscription.next_billing_date,
        subscription.nextBillingDate
      ));
    };

    const getDueDate = (s) => asIsoDate(firstPresent(
      s.due_date,
      s.dueDate,
      s.boleto_due_date,
      s.boletoDueDate,
      s.pix_expiration_date,
      s.pixExpirationDate,
      s.expires_at,
      s.expiresAt,
      getCurrentPeriodEnd(s)
    ));

    const statusVisivel = (s, dueDate) => {
      if (s._status === "waiting_payment") {
        const referenceDate = dueDate || asIsoDate(s.created_at);
        if (referenceDate && referenceDate > hojeSp) return "A vencer";
        if (referenceDate && referenceDate < hojeSp) return "Vencido";
        return "Pendente";
      }
      return statusPt[s._status] || s._status;
    };

    const vendas = [];
    for (const s of todasVendas) {
      const customer = s.customer || {};
      const currentPeriodEnd = getCurrentPeriodEnd(s);
      const dueDate = getDueDate(s);
      const status = statusVisivel(s, dueDate);

      const valorBruto = (s.total_amount || s.net_amount || 0) / 100;
      const valorLiquido = (s.net_amount || 0) / 100;
      const taxas = valorBruto - valorLiquido;

      vendas.push({
        provedor: "kiwify",
        rowKey: `kiwify:${s.id}`,
        saleId: s.id || "",
        document: customer.cpf || customer.cpf_cnpj || customer.document || null,
        nome: customer.name || "N/A",
        telefone: customer.mobile || "",
        email: customer.email || "",
        valor: valorBruto,
        valorLiquido,
        taxas,
        status,
        forma: formas[s.payment_method] || s.payment_method || "",
        data: (s.created_at || "").substring(0, 10),
        createdAt: s.created_at || null,
        updatedAt: s.updated_at || null,
        approvedAt: s.approved_date || null,
        dueDate,
        currentPeriodEnd,
      });
    }

    vendas.sort((a, b) => b.data.localeCompare(a.data));

    const pagos = vendas.filter((v) => v.status === "Pago");
    const pendentes = vendas.filter((v) => v.status === "Pendente");
    const vencidos = vendas.filter((v) => v.status === "Vencido");
    const aVencer = vendas.filter((v) => v.status === "A vencer");
    const estornados = vendas.filter((v) => v.status === "Estornado");
    const recusados = vendas.filter((v) => v.status === "Recusado");

    const resumo = {
      totalAlunos: pagos.length + pendentes.length + vencidos.length + aVencer.length + estornados.length,
      totalPagos: pagos.length,
      totalPendentes: pendentes.length,
      totalVencidos: vencidos.length,
      totalAVencer: aVencer.length,
      totalEstornados: estornados.length,
      totalRecusados: recusados.length,
      valorBruto: pagos.reduce((s, v) => s + v.valor, 0),
      valorLiquido: pagos.reduce((s, v) => s + v.valorLiquido, 0),
      valorPendente: pendentes.reduce((s, v) => s + v.valor, 0),
      valorVencido: vencidos.reduce((s, v) => s + v.valor, 0),
      valorAVencer: aVencer.reduce((s, v) => s + v.valor, 0),
      valorEstornado: estornados.reduce((s, v) => s + v.valor, 0),
      valorRecusado: recusados.reduce((s, v) => s + v.valor, 0),
      periodo: { inicio: dataInicio, fim: dataFim },
      atualizadoEm: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Cache-Control": "no-store" },
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
