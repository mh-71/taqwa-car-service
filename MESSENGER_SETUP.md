# Facebook Messenger — setup guide

How to connect the **Taqwa Automobile** Facebook Page to the Social Inbox
(`pages/inbox-facebook.html`). The code is in place (migration `0014`,
`src/routes/messenger-webhook.js`, `src/routes/messenger.js`,
`src/lib/meta.js`); what remains is configuration in Meta and in Cloudflare.

Nothing below is done by the repository. Each step is something a person does
deliberately. **Never paste a token or secret into a chat, an issue, a commit or
a file in this repository.**

---

## What you will end up with

| Worker secret | Where it comes from | Used for |
|---|---|---|
| `META_APP_SECRET` | Meta app → App settings → Basic → App secret | Verifying that every webhook delivery really came from Meta |
| `META_WEBHOOK_VERIFY_TOKEN` | You invent it (a long random string) | The one-time webhook handshake |
| `META_PAGE_ACCESS_TOKEN` | Meta app → Messenger → Generate token (or a System User token) | Sending replies as the Page |
| `META_PAGE_ID` | The Page's numeric ID (Page → About → Page transparency, or shown next to the token) | Making sure only this Page's events are stored |

Webhook callback URL: **`https://app.taqwa.autos/api/webhooks/messenger`**

---

## 1. Before you start: deploy the code and migrate

1. Back up production D1, apply migration `0014_messenger.sql`, then deploy
   (the same order as `DEPLOYMENT.md`). The webhook must be live before Meta
   can verify it.
2. Until the secrets are set, the webhook answers **503** to Meta. That is
   deliberate: it fails closed rather than accepting unsigned events.

## 2. Create (or choose) the Meta app

1. Go to <https://developers.facebook.com/apps> and sign in with an account
   that is an **admin of the Taqwa Automobile Page**.
2. **Create app** → choose the use case for Messenger / "Engage with customers
   on Messenger from Meta" (on older dashboards: app type **Business**).
3. Connect it to the workshop's **Business portfolio** (Meta Business Manager)
   if asked. Business verification may be required later for App Review.

## 3. Add Messenger and connect the Page

1. In the app dashboard, add the **Messenger** product (Messenger API settings).
2. Under **Generate access tokens**, click **Connect** / **Add Page** and pick
   **Taqwa Automobile**. Grant the permissions it asks for.
3. Click **Generate** next to the Page and copy the token **straight into the
   secret command in step 6** — do not save it in a file or a message.

   A token generated here is tied to your personal admin account. For a token
   that does not expire when your password changes, create a **System User** in
   Business settings → Users → System users, give it the Page and the app, and
   generate a token with `pages_messaging` and `pages_manage_metadata`. That is
   the recommended production token.

## 4. Set the webhook

1. Make up a verify token, for example from PowerShell:

   ```powershell
   -join (1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
   ```

   Set it as a Worker secret first (step 6), then type the same value into Meta.
2. Messenger API settings → **Configure webhooks**:
   - Callback URL: `https://app.taqwa.autos/api/webhooks/messenger`
   - Verify token: the value from above
   - Click **Verify and save**. Meta calls `GET /api/webhooks/messenger`; the
     Worker answers with the challenge only when the token matches.
3. **Subscribe the Page** to these webhook fields:
   - `messages` — customer messages (required)
   - `messaging_postbacks` — button taps
   - `message_deliveries` — "Delivered"
   - `message_reads` — "Seen"
   - `message_echoes` — messages the Page sends, including from Meta Business Suite

## 5. Permissions

| Permission | Why |
|---|---|
| `pages_messaging` | Receive and send Messenger messages for the Page |
| `pages_manage_metadata` | Subscribe the Page to the webhook |
| `pages_show_list` | Pick the Page when generating the token |

The customer's name shown in the inbox comes from the Messenger User Profile
API, which works with `pages_messaging`. If Meta does not share it, the inbox
shows "Facebook user"; messages still arrive and replies still work.

## 6. Set the Cloudflare Worker secrets

Run these from the repository folder, **one at a time**. Each command asks for
the value at a prompt, so it never appears in your command history:

```powershell
npx wrangler secret put META_APP_SECRET --env production
```
```powershell
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN --env production
```
```powershell
npx wrangler secret put META_PAGE_ACCESS_TOKEN --env production
```
```powershell
npx wrangler secret put META_PAGE_ID --env production
```

Check that all four are present (names only; values are never shown):

```powershell
npx wrangler secret list --env production
```

Secrets take effect immediately; no redeploy is needed.

## 7. Development mode vs. live mode — what works when

| | Development mode (app not reviewed) | Live mode with Advanced Access |
|---|---|---|
| Who can message the Page and appear in the inbox | **Only people with a role on the app**: admins, developers, testers (App roles → Roles) | **Any customer** |
| Replies from Taqwa Autos | To those people only | To any customer, within the 24-hour window |
| What you need | Nothing more | **App Review** for `pages_messaging` (Advanced Access), usually business verification, a privacy policy URL, and a screencast of the inbox replying |

So you can test **end to end today** with your own account and any staff you
add as app testers: message the Page from those accounts, see the conversation
arrive, reply from the inbox. **Real customers' messages will not reach the
inbox until Meta approves Advanced Access** for `pages_messaging` and the app
is switched to **Live**.

## 8. Messaging rules this inbox follows

- Replies are sent only within **24 hours of the customer's last message**
  (Meta's standard messaging window), as `messaging_type: RESPONSE`.
- No message tags are used. Replying after 24 hours (for example with the
  `HUMAN_AGENT` tag, up to 7 days) needs separate Meta approval and is **not
  implemented**.
- There is no broadcast and no way to message someone who has not written first.

## 9. Testing it

1. Make sure your own Facebook account has a role on the app (step 7).
2. From that account, send a message to the Taqwa Automobile Page.
3. Open **Social Inbox → Facebook** in Taqwa Autos. The conversation appears
   within about 15 seconds (the page refreshes itself).
4. Reply. The bubble shows **Sending…**, then **Sent**, then **Delivered** /
   **Seen** when Messenger reports it. If Meta refuses, it shows **Not sent**
   with the reason and a **Retry**.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Verify and save" fails | `META_WEBHOOK_VERIFY_TOKEN` not set, or not the same value as typed in Meta |
| Messages never arrive | Page not subscribed to `messages`; app in development mode and the sender has no app role; `META_APP_SECRET` wrong (every delivery is refused with 401 — check `npx wrangler tail --env production`) |
| "Replies are not set up yet" in the inbox | `META_PAGE_ACCESS_TOKEN` or `META_PAGE_ID` not set |
| "The Facebook Page connection has expired…" | The Page token was revoked or expired; generate a new one (preferably a System User token) and set it again |
| "…more than 24 hours ago" | The messaging window is closed; the customer has to write again |
