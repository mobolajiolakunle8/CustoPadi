# CustoPadi deployment

## 1. Publish the Realtime Database rules

Firebase Console → Realtime Database → Rules → replace everything with the contents of
`database.rules.json` → **Publish**. Or deploy with the CLI (step 3).

The rules must include the fixed `pushPreferences` section. Older rules used
`numChildren`, which Realtime Database rules do not support.

## 2. Deploy the website

Upload **all** of these to Vercel (same folder):

- `index.html`
- `sw.js`
- `database.rules.json`
- `manifest.webmanifest`
- `icon.svg`, `icon-192.png`, `icon-512.png`
- `logo.png` (optional)

Confirm the sign-in footer reads `CP-GROW-3` after a hard refresh.

## 3. Deploy the secure server functions (needed for WhatsApp verification)

WhatsApp verification, Paystack links, daily backups and referral rewards run as
Firebase Cloud Functions. They are **not** part of the static website, so they must
be deployed separately. This needs the **Blaze (pay-as-you-go) plan**.

```bash
npm install -g firebase-tools
firebase login
# run inside the folder that contains firebase.json and functions/
firebase use custopadi
npm install --prefix functions
```

Create the secrets (paste each value when prompted):

```bash
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_VERIFY_SERVICE_SID
firebase functions:secrets:set PAYSTACK_SECRET_KEY
```

Deploy everything:

```bash
firebase deploy --only functions,database --project custopadi
```

Functions deploy to `europe-west1`. The browser is already configured for that region.

Check the deployment:

```bash
firebase functions:list --project custopadi
```

You should see `sendWhatsAppCode`, `whatsappStatus`, `createPhoneBusiness`,
`resetPhonePassword`, `initializePaystackPayment`, `paystackWebhook`,
`custopadiDailyBackup`, `listBackups`, `restoreBackup` and `claimReferralReward`.

## 4. Twilio Verify with the WhatsApp channel

1. Create a Twilio account and a **Verify Service**; copy its `VA…` SID into
   `TWILIO_VERIFY_SERVICE_SID`.
2. Add your Account SID and Auth Token secrets.
3. Twilio Verify WhatsApp requires **your own approved WhatsApp Business sender**
   (WhatsApp Business Account + phone number). Attach it to the Verify Service.
4. WhatsApp OTPs are billed per verification by Twilio. Twilio's shared sender is
   not available for this channel.

Until these steps are done the app deliberately **does not block sign-up**: the
account is created and the number is shown as **not verified** in Business settings,
where it can be verified later once the service is live.

## 5. Paystack payment links (optional)

1. Add `PAYSTACK_SECRET_KEY` as a secret (test key first).
2. In Paystack, set the webhook URL to the deployed `paystackWebhook` URL shown by
   `firebase functions:list` (it looks like
   `https://europe-west1-custopadi.cloudfunctions.net/paystackWebhook`).
3. Only NGN sales with an outstanding balance can create a link. The webhook
   verifies the signature, amount and currency before recording the payment.

## 6. Daily backups

`custopadiDailyBackup` runs at **02:00 Africa/Lagos** and keeps **7 daily snapshots**
per business under `rollingBackups/{uid}`. Owners can restore from
Business settings → Daily backups.

## 7. Referral reward

Each business referred by a valid link grants **30 bonus days** to both sides once the
referred owner claims it from Business settings → Invite a business. The reward is
stored in `businesses/{uid}/premiumUntil`.

## 8. Final checks

1. Sign in → Team & workspaces → **Check the rules now**: all green ticks.
2. Business settings → **Verify this WhatsApp number** should say verification is ready
   once Twilio is configured.
3. Log a credit sale → **Payment link** appears for NGN balances.
4. Business settings → **Recently deleted** restores a deleted customer.
5. Deploy a new version and confirm phones receive `CP-GROW-3`.
