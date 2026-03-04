// Netlify Function - Proxy para API do Asaas
// Busca pagamentos e dados dos clientes, retorna JSON limpo

export async function handler(event) {
  const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
  const BASE = "https://api.asaas.com/v3";
  const HEADERS = {
    "Content-Type": "application/json",
    access_token: ASAAS_API_KEY,
  };

  if (!ASAAS_API_KEY) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "ASAAS_API_KEY nao configurada" }),
    };
  }

  // Pegar datas do query string (default: mes atual)
  const params = event.queryStringParameters || {};
  const hoje = new Date();
  const anoMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const dataInicio = params.inicio || `${anoMes}-01`;
  const dataFim = params.fim || `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}`;

  try {
    // 1. Buscar todos os pagamentos no periodo
    let todosPagamentos = [];
    for (const status of ["RECEIVED", "CONFIRMED", "PENDING", "OVERDUE", "REFUNDED"]) {
      let offset = 0;
      while (true) {
        const url = new URL(`${BASE}/payments`);
        url.searchParams.set("dateCreated[ge]", dataInicio);
        url.searchParams.set("dateCreated[le]", dataFim);
        url.searchParams.set("status", status);
        url.searchParams.set("limit", "100");
        url.searchParams.set("offset", String(offset));

        const resp = await fetch(url.toString(), { headers: HEADERS });
        const data = await resp.json();
        const batch = data.data || [];
        todosPagamentos = todosPagamentos.concat(batch);
        if (!data.hasMore) break;
        offset += 100;
      }
    }

    // 2. Buscar dados dos clientes (dedup por ID)
    const clientesCache = {};
    const clienteIds = [...new Set(todosPagamentos.map((p) => p.customer))];

    await Promise.all(
      clienteIds.map(async (cid) => {
        try {
          const resp = await fetch(`${BASE}/customers/${cid}`, { headers: HEADERS });
          if (resp.ok) clientesCache[cid] = await resp.json();
          else clientesCache[cid] = {};
        } catch {
          clientesCache[cid] = {};
        }
      })
    );

    // 3. Deduplicar por cliente - manter o melhor pagamento
    const prioridade = { RECEIVED: 1, CONFIRMED: 1, PENDING: 2, OVERDUE: 3, REFUNDED: 4 };
    const porCliente = {};

    for (const p of todosPagamentos) {
      const cid = p.customer;
      const pri = prioridade[p.status] || 9;

      if (!porCliente[cid]) {
        porCliente[cid] = p;
      } else {
        const atualPri = prioridade[porCliente[cid].status] || 9;
        if (pri < atualPri || (pri === atualPri && p.value > porCliente[cid].value)) {
          porCliente[cid] = p;
        }
      }
    }

    // 4. Montar lista final
    const formas = { PIX: "PIX", CREDIT_CARD: "Cartao", BOLETO: "Boleto" };
    const statusPt = {
      PENDING: "Pendente",
      RECEIVED: "Pago",
      CONFIRMED: "Confirmado",
      OVERDUE: "Vencido",
      REFUNDED: "Estornado",
    };

    const vendas = [];
    for (const [cid, p] of Object.entries(porCliente)) {
      const c = clientesCache[cid] || {};

      // Calcular valor (installments agrupados)
      let valor = p.value;
      const inst = p.installment;
      if (inst) {
        const parcelas = todosPagamentos.filter(
          (x) => x.installment === inst && (x.status === "RECEIVED" || x.status === "CONFIRMED")
        );
        if (parcelas.length > 0) valor = parcelas.reduce((s, x) => s + x.value, 0);
      }

      vendas.push({
        nome: c.name || "N/A",
        telefone: c.mobilePhone || c.phone || "",
        email: c.email || "",
        valor,
        status: statusPt[p.status] || p.status,
        forma: formas[p.billingType] || p.billingType || "",
        data: (p.dateCreated || "").substring(0, 10),
      });
    }

    // Ordenar por data (mais recente primeiro)
    vendas.sort((a, b) => b.data.localeCompare(a.data));

    // 5. Calcular resumo
    const pagos = vendas.filter((v) => v.status === "Pago" || v.status === "Confirmado");
    const pendentes = vendas.filter((v) => v.status === "Pendente");
    const estornados = vendas.filter((v) => v.status === "Estornado");

    const resumo = {
      totalAlunos: vendas.length,
      totalPagos: pagos.length,
      totalPendentes: pendentes.length,
      totalEstornados: estornados.length,
      valorBruto: pagos.reduce((s, v) => s + v.valor, 0),
      valorPendente: pendentes.reduce((s, v) => s + v.valor, 0),
      valorEstornado: estornados.reduce((s, v) => s + v.valor, 0),
      periodo: { inicio: dataInicio, fim: dataFim },
      atualizadoEm: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=18000", // 5 horas
      },
      body: JSON.stringify({ resumo, vendas }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: error.message }),
    };
  }
}
