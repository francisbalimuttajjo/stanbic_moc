#!/usr/bin/env node
// Stanbic mock server for Vaulit development.
// No dependencies: `node server.js` (Node 18+). Settings page: http://localhost:4010/__mock
//
// Each Stanbic endpoint vaulit-web calls has a set of preset responses (happy path
// plus the failure cases) and a "custom" mode where you type the status and JSON.
// The default mode for every endpoint is "auto": happy path, but the special test
// values in README.md still trigger their failure cases.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4010);
const CONFIG_PATH = process.env.MOCK_CONFIG_PATH || path.join(__dirname, 'config.json');
const ADMIN_TOKEN = process.env.MOCK_ADMIN_TOKEN || '';
const UI_HTML = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');
const MAX_LOGS = 100;

const randomId = (prefix, length = 8) =>
  `${prefix}${crypto.randomBytes(length).toString('hex').slice(0, length).toUpperCase()}`;
const endsWith = (value, suffix) => String(value ?? '').trim().endsWith(suffix);

// Remembers the names from the last NIN check so the account lookup can return
// a matching account holder name (the real Stanbic knows the actual holder).
const memory = {lastPerson: null};

// ---- Shared responses ------------------------------------------------------

const SERVER_ERROR = {label: 'Server error (500)', run: () => [500, {message: 'Internal server error (mock)'}]};
const TIMEOUT = {label: 'No response (hangs 60s)', hangMs: 60000, run: () => [504, {message: 'Gateway timeout (mock)'}]};
const REQUEST_FAILED = moreInformation => [200, {message: 'Request Failed', moreInformation}];
const SUCCESS_ECHO = prefix => body => [
  200,
  {status: 'SUCCESS', transactionId: randomId(prefix), requestId: body.requestId, accountId: body.accountId},
];

const nira = (body, {matching = 'true', cardStatus = 'Valid'} = {}) => [
  200,
  {
    verifyPersonInformationResponse: {
      return: {
        transactionStatus: {transactionStatus: 'Ok', passwordDaysLeft: '25', executionCost: '0'},
        matchingStatus: matching,
        cardStatus,
      },
    },
    nationalId: body.nationalId,
  },
];

const niraError = (body, message) => [
  200,
  {
    verifyPersonInformationResponse: {
      return: {transactionStatus: {transactionStatus: 'Error', error: {code: '321', message}}},
    },
    nationalId: body.nationalId,
  },
];

const account = (body, overrides = {}) => {
  const person = memory.lastPerson || {};
  return [
    200,
    {
      accountId: body.accountId,
      status: 'A',
      name: [person.givenNames, person.surname].filter(Boolean).join(' ') || 'MOCK ACCOUNT HOLDER',
      branchCode: '031038',
      accountType: 'SAVINGS A/C',
      currency: 'UGX',
      customerId: `CIF${String(body.accountId ?? '').slice(-6) || '000001'}`,
      ...overrides,
    },
  ];
};

const cardHolder = (body, config, overrides = {}) => {
  const holder = config.cardHolder || {};
  const accountId = String(body.accountId ?? '');
  return [
    200,
    {
      accountId,
      firstName: holder.firstName || 'MOCK',
      lastName: holder.lastName || 'HOLDER',
      idValue: holder.idValue || null,
      cardStatus: 'AC',
      l4: accountId.slice(-4),
      currency: body.currency || 'UGX',
      ...overrides,
    },
  ];
};

const registration = withPassCode => {
  const accountId = String(Math.floor(1e9 + Math.random() * 9e9));
  return [
    200,
    {
      registrationAccountId: accountId,
      registrationLast4Digits: accountId.slice(-4),
      registrationPassCode: withPassCode ? '123456' : null,
    },
  ];
};

// ---- Endpoints ---------------------------------------------------------------
// auto(): the default mode. Happy path, with the README's test values applied.

