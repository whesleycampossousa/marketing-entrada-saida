// Lista assinaturas Asaas com info de pagamento/cobrancas.
// Padrao: ACTIVE. Com ?include_inactive=1 inclui EXPIRED, INACTIVE e removidas quando permitido.
// Estrategia: poucas varreduras paginadas + correlacao local por subscription para evitar rate-limit.

export async function handler(event) {
  const ASAAS_API_KEY = process.env.ASAAS_API_KEY;
  const BASE = "https://api.asaas.com/v3";
  const HEADERS = { "Content-Type": "application/json", access_token: ASAAS_API_KEY };
  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const includeInactive = event.queryStringParameters?.include_inactive === "1";

  if (!ASAAS_API_KEY) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: "ASAAS_API_KEY nao configurada" }) };
  }

  async function paginate(url) {
    const out = [];
    let offset = 0;
    while (true) {
      const u = new URL(url);
      u.searchParams.set("limit", "100");
      u.searchParams.set("offset", String(offset));
      const r = await fetch(u.toString(), { headers: HEADERS });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`HTTP ${r.status} em ${u.pathname}: ${txt.slice(0, 200)}`);
      }
      const d = await r.json();
      const batch = d.data || [];
      out.push(...batch);
      if (!d.hasMore || batch.length === 0) break;
      offset += 100;
      if (offset > 10000) break;
      // Pequena pausa entre paginas pra evitar rate limit
      await new Promise(res => setTimeout(res, 100));
    }
    return out;
  }

  async function safePaginate(url, warnings, label) {
    try {
      return await paginate(url);
    } catch (e) {
      warnings.push(`${label}: ${e.message}`);
      return [];
    }
  }

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function paymentDateValue(payment) {
    return payment.paymentDate || payment.clientPaymentDate || payment.confirmedDate || payment.dateCreated || null;
  }

  function compareDateString(a, b) {
    if (!a) return b ? -1 : 0;
    if (!b) return 1;
    return String(a).localeCompare(String(b));
  }

  try {
    const warnings = [];

    // 1. Subscriptions
    const subsById = new Map();
    const statuses = includeInactive ? ["ACTIVE", "EXPIRED", "INACTIVE"] : ["ACTIVE"];
    for (const status of statuses) {
      const subsStatus = await safePaginate(`${BASE}/subscriptions?status=${status}`, warnings, `subscriptions ${status}`);
      subsStatus.forEach(s => subsById.set(s.id, s));
      await new Promise(res => setTimeout(res, 250));
    }

    if (includeInactive) {
      const deletedSubs = await safePaginate(`${BASE}/subscriptions?deletedOnly=true`, warnings, "subscriptions deletedOnly");
      deletedSubs.forEach(s => subsById.set(s.id, { ...s, deleted: true }));
    }

    const subs = [...subsById.values()];

    // 2. Payments dos ultimos 365 dias.
    const hoje = new Date();
    const umAno = new Date(hoje); umAno.setDate(umAno.getDate() - 365);
    const hojeIso = isoDate(hoje);
    const paymentsById = new Map();
    for (const status of ["RECEIVED", "CONFIRMED", "PENDING", "OVERDUE"]) {
      const u = `${BASE}/payments?dateCreated[ge]=${isoDate(umAno)}&dateCreated[le]=${hojeIso}&status=${status}`;
      const p = await safePaginate(u, warnings, `payments ${status}`);
      p.forEach(payment => paymentsById.set(payment.id, payment));
      await new Promise(res => setTimeout(res, 150));
    }
    const payments = [...paymentsById.values()];

    // 3. Customers (em batches pequenos e sequencial para nao throttling)
    const customerIds = [...new Set(subs.map(s => s.customer))];
    const customers = {};
    const BATCH = 25;
    for (let i = 0; i < customerIds.length; i += BATCH) {
      const batch = customerIds.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async cid => {
        try {
          const r = await fetch(`${BASE}/customers/${cid}`, { headers: HEADERS });
          return [cid, r.ok ? await r.json() : { id: cid }];
        } catch { return [cid, { id: cid }]; }
      }));
      results.forEach(([cid, c]) => { customers[cid] = c; });
      await new Promise(res => setTimeout(res, 100));
    }

    // 4. Indexar payments por subscription
    const paymentsBySub = {};
    payments.forEach(p => {
      const sid = p.subscription;
      if (!sid) return;
      if (!paymentsBySub[sid]) paymentsBySub[sid] = [];
      paymentsBySub[sid].push(p);
    });

    // 5. Montar lista
    const lista = subs.map(sub => {
      const c = customers[sub.customer] || {};
      const subPayments = paymentsBySub[sub.id] || [];
      let ultimoPago = null;
      let ultimoPagoValor = null;
      let totalPagos = 0;
      let totalPendentes = 0;
      let totalVencidos = 0;
      let openOverduePayment = null;

      for (const p of subPayments) {
        const dt = paymentDateValue(p);
        const isPaid = p.status === "RECEIVED" || p.status === "CONFIRMED";
        const isOpen = p.status === "PENDING" || p.status === "OVERDUE";
        const isOverdue = p.status === "OVERDUE" || (p.status === "PENDING" && p.dueDate && p.dueDate < hojeIso);

        if (isPaid) {
          totalPagos += 1;
          if (dt && (!ultimoPago || compareDateString(dt, ultimoPago) > 0)) {
            ultimoPago = dt;
            ultimoPagoValor = p.value ?? p.netValue ?? p.originalValue ?? null;
          }
        }

        if (isOpen) totalPendentes += 1;
        if (isOverdue) {
          totalVencidos += 1;
          if (!openOverduePayment || compareDateString(p.dueDate, openOverduePayment.dueDate) < 0) {
            openOverduePayment = {
              id: p.id,
              status: p.status,
              dueDate: p.dueDate || null,
              value: p.value ?? p.netValue ?? p.originalValue ?? null,
              invoiceUrl: p.invoiceUrl || null,
              bankSlipUrl: p.bankSlipUrl || null,
            };
          }
        }
      }

      const nextDue = sub.nextDueDate ? new Date(sub.nextDueDate) : null;
      const ultimoDt = ultimoPago ? new Date(ultimoPago) : null;
      const diasDesdeUltimoPag = ultimoDt ? Math.floor((hoje - ultimoDt) / (24*60*60*1000)) : null;
      const diasAteVencer = nextDue ? Math.floor((nextDue - hoje) / (24*60*60*1000)) : null;
      return {
        id: sub.id,
        nome: c.name || "?",
        email: c.email || "",
        telefone: c.mobilePhone || c.phone || "",
        cpf: c.cpfCnpj || "",
        valor: sub.value,
        ciclo: sub.cycle,
        status: sub.status,
        billingType: sub.billingType,
        description: sub.description || "",
        dateCreated: sub.dateCreated || null,
        deleted: Boolean(sub.deleted),
        nextDueDate: sub.nextDueDate || null,
        diasAteVencer,
        ultimoPago,
        ultimoPagoValor,
        diasDesdeUltimoPag,
        totalPagos,
        totalPendentes,
        totalVencidos,
        hasOverdueOpen: totalVencidos > 0,
        openOverduePayment,
      };
    });

    const totalPorStatus = lista.reduce((acc, item) => {
      const key = item.deleted ? "DELETED" : item.status;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Cache-Control": "no-store" },
      body: JSON.stringify({
        total: lista.length,
        totalPorStatus,
        includeInactive,
        totalPaymentsAnalisados: payments.length,
        warnings,
        lista,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
}
