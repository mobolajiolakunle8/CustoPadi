import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, get, set, update, remove, serverTimestamp } from 'firebase/database';

// These tests refuse to run against a live Firebase project.
const emulatorHost = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '';
assert.ok(['127.0.0.1:9000', 'localhost:9000'].includes(emulatorHost), 'Start the local Realtime Database emulator on port 9000 first.');
const rules = await readFile(new URL('../database.rules.json', import.meta.url), 'utf8');
const projectId = 'demo-custopadi-rules';
const owner = 'owner_a', member = 'staff_a', outsider = 'other_a';
const token = 'a'.repeat(48);
let env;
const client = uid => env.authenticatedContext(uid).database();
const guest = () => env.unauthenticatedContext().database();

function invitation(id = owner) {
  return { owner: id, businessName: 'Ada Fabrics', label: 'Ada assistant', createdAt: serverTimestamp(), expiresAt: Date.now() + 86400000 };
}
function creationPatch(code = token) {
  return {
    ['staffInfo/' + owner]: { businessName: 'Ada Fabrics', currency: 'NGN' },
    ['staffDirectory/' + owner]: { c1: { name: 'Amina Bello', phone: '2348031234567' } },
    ['staffInvites/' + code]: invitation()
  };
}
function acceptancePatch(code = token, staff = member, business = owner) {
  return {
    ['staffInvites/' + code + '/claimedBy']: staff,
    ['staffMembers/' + business + '/' + staff]: { role: 'sales', name: 'Assistant', invite: code, joinedAt: serverTimestamp() },
    ['workspaces/' + staff + '/' + business]: { name: 'Ada Fabrics', role: 'sales', invite: code }
  };
}
async function issue(code = token) { await assertSucceeds(update(ref(client(owner)), creationPatch(code))); }
async function accept(code = token, staff = member) { await assertSucceeds(update(ref(client(staff)), acceptancePatch(code, staff))); }

before(async () => {
  // Loading the full file into the emulator compiles every rule, not just invitation rules.
  env = await initializeTestEnvironment({ projectId, database: { host: '127.0.0.1', port: 9000, rules } });
}, { timeout: 60000 });
beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(context => set(ref(context.database()), {
    businesses: { [owner]: { businessName: 'Ada Fabrics', ownerName: 'Ada Obi', customers: { c1: { name: 'Amina', phone: '2348031234567', notes: 'Owner-only note' } } } }
  }));
});
after(async () => { if (env) await env.cleanup(); });

test('rules file is JSON and no longer uses unsupported numChildren', () => {
  assert.ok(JSON.parse(rules).rules.staffInvites);
  assert.equal(rules.includes('.numChildren('), false);
});

test('owner atomically creates directory, info and invitation', async () => {
  await issue();
  const snapshot = await assertSucceeds(get(ref(client(owner), 'staffInvites/' + token)));
  assert.equal(snapshot.val().owner, owner);
  assert.equal(typeof snapshot.val().createdAt, 'number');
});

test('signed-out users cannot create invitations', async () => {
  await assertFails(update(ref(guest()), creationPatch()));
});

test('another user cannot create an invitation for the owner', async () => {
  await assertFails(set(ref(client(outsider), 'staffInvites/' + token), invitation()));
});

test('a business profile must exist before creating its invitation', async () => {
  await assertFails(set(ref(client(outsider), 'staffInvites/' + token), invitation(outsider)));
});

test('invalid staff directory phone rejects the entire creation update', async () => {
  const patch = creationPatch();
  patch['staffDirectory/' + owner].c1.phone = 'not-a-number';
  await assertFails(update(ref(client(owner)), patch));
  assert.equal((await get(ref(client(owner), 'staffInvites/' + token))).exists(), false);
  assert.equal((await get(ref(client(owner), 'staffInfo/' + owner))).exists(), false);
});

test('empty names, unsupported fields and invalid tokens are rejected', async () => {
  await assertFails(set(ref(client(owner), 'staffInvites/' + token), { ...invitation(), label: '' }));
  await assertFails(set(ref(client(owner), 'staffInvites/' + token), { ...invitation(), admin: true }));
  await assertFails(set(ref(client(owner), 'staffInvites/not-secure'), invitation()));
});

test('expired or excessively long new invitations are rejected', async () => {
  await assertFails(set(ref(client(owner), 'staffInvites/' + token), { ...invitation(), expiresAt: Date.now() - 1000 }));
  await assertFails(set(ref(client(owner), 'staffInvites/' + token), { ...invitation(), expiresAt: Date.now() + 7 * 86400000 }));
});

test('invitation owner and dates are immutable after creation', async () => {
  await issue();
  await assertFails(update(ref(client(owner), 'staffInvites/' + token), { owner: outsider }));
  await assertFails(update(ref(client(owner), 'staffInvites/' + token), { expiresAt: Date.now() + 2 * 86400000 }));
});

test('known invite can be read while signed in but invitations cannot be listed', async () => {
  await issue();
  await assertSucceeds(get(ref(client(member), 'staffInvites/' + token)));
  await assertFails(get(ref(client(member), 'staffInvites')));
  await assertFails(get(ref(guest(), 'staffInvites/' + token)));
});