const ENDPOINTS = [
  {
    key: 'token',
    name: 'OAuth token',
    method: 'POST',
    path: '/ug/oauth2/token',
    usedBy: 'Every Stanbic call (the API caches the token)',
    autoHelp: 'Always issues a token.',
    scenarios: {
      happy: {label: 'Token issued', run: () => [200, {access_token: randomId('mock-token-', 24), token_type: 'Bearer', expires_in: 3600}]},
      unauthorized: {label: 'Invalid client credentials (401)', run: () => [401, {error: 'invalid_client', error_description: 'Client authentication failed (mock)'}]},
      server_error: SERVER_ERROR,
    },
  },
  {
    key: 'nira',
    name: 'NIN check (NIRA)',
    method: 'POST',
    path: '/nira/verifyPersonInformation',
    usedBy: 'Submit / update details',
    autoHelp: 'NIN ending 0000 = not found, 1111 = details don\'t match, 2222 = server error.',
    remember: body => {
      if (body.givenNames || body.surname) memory.lastPerson = {givenNames: body.givenNames, surname: body.surname};
    },
    auto: body => {
      if (endsWith(body.nationalId, '0000')) return niraError(body, 'Person with the given NIN was not found.');
      if (endsWith(body.nationalId, '2222')) return SERVER_ERROR.run();
      return nira(body, {matching: endsWith(body.nationalId, '1111') ? 'false' : 'true'});
    },
    scenarios: {
      happy: {label: 'Details match', run: body => nira(body)},
      no_match: {label: 'Details don\'t match (matchingStatus false)', run: body => nira(body, {matching: 'false'})},
      card_expired: {label: 'NIN card not valid', run: body => nira(body, {cardStatus: 'Expired'})},
      not_found: {label: 'Person not found (NIRA error)', run: body => niraError(body, 'Person with the given NIN was not found.')},
      malformed: {label: 'Non-JSON response (200)', run: () => [200, '<html><body>Gateway error</body></html>']},
      server_error: SERVER_ERROR,
      timeout: TIMEOUT,
    },
  },
  {
    key: 'account_lookup',
    name: 'Account lookup',
    method: 'POST',
    path: '/enterprise/account-lookup',
    usedBy: 'Submit / update details, then confirm verification',
    autoHelp: 'Holder name = names from the last NIN check. Account ending 999 = not found, 888 = someone else\'s, 777 = not active, 666 = KYC upload later fails.',
    auto: body => {
      const id = body.accountId;
      if (endsWith(id, '999')) return REQUEST_FAILED('Account not found.');
      if (endsWith(id, '888')) return account(body, {name: 'JOHN DIFFERENT PERSON'});
      if (endsWith(id, '777')) return account(body, {status: 'D'});
      if (endsWith(id, '666')) return account(body, {customerId: 'CIF-FAILKYC'});
      return account(body);
    },
    scenarios: {
      happy: {label: 'Active account, name matches', run: body => account(body)},
      name_mismatch: {label: 'Active, but someone else\'s name', run: body => account(body, {name: 'JOHN DIFFERENT PERSON'})},
      inactive: {label: 'Account not active (status D)', run: body => account(body, {status: 'D'})},
      no_customer_id: {label: 'No customer ID (KYC upload can\'t run)', run: body => account(body, {customerId: null})},
      not_found: {label: 'Account not found ("Request Failed")', run: () => REQUEST_FAILED('Account not found.')},
      server_error: SERVER_ERROR,
      timeout: TIMEOUT,
    },
  },
  {
    key: 'screening',
    name: 'PEP / sanctions screening',
    method: 'POST',
    path: '/account-screening/v1/person/screen',
    usedBy: 'Submit / update details (result stored, doesn\'t block)',
    autoHelp: 'Surname FLAGGED = flagged, SCREENFAIL = server error.',
    auto: body => {
      const surname = String(body.lastName || '').toUpperCase();
      if (surname === 'SCREENFAIL') return SERVER_ERROR.run();
      return surname === 'FLAGGED'
        ? [200, {assessmentId: randomId('ASM-'), result: 'FlaggedAsRisky', riskScore: 87}]
        : [200, {assessmentId: randomId('ASM-'), result: 'AcceptableRisk', riskScore: 12}];
    },
    scenarios: {
      happy: {label: 'Acceptable risk', run: () => [200, {assessmentId: randomId('ASM-'), result: 'AcceptableRisk', riskScore: 12}]},
      flagged: {label: 'Flagged as risky', run: () => [200, {assessmentId: randomId('ASM-'), result: 'FlaggedAsRisky', riskScore: 87}]},
      server_error: SERVER_ERROR,
    },
  },
  {
    key: 'kyc_upload',
    name: 'KYC document upload (DSX)',
    method: 'POST',
    path: '/dsx/upload/kyc-docs/upload',
    usedBy: 'Submit address',
    autoHelp: 'Fails when the CIF came from an account ending 666.',
    auto: body =>
      String(body.cifNumber).includes('FAILKYC')
        ? [500, {message: 'Document upload failed (mock)'}]
        : [200, {status: 'SUCCESS', documentId: randomId('DOC-'), cifNumber: body.cifNumber}],
    scenarios: {
      happy: {label: 'Uploaded', run: body => [200, {status: 'SUCCESS', documentId: randomId('DOC-'), cifNumber: body.cifNumber}]},
      rejected: {label: 'Rejected (400)', run: () => [400, {message: 'Invalid document (mock)'}]},
      server_error: SERVER_ERROR,
      timeout: TIMEOUT,
    },
  },
  {
    key: 'registration',
    name: 'Prepaid card instant registration',
    method: 'POST',
    path: '/ppc/3.0.0/instant-registration',
    usedBy: 'Link card (Stanbic customer) and retry registration',
    autoHelp: 'Always registers a new card (no passcode).',
    scenarios: {
      happy: {label: 'Card registered', run: () => registration(false)},
      with_passcode: {label: 'Card registered, with passcode', run: () => registration(true)},
      failed: {label: 'Registration failed (422)', run: () => [422, {code: 'REG_FAILED', message: 'Card registration failed (mock).'}]},
      server_error: SERVER_ERROR,
      timeout: TIMEOUT,
    },
  },
  {
    key: 'customer_data',
    name: 'Card holder lookup (customer data)',
    method: 'POST',
    path: '/ppc/3.0.0/customer-data',
    usedBy: 'Link card (not a Stanbic customer)',
    autoHelp: 'Holder = "Card holder" below. Card ID ending 000 = not found, 111 = not active, 222 = someone else\'s.',
    auto: (body, config) => {
      const id = body.accountId;
      if (endsWith(id, '000')) return REQUEST_FAILED('Card account not found.');
      if (endsWith(id, '111')) return cardHolder(body, config, {cardStatus: 'IA'});
      if (endsWith(id, '222')) return cardHolder(body, config, {firstName: 'SOMEONE', lastName: 'ELSE', idValue: 'CM00000000ZZZ'});
      return cardHolder(body, config);
    },
    scenarios: {
      happy: {label: 'Active card, belongs to the user', run: (body, config) => cardHolder(body, config)},
      inactive: {label: 'Card not active (IA)', run: (body, config) => cardHolder(body, config, {cardStatus: 'IA'})},
      someone_else: {label: 'Card belongs to someone else', run: (body, config) => cardHolder(body, config, {firstName: 'SOMEONE', lastName: 'ELSE', idValue: 'CM00000000ZZZ'})},
      not_found: {label: 'Card not found ("Request Failed")', run: () => REQUEST_FAILED('Card account not found.')},
      server_error: SERVER_ERROR,
      timeout: TIMEOUT,
    },
  },
  {
    key: 'wallet_to_card',
    name: 'Wallet to card transfer',
    method: 'POST',
    path: '/ppc/3.0.0/wallettocard-transfer',
    usedBy: 'Not called by the API yet',
    autoHelp: 'Always succeeds.',
    scenarios: {
      happy: {label: 'Transfer succeeded', run: SUCCESS_ECHO('W2C-')},
      failed: {label: 'Transfer failed (400)', run: () => [400, {status: 'FAILED', message: 'Insufficient card balance (mock)'}]},
      server_error: SERVER_ERROR,
    },
  },
  {
    key: 'card_to_wallet',
    name: 'Card to wallet transfer',
    method: 'POST',
    path: '/ppc/3.0.0/cardtowallet-transfer',
    usedBy: 'Not called by the API yet',
    autoHelp: 'Always succeeds.',
    scenarios: {
      happy: {label: 'Transfer succeeded', run: SUCCESS_ECHO('C2W-')},
      failed: {label: 'Transfer failed (400)', run: () => [400, {status: 'FAILED', message: 'Insufficient card balance (mock)'}]},
      server_error: SERVER_ERROR,
    },
  },
  {
    key: 'card_status',
    name: 'Card status update',
    method: 'POST',
    path: '/ppc/2.0.0/update-card-status',
    usedBy: 'Not called by the API yet',
    autoHelp: 'Always succeeds.',
    scenarios: {
      happy: {label: 'Status updated', run: body => [200, {status: 'SUCCESS', accountId: body.accountId, cardStatus: body.cardStatus}]},
      failed: {label: 'Update failed (400)', run: () => [400, {status: 'FAILED', message: 'Invalid card status (mock)'}]},
      server_error: SERVER_ERROR,
    },
  },
];

