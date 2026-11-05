// CustoPadi cloud functions: Paystack payments, daily backups, and referral rewards.
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');

if (!getApps().length) initializeApp({ databaseURL: 'https://custopadi-default-rtdb.firebaseio.com' });
const auth = getAuth();
const db = getDatabase();
const PAYSTACK_KEY = defineSecret('PAYSTACK_SECRET_KEY');
const safeKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = (code, message) => { throw new HttpsError(code, message); };
const PAY = { region: 'europe-west1', cors: true, secrets: [PAYSTACK_KEY] };

exports.initializePaystackPayment = onCall(PAY, async request => {
  if (!request.auth) fail('unauthenticated', 'Sign in before creating a payment link.');
  const { saleId, payerEmail } = request.data || {};
  if (!safeKey(saleId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payerEmail || ''))) fail('invalid-argument', 'Enter the sale and a valid customer email.');
  const owner = request.auth.uid;
  if (!(await db.ref('businesses/' + owner).get()).exists()) fail('permission-denied', 'Only the business owner can create payment links.');
  const sale = (await db.ref('sales/' + owner + '/' + saleId).get()).val();
  if (!sale || sale.currency !== 'NGN') fail('failed-precondition', 'Payment links currently support Nigerian naira sales only.');
  const paid = Number(sale.paid || 0) + Object.values(sale.payments || {}).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const amount = Math.round((Number(sale.amount) - paid) * 100);
  if (amount <= 0) fail('failed-precondition', 'This sale has no outstanding balance.');
  const secret = PAYSTACK_KEY.value(); if (!secret) fail('failed-precondition', 'Paystack is not configured by the app owner.');
  const reference = 'CP_' + owner.slice(0, 12) + '_' + saleId.slice(0, 24) + '_' + crypto.randomBytes(6).toString('hex');
  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: payerEmail, amount, currency: 'NGN', reference, callback_url: 'https://custopadi.vercel.app/', metadata: { owner, saleId, customerId: sale.customerId, app: 'CustoPadi' } })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.status || !result.data?.authorization_url) fail('unavailable', 'Paystack could not create the payment link. Check the merchant account.');
  await db.ref('paymentIntents/' + reference).set({ owner, saleId, customerId: sale.customerId, amount, currency: 'NGN', status: 'pending', createdAt: Date.now() });
  return { url: result.data.authorization_url, reference };
});

exports.paystackWebhook = onRequest({ region: 'europe-west1', secrets: [PAYSTACK_KEY] }, async (req, res) => {
  if (req.method !== 'POST') return res.sendStatus(405);
  const signature = req.get('x-paystack-signature') || '', expected = crypto.createHmac('sha512', PAYSTACK_KEY.value()).update(req.rawBody).digest('hex');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(401);
  const data = req.body?.data, reference = String(data?.reference || '');
  if (req.body?.event !== 'charge.success' || !reference || data.status !== 'success') return res.sendStatus(200);
  try {
    const intentRef = db.ref('paymentIntents/' + reference), intent = (await intentRef.get()).val();
    if (!intent || intent.status === 'paid' || data.currency !== intent.currency || Number(data.amount) !== intent.amount) return res.sendStatus(200);
    const saleRef = db.ref('sales/' + intent.owner + '/' + intent.saleId), paymentId = 'paystack_' + crypto.createHash('sha256').update(reference).digest('hex').slice(0, 28);
    const tx = await saleRef.transaction(sale => {
      if (!sale || sale.customerId !== intent.customerId) return;
      const payments = sale.payments || {}; if (payments[paymentId]) return sale;
      const paid = Number(sale.paid || 0) + Object.values(payments).reduce((sum, p) => sum + Number(p.amount || 0), 0), received = intent.amount / 100;
      if (received > Number(sale.amount) - paid + 0.001) return;
      payments[paymentId] = { amount: received, date: new Date().toISOString().slice(0, 10), by: 'paystack', reference, recordedAt: Date.now() };
      return { ...sale, payments };
    }, undefined, false);
    if (tx.committed || tx.snapshot.child('payments').child(paymentId).exists()) await intentRef.update({ status: 'paid', paidAt: Date.now(), transactionId: Number(data.id) || 0 });
    return res.sendStatus(200);
  } catch (err) { console.error('Paystack webhook failed:', err.code || 'unknown'); return res.sendStatus(500); }
});

exports.custopadiDailyBackup = onSchedule({ schedule: 'every day 02:00', timeZone: 'Africa/Lagos', region: 'europe-west1', timeoutSeconds: 540, maxInstances: 1 }, async () => {
  const businesses = (await db.ref('businesses').get()).val() || {}, allSales = (await db.ref('sales').get()).val() || {};
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  for (const [uid, business] of Object.entries(businesses)) {
    try {
      const ref = db.ref('rollingBackups/' + uid), old = (await ref.get()).val() || {};
      const snapshots = { ...old, [date]: { createdAt: Date.now(), business, sales: allSales[uid] || {} } };
      Object.keys(snapshots).sort().slice(0, Math.max(0, Object.keys(snapshots).length - 7)).forEach(key => delete snapshots[key]);
      await ref.set(snapshots);
    } catch (err) { console.error('Daily backup failed:', err.code || 'unknown'); }
  }
});

exports.listBackups = onCall({ region: 'europe-west1' }, async request => {
  if (!request.auth) fail('unauthenticated', 'Sign in first.');
  const data = (await db.ref('rollingBackups/' + request.auth.uid).get()).val() || {};
  return Object.keys(data).sort().reverse().map(date => ({ date, createdAt: data[date].createdAt || 0, customerCount: Object.keys(data[date].business?.customers || {}).length }));
});

exports.restoreBackup = onCall({ region: 'europe-west1' }, async request => {
  if (!request.auth) fail('unauthenticated', 'Sign in first.');
  const date = String(request.data?.date || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('invalid-argument', 'Select a valid backup date.');
  const owner = request.auth.uid, backup = (await db.ref('rollingBackups/' + owner + '/' + date).get()).val();
  if (!backup) fail('not-found', 'That backup is no longer available.');
  const patch = { ['businesses/' + owner]: backup.business, ['sales/' + owner]: backup.sales || {}, ['staffDirectory/' + owner]: Object.fromEntries(Object.entries(backup.business.customers || {}).map(([id, c]) => [id, { name: c.name || '', phone: c.phone || '' }])) };
  await db.ref().update(patch); return { restored: true, date };
});

exports.claimReferralReward = onCall({ region: 'europe-west1' }, async request => {
  if (!request.auth) fail('unauthenticated', 'Sign in first.');
  const uid = request.auth.uid;
  const claim = (await db.ref('referralClaims/' + uid).get()).val();
  if (!claim || !safeKey(claim.owner) || claim.owner === uid) fail('not-found', 'No referral claim was recorded for this business.');
  if (claim.rewardedAt) return { claimed: false, alreadyClaimed: true };
  if (!(await db.ref('referralCodes/' + claim.owner).get()).exists()) fail('not-found', 'This referral is no longer active.');
  const patch = {};
  for (const id of [uid, claim.owner]) { const until = Number((await db.ref('businesses/' + id + '/premiumUntil').get()).val()) || 0; patch['businesses/' + id + '/premiumUntil'] = Math.max(Date.now(), until) + 30 * 86400000; }
  patch['referralClaims/' + uid + '/rewardedAt'] = Date.now();
  await db.ref().update(patch);
  return { claimed: true, daysAwarded: 30 };
});
