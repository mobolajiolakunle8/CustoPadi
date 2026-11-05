// CustoPadi privileged services. Provider secrets live in Firebase Secret Manager only.
const crypto = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');

if (!getApps().length) initializeApp({ databaseURL: 'https://custopadi-default-rtdb.firebaseio.com' });
const auth = getAuth();
const db = getDatabase();
const TWILIO_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_VERIFY = defineSecret('TWILIO_VERIFY_SERVICE_SID');
const PAYSTACK_KEY = defineSecret('PAYSTACK_SECRET_KEY');
const PHONE_SUFFIX = '@phone.custopadi.app';
const phoneAlias = phone => phone + PHONE_SUFFIX;
const validPhone = value => /^[1-9][0-9]{6,14}$/.test(String(value || ''));
const safeKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fail = (code, message) => { throw new HttpsError(code, message); };
const OTP = { region: 'europe-west1', cors: true, secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_VERIFY] };
const PAY = { region: 'europe-west1', cors: true, secrets: [PAYSTACK_KEY] };

async function twilioVerify(path, fields) {
  if (!TWILIO_SID.value() || !TWILIO_TOKEN.value() || !TWILIO_VERIFY.value()) fail('failed-precondition', 'WhatsApp verification has not been configured by the app owner.');
  const url = 'https://verify.twilio.com/v2/Services/' + encodeURIComponent(TWILIO_VERIFY.value()) + path;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(TWILIO_SID.value() + ':' + TWILIO_TOKEN.value()).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(fields)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Twilio Verify error:', response.status, result.code || 'unknown');
    if ([20404, 60200].includes(result.code)) fail('not-found', 'This WhatsApp code expired. Request a new code.');
    if ([60202, 60203].includes(result.code)) fail('resource-exhausted', 'Too many code attempts. Wait before trying again.');
    fail('unavailable', 'WhatsApp could not send or check that code. Confirm the Twilio WhatsApp sender is active.');
  }
  return result;
}
async function verifyCode(phone, code) {
  if (!validPhone(phone) || !/^\d{4,10}$/.test(String(code || '').trim())) fail('invalid-argument', 'Enter your full WhatsApp number and the code you received.');
  const result = await twilioVerify('/VerificationCheck', { To: 'whatsapp:+' + phone, Code: String(code).trim() });
  if (result.status !== 'approved') fail('permission-denied', 'The WhatsApp code is incorrect or expired. Request a new code.');
}
async function limitOtp(phone, request) {
  const key = crypto.createHash('sha256').update(phone + ':' + (request.rawRequest?.ip || 'unknown')).digest('hex');
  const ref = db.ref('privateSecurity/whatsappOtp/' + key), now = Date.now();
  const result = await ref.transaction(old => {
    const times = Array.isArray(old?.times) ? old.times.filter(t => now - t < 60 * 60 * 1000) : [];
    if (times.length >= 3) return;
    times.push(now); return { times };
  }, undefined, false);
  if (!result.committed) fail('resource-exhausted', 'For your safety, wait an hour before requesting another WhatsApp code.');
}

exports.sendWhatsAppCode = onCall(OTP, async request => {
  const phone = String(request.data?.phone || '').replace(/\D/g, '');
  if (!validPhone(phone)) fail('invalid-argument', 'Enter the full WhatsApp number with its country code.');
  await limitOtp(phone, request);
  const response = await twilioVerify('/Verifications', { To: 'whatsapp:+' + phone, Channel: 'whatsapp' });
  if (response.status !== 'pending') fail('unavailable', 'WhatsApp did not accept the verification request. Try again.');
  return { sent: true, expiresInSeconds: 600 };
});

exports.verifyWhatsAppCode = onCall(OTP, async request => {
  const phone = String(request.data?.phone || '').replace(/\D/g, '');
  await verifyCode(phone, request.data?.code);
  return { verified: true };
});

// Lets the browser distinguish "functions not deployed" from "Twilio not configured".
exports.whatsappStatus = onCall({ region: 'europe-west1', cors: true, secrets: [TWILIO_SID, TWILIO_TOKEN, TWILIO_VERIFY] }, async () => ({
  configured: Boolean(TWILIO_SID.value() && TWILIO_TOKEN.value() && TWILIO_VERIFY.value()),
  channel: 'whatsapp'
}));

