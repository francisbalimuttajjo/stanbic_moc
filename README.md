# Stanbic mock server

A stand-in for the Stanbic APIs that `vaulit-web` calls during card self-onboarding
(`self-card-onboarding-v2`). You pick each endpoint's response on a settings page, so
you can build and test the mobile flow without Stanbic's IP allowlist or real data.

- Node 18+, **no dependencies**: `node server.js`
- Settings page: **http://localhost:4010/__mock**
- Every endpoint defaults to the **happy path**

## 1. Run it locally

```bash
cd /Volumes/CaseSensitiveDisk/stanbic-mock
node server.js
```

Open http://localhost:4010/__mock.

In development, `vaulit-web` already calls `http://localhost:4010` by default
(`StanbicBankServices::Config`). Use `STANBIC_USE_REAL=1 bin/rails s` for the real
Stanbic sandbox, or `STANBIC_SERVER_URL=<url> bin/rails s` for a deployed mock (section 4).

## 2. The settings page

Each Stanbic endpoint has a card with a **response** dropdown and a **delay**:

| Response option | What the API gets |
|---|---|
| **Happy path (test values apply)**: the default | The happy path, but the test values below still trigger failures |
| A failure case (e.g. *Details don't match*, *Account not found*, *Server error (500)*, *No response (hangs 60s)*) | That response for **every** request until you change it back |
| **… (always)** | The happy path, ignoring test values |
| **Custom response…** | Exactly the HTTP status and JSON you type (pre-filled with the happy-path response) |

- Changes save automatically and apply to the next request. Cards you've changed get an amber border.
- **Delay**: per endpoint, or **Delay for every response** in the header. A per-endpoint delay overrides the global one.
- **Requests** panel: every call the API makes, live. Click one to see the request and response.
- **Everything happy path** sets every endpoint back to the default. **Reset to defaults** also resets the card holder and custom responses.
- **Export / Import** saves or loads all the settings as a JSON file (useful on the deployed mock, which forgets settings when it restarts).

### Failure cases per endpoint

| Endpoint | Used by | Failure options |
|---|---|---|
| OAuth token | every call | invalid credentials (401), server error |
| NIN check (NIRA) | submit/update details | details don't match, NIN card not valid, person not found, non-JSON response, server error, hang |
| Account lookup | submit/update details, confirm | someone else's name, not active, no customer ID, not found, server error, hang |
| PEP / sanctions screening | submit/update details | flagged, server error |
| KYC document upload | submit address | rejected (400), server error, hang |
| Card instant registration | link card / retry | with passcode, failed (422), server error, hang |
| Card holder lookup | link card (not a Stanbic customer) | not active, someone else's card, not found, server error, hang |
| Wallet↔card transfers, card status | not called by the API yet | failed (400), server error |

### Test values (in "Happy path (test values apply)" mode)

Handy for testing a failure from the app without opening the settings page.

| Endpoint | You enter | Result |
|---|---|---|
| NIN check | NIN ending `0000` / `1111` / `2222` | not found / details don't match / server error |
| Account lookup | account ending `999` / `888` / `777` / `666` | not found / someone else's / not active / KYC upload later fails |
| Screening | surname `FLAGGED` / `SCREENFAIL` | flagged / server error |
| Card holder lookup | card ID ending `000` / `111` / `222` | not found / not active / someone else's |

The account lookup returns the **names from the last NIN check** as the account holder,
so the "is this your account" check passes on the happy path.

### Card holder

For linking a card issued at a branch (not a Stanbic customer). The API checks the card
belongs to the user by NIN (ID value) against their KYC document number, or else by name.
Set the **Card holder** fields to your test user's KYC names, or NIN.

## 3. Walk-throughs

You need a test user with a KYC record and a successful card payment (that creates the
card issuance request).

- **Happy path, Stanbic customer:** leave everything on the default. Choose Stanbic customer → details (any NIN, account `1203247565`) → confirm → address → link card → issued.
- **Wrong account:** set *Account lookup* to *Active, but someone else's name*. Confirm fails with "does not belong to you", so update the details.
- **Registration fails, then retry:** set *Card instant registration* to *Registration failed*, link the card (the status becomes `failed`), set it back to the happy path and retry.
- **Not a Stanbic customer:** set the card holder to your user's name, choose not a Stanbic customer, and link a card ID such as `5555123`.
- **Slow Stanbic:** set a delay of 3000 ms on one endpoint to check the app's loading states.

## 4. Deploy it for free (Render)

Render's free web service runs this as is. Free services **sleep after 15 minutes without
traffic** and take about a minute to wake on the next request. Their disk isn't kept, so
**settings reset to the defaults (all happy paths) whenever it restarts or sleeps**. Use
Export/Import to keep them.

1. Put this folder in its own Git repo (private is fine) and push it to GitHub or GitLab.
   `config.json` is in `.gitignore`, so the deployed mock starts on the defaults.
2. In Render: **New → Blueprint**, pick the repo. It reads `render.yaml` and creates a free
   web service called `stanbic-mock`. (Or **New → Web Service**: runtime Node, build command
   `true`, start command `node server.js`, plan Free.)
3. **The settings page is password protected** on Render. `render.yaml` generates a random
   `MOCK_ADMIN_TOKEN`, which you'll find under the service's **Environment** tab. The browser
   asks for a username (anything) and password (the token). The Stanbic endpoints stay open
   so the API can call them.
4. Your mock is at `https://stanbic-mock-xxxx.onrender.com`, and the settings page is at `/__mock`.

**Point an API at it:**
```bash
STANBIC_SERVER_URL=https://stanbic-mock-xxxx.onrender.com bin/rails s
```

Things to know:
- **First request after sleeping** takes up to a minute and may hit the API's request
  timeout. Open `/__mock/health` in a browser first to wake it.
- `StanbicBankServices::Config` **ignores `STANBIC_SERVER_URL` when `RAILS_ENV=production`**.
  If staging runs as `production`, it keeps using the real Stanbic. Change that check
  deliberately if you want staging on the mock.
- It's a public URL. Only ever send test data to it.

## 5. Known API gaps the mock exposes

Real behaviour in `self-card-onboarding-v2`, not mock bugs:

- **A NIN that doesn't match isn't blocked.** With *Details don't match*, the API still moves to
  verification review. Confirmation only compares the account holder with the names the user typed.
- **A non-JSON NIN response counts as success.** Try *Non-JSON response (200)*.
- **The admin NIN section** reads `ninMatch`-style fields that NIRA's response doesn't have, so its badges stay empty.
- **The registration postal code is always empty.** `CardRegistrationPayloadBuilder#postal_code`
  reads `data.customer_id`, which the account lookup response doesn't have.

## Settings file

Local settings are saved to `config.json` next to `server.js` (created on the first change).
Delete it to start from the defaults. An older `config.json` is converted automatically.

Environment variables: `PORT` (default 4010), `MOCK_ADMIN_TOKEN` (password for the settings
page; none locally), `MOCK_CONFIG_PATH` (where settings are saved).
# stanbic_moc
