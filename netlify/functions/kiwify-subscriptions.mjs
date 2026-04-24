// Netlify Function - Diagnostico do "Assinaturas Ativas" do Kiwify
// A API publica do Kiwify NAO tem endpoint de subscriptions.
// Esta funcao busca TODAS as vendas dos ultimos 12 meses e calcula:
//  - quantas pessoas unicas ja compraram alguma vez
//  - quantas tem cobranca recorrente em aberto
//  - quantas pagaram nos ultimos 30 dias (provavelmente "ativas" de verdade)
// Compare com o numero do painel kiwify.com.br

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
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "credenciais nao configuradas" }) };
  }

  function normEmail(s) { return (s || "").toString().toLowerCase().trim(); }
  function normPhone(s) {
    const d = (s || "").toString().replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-11) : "";
  }
  function normCpf(s) {
    const d = (s || "").toString().replace(/\D/g, "");
    return d.length >= 11 ? d.slice(-11) : "";
  }
  function personKey(c) {
    return normCpf(c.cpf || c.CPF || c.document) || normEmail(c.email) || normPhone(c.mobile || c.phone);
  }

  try {
    const tokenResp = await fetch(`${BASE}/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    });
    if (!tokenResp.ok) throw new Error("OAuth: " + (await tokenResp.text()));
    const { access_token } = await tokenResp.json();
    const HEADERS = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
      "x-kiwify-account-id": ACCOUNT_ID,
    };

    // Buscar 12 meses de vendas em chunks mensais
    const hoje = new Date();
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const ranges = [];
    for (let i = 0; i < 12; i++) {
      const inicio = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      const fim = new Date(hoje.getFullYear(), hoje.getMonth() - i + 1, 0);
      ranges.push({ inicio: fmt(inicio), fim: fmt(fim) });
    }

    const todasVendas = [];
    const seenIds = new Set();
    for (const r of ranges) {
      let url = `${BASE}/v1/sales?start_date=${r.inicio}&end_date=${r.fim}&page_size=100`;
      let page = 0;
      while (url && page < 20) {
        const resp = await fetch(url, { headers: HEADERS });
        if (!resp.ok) break;
        const data = await resp.json();
        const batch = data.data || [];
        for (const s of batch) {
          if (s.id && !seenIds.has(s.id)) {
            seenIds.add(s.id);
            todasVendas.push(s);
          }
        }
        url = data.next_page_url || null;
        page++;
        if (batch.length === 0) break;
      }
    }

    // Diagnostico
    const porStatus = {};
    const porTipo = {};
    const pessoasUnicas = new Set();
    const pessoasComPagoUltimos30d = new Set();
    const pessoasComPagoUltimos90d = new Set();
    const pessoasComPagoUltimos365d = new Set();
    const pessoasPendenteAberto = new Set();
    const pessoasPagasAlgumaVez = new Set();
    const subscriptionIds = new Set();
    const subscriptionsAtivas = new Set();
    const subscriptionsPagasUltimos30d = new Set();

    const agora = Date.now();
    const ms30 = 30 * 24 * 60 * 60 * 1000;
    const ms90 = 90 * 24 * 60 * 60 * 1000;
    const ms365 = 365 * 24 * 60 * 60 * 1000;

    for (const s of todasVendas) {
      const status = s.status || "?";
      porStatus[status] = (porStatus[status] || 0) + 1;
      const tipo = s.is_subscription || s.subscription_id ? "assinatura" : "avulsa";
      porTipo[tipo] = (porTipo[tipo] || 0) + 1;

      const customer = s.customer || {};
      const pkey = personKey(customer);
      if (!pkey) continue;
      pessoasUnicas.add(pkey);

      const created = s.created_at ? new Date(s.created_at).getTime() : 0;
      const idade = agora - created;

      if (status === "paid") {
        pessoasPagasAlgumaVez.add(pkey);
        if (idade <= ms30) pessoasComPagoUltimos30d.add(pkey);
        if (idade <= ms90) pessoasComPagoUltimos90d.add(pkey);
        if (idade <= ms365) pessoasComPagoUltimos365d.add(pkey);
      }
      if (status === "waiting_payment") pessoasPendenteAberto.add(pkey);

      const subId = s.subscription_id || s.subscription?.id;
      if (subId) {
        subscriptionIds.add(subId);
        const subStatus = s.subscription?.status || s.subscription_status;
        if (subStatus === "active" || subStatus === "ativa") subscriptionsAtivas.add(subId);
        if (status === "paid" && idade <= ms30) subscriptionsPagasUltimos30d.add(subId);
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Cache-Control": "no-store" },
      body: JSON.stringify({
        totalVendasAnalisadas: todasVendas.length,
        periodoConsiderado: `${ranges[ranges.length - 1].inicio} a ${ranges[0].fim} (12 meses)`,
        porStatus,
        porTipo,
        contagensUnicas: {
          pessoasUnicasComQualquerVenda: pessoasUnicas.size,
          pessoasQueJaPagaramAlgumaVez: pessoasPagasAlgumaVez.size,
          pessoasComPagamentoUltimos30Dias: pessoasComPagoUltimos30d.size,
          pessoasComPagamentoUltimos90Dias: pessoasComPagoUltimos90d.size,
          pessoasComPagamentoUltimos12Meses: pessoasComPagoUltimos365d.size,
          pessoasComPendenteEmAberto: pessoasPendenteAberto.size,
        },
        assinaturas: {
          totalSubscriptionIdsVistos: subscriptionIds.size,
          subscriptionsMarcadasComoAtivas: subscriptionsAtivas.size,
          subscriptionsComPagamentoNos30Dias: subscriptionsPagasUltimos30d.size,
        },
        amostraVenda: todasVendas[0] || null,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
}