exports.createPhoneBusiness = onCall(OTP, async request => {
  const data = request.data || {};
  const phone = String(data.phone || '').replace(/\D/g, '');
  const businessName = String(data.businessName || '').trim();
  const ownerName = String(data.ownerName || '').trim();
  const password = String(data.password || '');
  const types = ['Fashion & clothing','Food & drinks','Hair & beauty','Phones & gadgets','Provisions & groceries','Shoes & bags','Services','Other'];
  if (!validPhone(phone) || businessName.length < 2 || businessName.length > 60 || ownerName.length < 2 || ownerName.length > 50 || password.length < 6 || !types.includes(data.businessType)) {
    fail('invalid-argument', 'Some business details are missing or invalid.');
  }
  // OTP verification and account creation happen together on the server, not in the browser.
  await verifyCode(phone, data.code);
  let user;
  try { user = await auth.createUser({ email: phoneAlias(phone), password, displayName: ownerName }); }
  catch (err) {
    if (err.code === 'auth/email-already-exists') fail('already-exists', 'This WhatsApp number already has an account. Log in with its number and password.');
    throw err;
  }
  const profile = {
    businessName, ownerName, phone, phoneVerified: true, businessType, email: '', createdAt: new Date().toISOString().slice(0, 10),
    authProvider: 'phone-password', templates: [], settings: { followUpDays: 30, smartFollowUp: false, currency: 'NGN', messageLanguage: 'en', reminderTime: '09:00' },
    groups: [], messageOverrides: {}, progress: { customer: false, sale: false, sent: false }, onboardingDone: false, sentCount: 0
  };
  try { await db.ref('businesses/' + user.uid).set(profile); }
  catch (err) {
    try { await auth.deleteUser(user.uid); } catch (cleanup) { console.error('Auth cleanup failed:', cleanup.code || 'unknown'); }
    console.error('Initial business save failed:', err.code || 'unknown');
    fail('internal', 'WhatsApp was verified but your business could not be saved. Please try signing in.');
  }
  return { created: true };
});

exports.resetPhonePassword = onCall(OTP, async request => {
  const phone = String(request.data?.phone || '').replace(/\D/g, ''), password = String(request.data?.newPassword || '');
  if (!validPhone(phone) || password.length < 6) fail('invalid-argument', 'Enter a valid WhatsApp number and a password of at least 6 characters.');
  await verifyCode(phone, request.data?.code);
  let user;
  try { user = await auth.getUserByEmail(phoneAlias(phone)); }
  catch (err) { if (err.code === 'auth/user-not-found') fail('not-found', 'No CustoPadi account is registered with that WhatsApp number.'); throw err; }
  await auth.updateUser(user.uid, { password });
  return { reset: true };
});

// Change a customer password from inside Business settings using an already verified Firebase session.
exports.updatePhoneLogin = onCall({ region: 'europe-west1' }, async request => {
  if (!request.auth || !request.auth.token.email) fail('unauthenticated', 'Log in again, then retry.');
  const password = String(request.data?.password || '');
  if (password.length < 6) fail('invalid-argument', 'Use at least 6 characters.');
  await auth.updateUser(request.auth.uid, { password });
  return { updated: true };
});

exports.initializePaystackPayment = onCall(PAY, async request => {
  if (!request.auth) fail('unauthenticated', 'Sign in before creating a payment link.');
  const { saleId, payerEmail } = request.data || {};
  if (!safeKey(saleId) || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(payerEmail || ''))) fail('invalid-argument', 'Enter the sale and a valid customer email.');
  const owner = request.auth.uid;
  if (!(await db.ref('businesses/' + owner).get()).exists()) fail('permission-denied', 'Only the business owner can create payment links.');
  const sale = (await db.ref('sales/' + owner + '/' + saleId).get()).val();
  if (!sale || sale.currency !== 'NGN') fail('failed-precondition', 'Payment links currently support Nigerian naira sales only.');
  const paid = Number(sale.paid || 0) + Object.values(sale.payments || {}).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const amount = Math.round((Number(sale.amount) - paid) * 100);
  if (amount <= 0) fail('failed-precondition', 'This sale has no outstanding balance.');
  const secret = PAYSTACK_KEY.value(); if (!secret) fail('failed-precondition', 'Paystack is not configured by the app owner.');
  const reference = 'CP_' + owner.slice(0, 12) + '_' + saleId.slice(0, 24) + '_' + crypto.randomBytes(6).toString('hex');
  const response = await fetch('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: payerEmail, amount, currency: 'NGN', reference, callback_url: 'https://custopadi.vercel.app/', metadata: { owner, saleId, customerId: sale.customerId, app: 'CustoPadi' } }) });
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
  const date = String(request.data?.date || ''); if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) fail('invalid-argument', 'Select a valid backup date.');
  const uid = request.auth.uid, backup = (await db.ref('rollingBackups/' + uid + '/' + date).get()).val();
  if (!backup) fail('not-found', 'That backup is not available.');
  const patch = { ['businesses/' + uid]: backup.business, ['sales/' + uid]: backup.sales || {}, ['staffDirectory/' + uid]: Object.fromEntries(Object.entries(backup.business.customers || {}).map(([id, c]) => [id, { name: c.name || '', phone: c.phone || '' }])) };
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