const BY_ROUTE = Object.fromEntries(ENDPOINTS.map(e => [`${e.method} ${e.path}`, e]));
const BY_KEY = Object.fromEntries(ENDPOINTS.map(e => [e.key, e]));

// ---- Config ------------------------------------------------------------------

const sampleBody = {
  nationalId: 'CM12345678ABCD', givenNames: 'MIKE', surname: 'MATOVU', accountId: '1203247565',
  lastName: 'MATOVU', cifNumber: 'CIF247565', requestId: 'REQ123', cardStatus: 'BL', currency: 'UGX',
};

const defaultConfig = () => ({
  delayMs: 0,
  cardHolder: {firstName: 'MOCK', lastName: 'HOLDER', idValue: ''},
  endpoints: Object.fromEntries(
    ENDPOINTS.map(e => {
      const [status, body] = e.scenarios.happy.run(sampleBody, {cardHolder: {}});
      return [e.key, {mode: 'auto', delayMs: 0, custom: {status, body: JSON.stringify(body, null, 2)}}];
    }),
  ),
});

// Accepts the older flat config.json (registration/kycUpload keys) too.
const normalizeConfig = raw => {
  const base = defaultConfig();
  const config = {
    ...base,
    ...raw,
    cardHolder: {...base.cardHolder, ...(raw?.cardHolder || {})},
    endpoints: {...base.endpoints},
  };
  for (const key of Object.keys(base.endpoints)) {
    const saved = raw?.endpoints?.[key] || {};
    const endpoint = BY_KEY[key];
    const mode = ['auto', 'custom', ...Object.keys(endpoint.scenarios)].includes(saved.mode) ? saved.mode : 'auto';
    config.endpoints[key] = {
      ...base.endpoints[key],
      ...saved,
      mode,
      delayMs: Math.max(0, Number(saved.delayMs) || 0),
      custom: {...base.endpoints[key].custom, ...(saved.custom || {})},
    };
  }
  if (raw?.registration === 'fail' && !raw?.endpoints) config.endpoints.registration.mode = 'failed';
  if (raw?.kycUpload === 'fail' && !raw?.endpoints) config.endpoints.kyc_upload.mode = 'server_error';
  config.delayMs = Math.max(0, Number(config.delayMs) || 0);
  delete config.registration;
  delete config.kycUpload;
  delete config.returnPassCode;
  return config;
};

