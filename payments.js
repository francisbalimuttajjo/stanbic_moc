// Relworx payment gateway mock: mobile money collections and payouts, Visa card
// sessions and product purchases. Payments wait as "pending" until you complete
// them on the settings page (or automatically, if configured). Completing one
// sends the same webhook Relworx would send to vaulit-web.
//
// Mounted under /relworx, so vaulit-web's RelworxServices::Config base URL is
// http://localhost:4010/relworx and the paths match payments.relworx.com.

const crypto = require('crypto');

const MAX_PAYMENTS = 200;

const KINDS = {
  collection: {
    label: 'Mobile money collection',
    usedBy: 'Card payments (service payments) and wallet top-ups',
    // Same Relworx endpoint for both: try service payments first, then wallet top-ups.
    webhooks: ['/webhooks/relworx_service_payments', '/webhooks/relworx_mobile_money_requests'],
  },
  payout: {
    label: 'Mobile money payout',
    usedBy: 'Wallet withdrawals to mobile money',
    webhooks: ['/webhooks/relworx_mobile_money_requests'],
  },
  visa: {
    label: 'Visa card payment',
    usedBy: 'Wallet top-ups by card (checkout page)',
    webhooks: ['/webhooks/relworx_visa_payment_requests'],
  },
  product: {
    label: 'Product purchase',
    usedBy: 'Airtime, bills and other products',
    webhooks: ['/webhooks/relworx_product_purchase_requests'],
  },
};

const ROUTES = {
  'POST /relworx/api/mobile-money/request-payment': 'collection',
  'POST /relworx/api/mobile-money/send-payment': 'payout',
  'POST /relworx/api/visa/request-session': 'visa',
  'POST /relworx/api/products/purchase': 'product',
};

const defaultPaymentsConfig = () => ({
  mode: 'manual', // 'manual' | 'auto'
  autoDelaySec: 5,
  autoOutcome: 'success', // 'success' | 'failed'
  onNewRequest: 'accept', // 'accept' | 'reject' | 'server_error'
  webhookTargets: [
    {url: 'http://localhost:3000', enabled: true},
    {url: '', enabled: false},
  ],
  checkoutBaseUrl: '',
});

const normalizePaymentsConfig = raw => {
  const base = defaultPaymentsConfig();
  const merged = {...base, ...(raw || {})};
  return {
    mode: merged.mode === 'auto' ? 'auto' : 'manual',
    autoDelaySec: Math.max(0, Number(merged.autoDelaySec) || 0),
    autoOutcome: merged.autoOutcome === 'failed' ? 'failed' : 'success',
    onNewRequest: ['accept', 'reject', 'server_error'].includes(merged.onNewRequest) ? merged.onNewRequest : 'accept',
    webhookTargets: (Array.isArray(merged.webhookTargets) ? merged.webhookTargets : base.webhookTargets)
      .slice(0, 5)
      .map(t => ({url: String(t?.url || '').trim().replace(/\/+$/, ''), enabled: Boolean(t?.enabled)})),
    checkoutBaseUrl: String(merged.checkoutBaseUrl || '').trim().replace(/\/+$/, ''),
  };
};

