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
  const hojeSpParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(hoje);
  const hojeSp = `${hojeSpParts.find((p) => p.type === "year").value}-${hojeSpParts.find((p) => p.type === "month").value}-${hojeSpParts.find((p) => p.type === "day").value}`;

  const dataFim = params.fim || hojeSp;

  try {
    function roundMoney(value) {
      return Math.round((Number(value) || 0) * 100) / 100;
    }

    function dataContabilizacao(p) {
      if (p.status === "CONFIRMED" || p.status === "RECEIVED") {
        return (p.clientPaymentDate || p.confirmedDate || p.paymentDate || p.dateCreated || "").substring(0, 10);
      }
      return (p.dateCreated || "").substring(0, 10);
    }

    function estaNoPeriodo(data) {
      return data && data >= dataInicio && data <= dataFim;
    }

    function extractInvoiceNumber(description) {
      const match = String(description || "").match(/fatura nr\.\s*(\d+)/i);
      return match ? match[1] : null;
    }

    function getPairedAnticipationInvoices(transacoes) {
      const receivedInvoices = new Set();
      const debitInvoices = new Set();

      for (const t of transacoes) {
        const invoice = extractInvoiceNumber(t.description);
        if (!invoice) continue;
        if (t.type === "PAYMENT_RECEIVED" && (Number(t.value) || 0) > 0) {
          receivedInvoices.add(invoice);
        }
        if (t.type === "RECEIVABLE_ANTICIPATION_DEBIT" && (Number(t.value) || 0) < 0) {
          debitInvoices.add(invoice);
        }
      }

      return new Set([...receivedInvoices].filter((invoice) => debitInvoices.has(invoice)));
    }

    async function buscarPagamentos(status, dateFilter) {
      const pagamentos = [];
      let offset = 0;
      while (true) {
        const url = new URL(`${BASE}/payments`);
        url.searchParams.set(`${dateFilter}[ge]`, dataInicio);
        url.searchParams.set(`${dateFilter}[le]`, dataFim);
        url.searchParams.set("status", status);
        url.searchParams.set("limit", "100");
        url.searchParams.set("offset", String(offset));

        const resp = await fetch(url.toString(), { headers: HEADERS });
        const data = await resp.json();
        const batch = data.data || [];
        pagamentos.push(...batch);
        if (!data.hasMore) break;
        offset += 100;
      }
      return pagamentos;
    }

    async function buscarTransacoesFinanceiras() {
      const transacoes = [];
      let offset = 0;

      while (true) {
        const url = new URL(`${BASE}/financialTransactions`);
        url.searchParams.set("startDate", dataInicio);
        url.searchParams.set("finishDate", dataFim);
        url.searchParams.set("limit", "100");
        url.searchParams.set("offset", String(offset));
        url.searchParams.set("order", "asc");

        const resp = await fetch(url.toString(), { headers: HEADERS });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(data?.errors?.[0]?.description || data?.error || `Erro Asaas ${resp.status}`);
        }

        transacoes.push(...(data.data || []));
        if (!data.hasMore) break;
        offset += 100;
      }

      return transacoes.filter((t) => {
        const date = String(t.date || "").slice(0, 10);
        return date >= dataInicio && date <= dataFim;
      });
    }

    function resumirEntradasFinanceiras(transacoes) {
      const pairedAnticipationInvoices = getPairedAnticipationInvoices(transacoes);
      let ignoredAnticipatedSettlementTotal = 0;
      let ignoredAnticipatedSettlementCount = 0;
      const entradas = transacoes.filter((t) => {
        const value = Number(t.value) || 0;
        if (value <= 0) return false;

        const invoice = extractInvoiceNumber(t.description);
        if (t.type === "PAYMENT_RECEIVED" && invoice && pairedAnticipationInvoices.has(invoice)) {
          ignoredAnticipatedSettlementTotal = roundMoney(ignoredAnticipatedSettlementTotal + value);
          ignoredAnticipatedSettlementCount += 1;
          return false;
        }

        return true;
      });
      const porTipo = {};

      for (const t of entradas) {
        const type = t.type || "OUTRAS_ENTRADAS";
        if (!porTipo[type]) porTipo[type] = { type, count: 0, total: 0 };
        porTipo[type].count += 1;
        porTipo[type].total = roundMoney(porTipo[type].total + (Number(t.value) || 0));
      }

      // CAIXA LIQUIDO (regime de caixa) - o numero certo para dividir lucros:
      // soma TODAS as transacoes do extrato exceto TRANSFER (saque/transferencia
      // da empresa nao e receita). Por construcao:
      // - cartao so conta quando o dinheiro CREDITA (antes disso nao existe
      //   transacao no extrato; a venda aparece como cliente, mas nao no caixa);
      // - taxas (pix/cartao/mensageria/antecipacao) ja entram negativas;
      // - "dinheiro fantasma" (recebeu e estornou em seguida) se anula sozinho
      //   (entrada + estorno negativo no mesmo extrato);
      // - antecipacao se ajusta sozinha (credito antecipado + debito da
      //   liquidacao), mesmo quando o par cruza meses.
      const caixaLiquido = roundMoney(
        transacoes
          .filter((t) => t.type !== "TRANSFER")
          .reduce((s, t) => s + (Number(t.value) || 0), 0)
      );
      const descontosTotal = roundMoney(
        transacoes
          .filter((t) => t.type !== "TRANSFER" && (Number(t.value) || 0) < 0)
          .reduce((s, t) => s + (Number(t.value) || 0), 0)
      );
      // bruto REAL (todos os creditos do extrato, sem dedup): garante que
      // bruto + descontos = caixaLiquido, para o card fechar a conta na tela
      const entradasBrutasReais = roundMoney(
        transacoes
          .filter((t) => t.type !== "TRANSFER" && (Number(t.value) || 0) > 0)
          .reduce((s, t) => s + (Number(t.value) || 0), 0)
      );

      return {
        total: roundMoney(entradas.reduce((s, t) => s + (Number(t.value) || 0), 0)),
        quantidade: entradas.length,
        porTipo: Object.values(porTipo).sort((a, b) => b.total - a.total),
        ignoredAnticipatedSettlementTotal,
        ignoredAnticipatedSettlementCount,
        caixaLiquido,
        descontosTotal,
        entradasBrutasReais,
      };
    }

    function isEverydayTransfer(transaction) {
      return transaction.type === "TRANSFER" &&
        String(transaction.description || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .includes("everyday conversation");
    }

    function buildDailyCashFlow(transacoes, pagamentos, clientesCache) {
      const pairedAnticipationInvoices = getPairedAnticipationInvoices(transacoes);
      const dias = new Map();

      function ensureDay(date) {
        const key = String(date || "").slice(0, 10);
        if (!key) return null;
        if (!dias.has(key)) {
          dias.set(key, {
            data: key,
            saldoInicialAsaas: null,
            saldoFinalAsaas: null,
            entrouCaixa: 0,
            entrouCaixaQtd: 0,
            entrouCaixaDetalhes: [],
            saiuCaixa: 0,
            liquidoCaixa: 0,
            vendasAprovadas: 0,
            vendasAprovadasQtd: 0,
            vendasAprovadasDetalhes: [],
            renovacoesCartaoAprovadas: 0,
            renovacoesCartaoAprovadasQtd: 0,
            renovacoesCartaoDetalhes: [],
            antecipacoesRecebidas: 0,
            antecipacoesRecebidasQtd: 0,
            liquidacoesJaAntecipadas: 0,
            liquidacoesJaAntecipadasQtd: 0,
            transferenciasEveryday: 0,
            transferenciasEverydayQtd: 0,
          });
        }
        return dias.get(key);
      }

      for (const transaction of transacoes) {
        const day = ensureDay(transaction.date);
        if (!day) continue;

        const value = Number(transaction.value) || 0;
        if (day.saldoInicialAsaas == null && transaction.balance != null) {
          day.saldoInicialAsaas = roundMoney((Number(transaction.balance) || 0) - value);
        }
        if (transaction.balance != null) {
          day.saldoFinalAsaas = roundMoney(Number(transaction.balance) || 0);
        }

        const invoice = extractInvoiceNumber(transaction.description);
        const isPairedDebit = transaction.type === "RECEIVABLE_ANTICIPATION_DEBIT" &&
          value < 0 &&
          invoice &&
          pairedAnticipationInvoices.has(invoice);
        const isPairedReceived = transaction.type === "PAYMENT_RECEIVED" &&
          value > 0 &&
          invoice &&
          pairedAnticipationInvoices.has(invoice);

        if (isPairedDebit) {
          day.liquidacoesJaAntecipadas = roundMoney(day.liquidacoesJaAntecipadas + Math.abs(value));
          day.liquidacoesJaAntecipadasQtd += 1;
          continue;
        }
        if (isPairedReceived) continue;

        if (value < 0 && isEverydayTransfer(transaction)) {
          day.transferenciasEveryday = roundMoney(day.transferenciasEveryday + Math.abs(value));
          day.transferenciasEverydayQtd += 1;
        }

        if (value > 0) {
          day.entrouCaixa = roundMoney(day.entrouCaixa + value);
          day.entrouCaixaQtd += 1;
          day.entrouCaixaDetalhes.push({
            nome: transaction.type === "RECEIVABLE_ANTICIPATION_GROSS_CREDIT"
              ? "Cartao antecipado entrou"
              : "Cobrancas recebidas no saldo",
            valor: roundMoney(value),
          });
          if (transaction.type === "RECEIVABLE_ANTICIPATION_GROSS_CREDIT") {
            day.antecipacoesRecebidas = roundMoney(day.antecipacoesRecebidas + value);
            day.antecipacoesRecebidasQtd += 1;
          }
        } else if (value < 0) {
          day.saiuCaixa = roundMoney(day.saiuCaixa + Math.abs(value));
        }
      }

      for (const pagamento of pagamentos || []) {
        if (pagamento.status !== "RECEIVED" && pagamento.status !== "CONFIRMED") continue;
        const day = ensureDay(dataContabilizacao(pagamento));
        if (!day) continue;
        const valor = Number(pagamento.netValue ?? pagamento.value) || 0;
        const cliente = clientesCache[pagamento.customer] || {};
        const detalhe = {
          nome: cliente.name || pagamento.customer || "N/A",
          valor: roundMoney(valor),
          forma: formas[pagamento.billingType] || pagamento.billingType || "",
          status: statusPt[pagamento.status] || pagamento.status || "",
          paymentId: pagamento.id || "",
          subscriptionId: pagamento.subscription || null,
        };
        day.vendasAprovadas = roundMoney(day.vendasAprovadas + valor);
        day.vendasAprovadasQtd += 1;
        day.vendasAprovadasDetalhes.push(detalhe);
        if (pagamento.billingType === "CREDIT_CARD" && pagamento.subscription) {
          day.renovacoesCartaoAprovadas = roundMoney(day.renovacoesCartaoAprovadas + valor);
          day.renovacoesCartaoAprovadasQtd += 1;
          day.renovacoesCartaoDetalhes.push(detalhe);
        }
      }

      return [...dias.values()]
        .map((day) => ({
          ...day,
          liquidoCaixa: roundMoney(day.entrouCaixa - day.saiuCaixa),
          entrouCaixaDetalhes: day.entrouCaixaDetalhes.sort((a, b) =>
            b.valor - a.valor || String(a.nome).localeCompare(String(b.nome))
          ),
          vendasAprovadasDetalhes: day.vendasAprovadasDetalhes.sort((a, b) =>
            b.valor - a.valor || String(a.nome).localeCompare(String(b.nome))
          ),
          renovacoesCartaoDetalhes: day.renovacoesCartaoDetalhes.sort((a, b) =>
            b.valor - a.valor || String(a.nome).localeCompare(String(b.nome))
          ),
        }))
        .sort((a, b) => b.data.localeCompare(a.data));
    }

    // 1. Buscar todos os pagamentos no periodo.
    // Pagamentos aprovados sao contabilizados pela data efetiva do pagamento,
    // nao pela data em que a cobranca recorrente foi criada.
    const transacoesFinanceiras = await buscarTransacoesFinanceiras();
    const entradasFinanceiras = resumirEntradasFinanceiras(transacoesFinanceiras);

    const pagamentosPorId = new Map();
    for (const status of ["RECEIVED", "CONFIRMED"]) {
      for (const dateFilter of ["confirmedDate", "clientPaymentDate", "paymentDate"]) {
        const encontrados = await buscarPagamentos(status, dateFilter);
        encontrados.forEach((p) => {
          if (estaNoPeriodo(dataContabilizacao(p))) pagamentosPorId.set(p.id, p);
        });
      }
    }

    for (const status of ["PENDING", "OVERDUE"]) {
      const encontrados = await buscarPagamentos(status, "dueDate");
      encontrados.forEach((p) => pagamentosPorId.set(p.id, p));
    }

    const estornosEncontrados = await buscarPagamentos("REFUNDED", "dateCreated");
    estornosEncontrados.forEach((p) => pagamentosPorId.set(p.id, p));

    let todosPagamentos = [...pagamentosPorId.values()];

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

    const statusVisivel = (p) => {
      const dueDate = String(p.dueDate || "").substring(0, 10);
      if (p.status === "PENDING" && dueDate && dueDate > hojeSp) return "A vencer";
      return statusPt[p.status] || p.status;
    };

    const vendas = [];
    for (const [cid, p] of Object.entries(porCliente)) {
      const c = clientesCache[cid] || {};
      const dataBase = dataContabilizacao(p) || (p.dueDate || p.dateCreated || dataInicio || "").substring(0, 10);
      const rowMonth = (dataBase || dataInicio || "").substring(0, 7) || anoMes;

      // Calcular valor bruto e liquido (installments agrupados)
      let valor = p.value;
      let valorLiquido = p.netValue || p.value;
      const inst = p.installment;
      if (inst) {
        const parcelas = todosPagamentos.filter(
          (x) => x.installment === inst && (x.status === "RECEIVED" || x.status === "CONFIRMED")
        );
        if (parcelas.length > 0) {
          valor = parcelas.reduce((s, x) => s + x.value, 0);
          valorLiquido = parcelas.reduce((s, x) => s + (x.netValue || x.value), 0);
        }
      }

      const taxas = valor - valorLiquido;

      const status = statusVisivel(p);

      vendas.push({
        provedor: "asaas",
        rowKey: `asaas:${cid}:${rowMonth}`,
        customerId: cid,
        paymentId: p.id || "",
        subscriptionId: p.subscription || null,
        asaasStatus: p.status || null,
        document: c.cpfCnpj || null,
        nome: c.name || "N/A",
        telefone: c.mobilePhone || c.phone || "",
        email: c.email || "",
        valor,
        valorLiquido,
        taxas,
        status,
        forma: formas[p.billingType] || p.billingType || "",
        data: dataBase,
        createdAt: p.dateCreated || null,
        dueDate: p.dueDate || null,
        paymentDate: dataBase || p.paymentDate || p.clientPaymentDate || p.confirmedDate || null,
        invoiceUrl: p.invoiceUrl || null,
        bankSlipUrl: p.bankSlipUrl || null,
      });
    }

    // Ordenar por data (mais recente primeiro)
    vendas.sort((a, b) => b.data.localeCompare(a.data));
    const caixaDiario = buildDailyCashFlow(transacoesFinanceiras, todosPagamentos, clientesCache);

    // 5. Calcular resumo
    const pagos = vendas.filter((v) => v.status === "Pago" || v.status === "Confirmado");
    const pendentes = vendas.filter((v) => v.status === "Pendente");
    const aVencer = vendas.filter((v) => v.status === "A vencer");
    const estornados = vendas.filter((v) => v.status === "Estornado");
    const valorVendasLiquido = pagos.reduce((s, v) => s + v.valorLiquido, 0) - estornados.reduce((s, v) => s + v.valor, 0);

    const resumo = {
      totalAlunos: vendas.length,
      totalPagos: pagos.length,
      totalPendentes: pendentes.length,
      totalAVencer: aVencer.length,
      totalEstornados: estornados.length,
      valorBruto: pagos.reduce((s, v) => s + v.valor, 0),
      // valorFinanceiro/valorLiquido = regime de caixa: o que DE FATO caiu na
      // conta liquido para saque (extrato menos taxas/estornos/ajustes, sem
      // contar transferencias). E o numero para divisao de lucros.
      valorLiquido: entradasFinanceiras.caixaLiquido,
      valorVendasLiquido,
      valorFinanceiro: entradasFinanceiras.caixaLiquido,
      entradasBrutasExtrato: entradasFinanceiras.entradasBrutasReais,
      descontosExtrato: entradasFinanceiras.descontosTotal,
      totalEntradasFinanceiras: entradasFinanceiras.quantidade,
      entradasFinanceirasPorTipo: entradasFinanceiras.porTipo,
      entradasBaixaAntecipacaoIgnoradas: entradasFinanceiras.ignoredAnticipatedSettlementTotal,
      entradasBaixaAntecipacaoIgnoradasQtd: entradasFinanceiras.ignoredAnticipatedSettlementCount,
      caixaDiario,
      criterioValor: "extrato_liquido_exceto_transferencias",
      valorPendente: pendentes.reduce((s, v) => s + v.valor, 0),
      valorAVencer: aVencer.reduce((s, v) => s + v.valor, 0),
      valorEstornado: estornados.reduce((s, v) => s + v.valor, 0),
      periodo: { inicio: dataInicio, fim: dataFim },
      atualizadoEm: new Date().toISOString(),
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
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