const loadConfig = () => {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch {
    return defaultConfig();
  }
};

let config = loadConfig();
const saveConfig = next => {
  config = normalizeConfig(next);
  try {
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    console.error(`! Could not write ${CONFIG_PATH}: ${error.message}`);
  }
  return config;
};

// ---- Responding --------------------------------------------------------------

const logs = [];
let logId = 0;

const respondFor = (endpoint, body) => {
  const settings = config.endpoints[endpoint.key];
  endpoint.remember?.(body);

  if (settings.mode === 'custom') {
    let parsed = settings.custom.body;
    try {
      parsed = JSON.parse(settings.custom.body);
    } catch {
      // send as raw text
    }
    return {status: Number(settings.custom.status) || 200, body: parsed, hangMs: 0};
  }

  const scenario = endpoint.scenarios[settings.mode];
  if (scenario) {
    const [status, responseBody] = scenario.run(body, config);
    return {status, body: responseBody, hangMs: scenario.hangMs || 0};
  }

  const [status, responseBody] = (endpoint.auto || endpoint.scenarios.happy.run)(body, config);
  return {status, body: responseBody, hangMs: 0};
};

const send = (res, status, body, headers = {}) => {
  const isText = typeof body === 'string';
  res.writeHead(status, {'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json', ...headers});
  res.end(isText ? body : JSON.stringify(body));
};