const createPayments = ({getConfig, addLog}) => {
  const payments = [];
  const preferredWebhook = {}; // account_no -> webhook path that worked last time
  let seq = 0;

  const settings = () => getConfig().payments;
  const find = ref => payments.find(p => p.id === ref || p.internalReference === ref || p.customerReference === ref);

  const deliver = async payment => {
    const kind = KINDS[payment.kind];
    const preferred = preferredWebhook[payment.accountNo];
    const paths = preferred ? [preferred, ...kind.webhooks.filter(p => p !== preferred)] : kind.webhooks;
    const body = {
      status: payment.status,
      message: payment.message,
      customer_reference: payment.customerReference,
      internal_reference: payment.internalReference,
      msisdn: payment.msisdn,
      amount: payment.amount,
      currency: payment.currency,
      provider: payment.kind === 'visa' ? 'VISA' : 'MTN_UGANDA',
      completed_at: new Date().toISOString(),
      ...(payment.kind === 'product' ? {token: payment.token || null, token_value: payment.token || null, units: payment.units || null} : {}),
    };

    const targets = settings().webhookTargets.filter(t => t.enabled && t.url);
    if (!targets.length) {
      payment.webhooks.push({target: '-', path: '-', status: 'skipped', ok: false, note: 'No webhook target enabled'});
      return;
    }

    for (const target of targets) {
      for (const path of paths) {
        const attempt = {target: target.url, path, at: new Date().toISOString()};
        try {
          const response = await fetch(`${target.url}${path}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Accept: 'application/json', 'ngrok-skip-browser-warning': 'true'},
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          });
          attempt.status = response.status;
          attempt.ok = response.ok;
        } catch (error) {
          attempt.status = 'error';
          attempt.ok = false;
          attempt.note = error.cause?.code || error.name || error.message;
        }
        payment.webhooks.push(attempt);
        addLog({
          method: 'POST', path: `${target.url}${path}`, endpoint: `Webhook → ${kind.label}`, mode: 'webhook',
          status: attempt.status, request: body, response: attempt.note || (attempt.ok ? 'OK' : 'Rejected'),
        });
        if (attempt.ok) {
          if (payment.accountNo && kind.webhooks.length > 1) preferredWebhook[payment.accountNo] = path;
          break; // this target is done
        }
        // Only fall through to the next webhook when the API couldn't match the reference.
        if (attempt.status === 'error') break;
      }
    }
  };

  const complete = async (payment, {status, message, token, units} = {}) => {
    if (payment.status !== 'pending') return payment;
    payment.status = status === 'failed' ? 'failed' : 'success';
    payment.message = message || (payment.status === 'success' ? 'Payment completed successfully (mock).' : 'Payment failed (mock).');
    if (payment.kind === 'product') {
      payment.token = token || (payment.status === 'success' ? String(Math.floor(1e19 * Math.random())).padStart(20, '0') : null);
      payment.units = units || (payment.status === 'success' ? '12.5' : null);
    }
    payment.completedAt = new Date().toISOString();
    clearTimeout(payment.autoTimer);
    await deliver(payment);
    return payment;
  };

  const create = (kind, body, req) => {
    const id = `P${++seq}`;
    const payment = {
      id,
      kind,
      kindLabel: KINDS[kind].label,
      createdAt: new Date().toISOString(),
      status: 'pending',
      customerReference: body.reference || body.validation_reference || null,
      internalReference: `MOCK${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      accountNo: body.account_no || null,
      msisdn: body.msisdn || null,
      amount: body.amount ?? null,
      currency: body.currency || 'UGX',
      description: body.description || null,
      validationReference: body.validation_reference || null,
      webhooks: [],
    };
    if (kind === 'visa') {
      const base = settings().checkoutBaseUrl || `http://${req.headers.host}`;
      payment.paymentUrl = `${base}/__pay/checkout/${id}`;
    }
    payments.unshift(payment);
    if (payments.length > MAX_PAYMENTS) payments.pop();

    const s = settings();
    if (s.mode === 'auto') {
      payment.autoTimer = setTimeout(() => complete(payment, {status: s.autoOutcome}), s.autoDelaySec * 1000);
      payment.autoCompletesAt = new Date(Date.now() + s.autoDelaySec * 1000).toISOString();
    }
    return payment;
  };

  // Relworx API routes. Returns [status, body] or null when the route isn't a payments route.
  const handleGateway = (req, url, body) => {
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;

    if (route === 'GET /relworx/api/mobile-money/check-request-status') {
      const payment = find(url.searchParams.get('internal_reference'));
      if (!payment) return [404, {success: false, message: 'Request not found (mock).'}];
      return [200, {
        success: true,
        request_status: payment.status === 'pending' ? 'in_progress' : payment.status,
        message: payment.message || 'Request is in progress (mock).',
        customer_reference: payment.customerReference,
        internal_reference: payment.internalReference,
      }];
    }

    const kind = ROUTES[route];
    if (!kind) return null;

    const onNew = settings().onNewRequest;
    if (onNew === 'reject') return [400, {success: false, message: 'Invalid request (mock rejection).'}];
    if (onNew === 'server_error') return [500, {success: false, message: 'Internal server error (mock).'}];

    const payment = create(kind, body, req);
    if (kind === 'visa') {
      return [200, {success: true, message: 'Session created (mock).', internal_reference: payment.internalReference, payment_url: payment.paymentUrl}];
    }
    if (kind === 'product') {
      return [200, {success: true, message: 'Purchase in progress (mock).', internal_reference: payment.internalReference}];
    }
    return [200, {success: true, message: 'Request payment in progress (mock).', internal_reference: payment.internalReference}];
  };

  // Visa checkout page the app opens (payment_url). Returns true when handled.
  const handleCheckout = async (req, res, url, body) => {
    const match = url.pathname.match(/^\/__pay\/checkout\/(P\d+)(?:\/(approve|decline))?$/);
    if (!match) return false;
    const payment = payments.find(p => p.id === match[1]);
    const html = inner => `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mock card checkout</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f6f5;color:#102a26;margin:0;padding:24px}main{max-width:420px;margin:0 auto;background:#fff;border:1px solid #dde5e2;border-radius:14px;padding:22px}h1{font-size:19px;margin:0 0 6px}p{color:#5d6c69;margin:6px 0}.amt{font-size:26px;font-weight:700;color:#102a26;margin:14px 0}form{display:inline}button{font-size:16px;padding:12px 18px;border-radius:10px;border:1px solid #dde5e2;background:#fff;margin:14px 8px 0 0;cursor:pointer}.ok{background:#00875f;border-color:#00875f;color:#fff}.no{color:#b3261e}.tag{display:inline-block;font-size:12px;background:#fff4dc;color:#8a5a00;border-radius:99px;padding:2px 8px}</style></head><body><main>${inner}</main></body></html>`;
    const send = (status, content) => {
      res.writeHead(status, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(html(content));
    };

    if (!payment) {
      send(404, '<h1>Payment not found</h1><p>This mock payment no longer exists. The mock forgets payments when it restarts.</p>');
      return true;
    }
    if (match[2] && req.method === 'POST' && payment.status === 'pending') {
      await complete(payment, {status: match[2] === 'approve' ? 'success' : 'failed'});
    }
    if (payment.status !== 'pending') {
      send(200, `<span class="tag">Mock Visa checkout</span><h1>Payment ${payment.status === 'success' ? 'approved' : 'declined'}</h1><p>${payment.message}</p><p>You can close this page and return to the app.</p>`);
      return true;
    }
    send(200, `<span class="tag">Mock Visa checkout</span><h1>Pay with card</h1><p>${payment.description || 'Vaulit payment'}</p><div class="amt">${payment.currency} ${Number(payment.amount || 0).toLocaleString()}</div><p>Reference ${payment.customerReference || payment.internalReference}</p><form method="post" action="/__pay/checkout/${payment.id}/approve"><button class="ok">Approve payment</button></form><form method="post" action="/__pay/checkout/${payment.id}/decline"><button class="no">Decline</button></form>`);
    return true;
  };

  // Settings-page API. Returns [status, body] or null.
  const handleAdmin = async (route, url, body) => {
    if (route === 'GET /__mock/api/payments') {
      return [200, {payments: payments.map(({autoTimer, ...p}) => p), kinds: KINDS}];
    }
    if (route === 'DELETE /__mock/api/payments') {
      payments.forEach(p => clearTimeout(p.autoTimer));
      payments.length = 0;
      return [200, {ok: true}];
    }
    const match = route.match(/^POST \/__mock\/api\/payments\/(P\d+)\/(complete|resend)$/);
    if (match) {
      const payment = payments.find(p => p.id === match[1]);
      if (!payment) return [404, {message: 'Payment not found'}];
      if (match[2] === 'resend') {
        if (payment.status === 'pending') return [400, {message: 'Complete the payment first'}];
        await deliver(payment);
      } else {
        await complete(payment, body || {});
      }
      const {autoTimer, ...rest} = payment;
      return [200, {payment: rest}];
    }
    return null;
  };

  return {handleGateway, handleCheckout, handleAdmin};
};

module.exports = {createPayments, defaultPaymentsConfig, normalizePaymentsConfig, KINDS};