test('three-path acceptance succeeds and produces the expected membership', async () => {
  await issue(); await accept();
  const membership = await assertSucceeds(get(ref(client(member), 'staffMembers/' + owner + '/' + member)));
  assert.equal(membership.val().role, 'sales');
  assert.equal((await get(ref(client(owner), 'staffInvites/' + token + '/claimedBy'))).val(), member);
  await assertSucceeds(get(ref(client(member), 'workspaces/' + member)));
});

test('claim-only and membership-only writes cannot consume or use an invitation', async () => {
  await issue();
  await assertFails(set(ref(client(member), 'staffInvites/' + token + '/claimedBy'), member));
  const patch = acceptancePatch(); delete patch['workspaces/' + member + '/' + owner];
  await assertFails(update(ref(client(member)), patch));
  assert.equal((await get(ref(client(owner), 'staffInvites/' + token + '/claimedBy'))).exists(), false);
});

test('invented invitations and role escalation are denied', async () => {
  await assertFails(update(ref(client(member)), acceptancePatch()));
  await issue();
  const patch = acceptancePatch(); patch['staffMembers/' + owner + '/' + member].role = 'owner';
  await assertFails(update(ref(client(member)), patch));
});

test('owner cannot accept their own invitation as staff', async () => {
  await issue();
  await assertFails(update(ref(client(owner)), acceptancePatch(token, owner)));
});

test('expired invitations cannot be accepted', async () => {
  await issue();
  await env.withSecurityRulesDisabled(context => update(ref(context.database(), 'staffInvites/' + token), { expiresAt: Date.now() - 10000 }));
  await assertFails(update(ref(client(member)), acceptancePatch()));
});

test('only one member can use an invitation', async () => {
  await issue(); await accept();
  await assertFails(update(ref(client(outsider)), acceptancePatch(token, outsider)));
});

test('two simultaneous claims cannot both succeed', async () => {
  await issue();
  const outcomes = await Promise.allSettled([
    update(ref(client(member)), acceptancePatch(token, member)),
    update(ref(client(outsider)), acceptancePatch(token, outsider))
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  const winner = (await get(ref(client(owner), 'staffInvites/' + token + '/claimedBy'))).val();
  assert.ok([member, outsider].includes(winner));
});

test('expired or used invitation cannot be repurposed for a different business', async () => {
  await issue();
  await assertFails(update(ref(client(member)), acceptancePatch(token, member, outsider)));
});

test('sales staff can read only the shared contact directory and business info', async () => {
  await issue(); await accept();
  await assertSucceeds(get(ref(client(member), 'staffDirectory/' + owner)));
  await assertSucceeds(get(ref(client(member), 'staffInfo/' + owner)));
  await assertFails(get(ref(client(member), 'businesses/' + owner)));
  await assertFails(get(ref(client(member), 'businesses/' + owner + '/customers/c1')));
  await assertFails(get(ref(client(member), 'sales/' + owner)));
  await assertFails(set(ref(client(member), 'businesses/' + owner + '/businessName'), 'Changed'));
  await assertFails(set(ref(client(member), 'staffDirectory/' + owner + '/c2'), { name: 'Not allowed', phone: '2348031234567' }));
  await assertFails(update(ref(client(member), 'staffMembers/' + owner + '/' + member), { role: 'owner' }));
});

test('sales staff can add a valid sale, but cannot edit or delete it', async () => {
  await issue(); await accept();
  const sale = { id: 's1', customerId: 'c1', item: 'Ankara', amount: 1000, paid: 500, date: '2026-01-01', currency: 'NGN', createdBy: member, createdAt: serverTimestamp() };
  await assertSucceeds(set(ref(client(member), 'sales/' + owner + '/s1'), sale));
  await assertFails(update(ref(client(member), 'sales/' + owner + '/s1'), { amount: 1 }));
  await assertFails(remove(ref(client(member), 'sales/' + owner + '/s1')));
  await assertFails(set(ref(client(member), 'sales/' + owner + '/s2'), { ...sale, id: 's2', paid: 1500 }));
});

test('revoked members lose access and cannot reuse their old invitation', async () => {
  await issue(); await accept();
  await assertSucceeds(update(ref(client(owner)), {
    ['staffMembers/' + owner + '/' + member]: null,
    ['workspaces/' + member + '/' + owner]: null
  }));
  await assertFails(get(ref(client(member), 'staffDirectory/' + owner)));
  await assertFails(update(ref(client(member)), acceptancePatch()));
});

test('owner can cancel an invitation; others cannot cancel it', async () => {
  await issue();
  await assertFails(remove(ref(client(outsider), 'staffInvites/' + token)));
  await assertSucceeds(remove(ref(client(owner), 'staffInvites/' + token)));
  await assertFails(update(ref(client(member)), acceptancePatch()));
});

test('push preference schema compiles and accepts one correctly keyed device', async () => {
  await assertSucceeds(set(ref(client(owner), 'pushPreferences/' + owner), {
    enabled: true, time: '09:00', timeZone: 'Africa/Lagos',
    tokens: { ['b'.repeat(64)]: { token: 'test-device-token', updatedAt: serverTimestamp() } }
  }));
  await assertFails(set(ref(client(outsider), 'pushPreferences/' + owner + '/enabled'), false));
});