const parseBody = (raw, contentType = '') => {
  if (!raw) return {};
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw);
  } catch {
    return {raw};
  }
};

// Shorten base64 documents etc. in logs.
const trimForLog = value =>
  JSON.parse(
    JSON.stringify(value ?? null, (key, v) =>
      typeof v === 'string' && v.length > 200 ? `${v.slice(0, 60)}…(${v.length} chars)` : v,
    ),
  );

const authorized = req => {
  if (!ADMIN_TOKEN) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const password = Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return password === ADMIN_TOKEN;
};

const handleAdmin = (req, res, url, body) => {
  if (url.pathname === '/__mock/health') return send(res, 200, {ok: true, requests: logId, lastPerson: memory.lastPerson});
  if (!authorized(req)) {
    return send(res, 401, {message: 'Unauthorized'}, {'WWW-Authenticate': 'Basic realm="Stanbic mock"'});
  }

  const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
  switch (route) {
    case 'GET /__mock':
      return send(res, 200, UI_HTML);
    case 'GET /__mock/api/state':
      return send(res, 200, {
        config,
        endpoints: ENDPOINTS.map(e => ({
          key: e.key, name: e.name, method: e.method, path: e.path, usedBy: e.usedBy, autoHelp: e.autoHelp,
          scenarios: Object.entries(e.scenarios).map(([key, s]) => ({key, label: s.label})),
        })),
      });
    case 'PUT /__mock/api/config':
      if (!body || typeof body !== 'object' || body.raw) return send(res, 400, {message: 'Expected a JSON config'});
      return send(res, 200, {config: saveConfig(body)});
    case 'POST /__mock/api/reset':
      return send(res, 200, {config: saveConfig(defaultConfig())});
    case 'GET /__mock/api/logs': {
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, {logs: logs.filter(l => l.id > since)});
    }
    case 'DELETE /__mock/api/logs':
      logs.length = 0;
      return send(res, 200, {ok: true});
    default:
      return send(res, 404, {message: `No admin route ${route}`});
  }
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => (raw += chunk));
  req.on('end', () => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const body = parseBody(raw, req.headers['content-type']);

    if (url.pathname === '/' && req.method === 'GET') return send(res, 302, '', {Location: '/__mock'});
    if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
    if (url.pathname.startsWith('/__mock')) return handleAdmin(req, res, url, body);

    const routeKey = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
    const endpoint = BY_ROUTE[routeKey];
    const started = Date.now();
    const result = endpoint
      ? respondFor(endpoint, body)
      : {status: 404, body: {message: `No mock for ${routeKey}`}, hangMs: 0};
    const settings = endpoint ? config.endpoints[endpoint.key] : null;
    const delay = result.hangMs || settings?.delayMs || config.delayMs || 0;

    setTimeout(() => {
      send(res, result.status, result.body);
      const entry = {
        id: ++logId,
        time: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        endpoint: endpoint?.name || 'Unknown route',
        mode: settings?.mode || '-',
        status: result.status,
        ms: Date.now() - started,
        request: trimForLog(body),
        response: trimForLog(result.body),
      };
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs.shift();
      console.log(`[${entry.time.slice(11, 19)}] ${routeKey} -> ${result.status} (${entry.mode}, ${entry.ms}ms)`);
    }, delay);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Stanbic mock listening on http://localhost:${PORT}`);
  console.log(`Settings page: http://localhost:${PORT}/__mock${ADMIN_TOKEN ? ' (password protected)' : ''}`);
});
