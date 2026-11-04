# Realtime Database Rules Verification

These tests compile and exercise the complete `database.rules.json` file against the local Firebase Realtime Database emulator. They do not connect to the live CustoPadi database.

## Run

Use Node.js 22+ and Java supported by your installed Firebase CLI. From the project root:

1. Run `npm install --no-save firebase @firebase/rules-unit-testing firebase-tools`.
2. Run `npx firebase emulators:exec --only database --project demo-custopadi-rules --config firebase.rules-test.json "node --test --test-concurrency=1 tests/database.rules.test.mjs"`.

The `demo-` project ID and explicit localhost guard prevent accidental production writes. Any compilation error fails test setup. The output from Node's test runner, not this document, is the evidence of a successful run.

## Covered

- Owner-only invitation creation, including one atomic directory/info/invitation update.
- Rejection of invalid contact data, empty staff names, unsupported fields and insecure token formats.
- Timestamp validation, invitation immutability and expiry.
- Signed-in access to a known invitation but no invitation listing.
- Atomic claim, member and workspace creation.
- Rejection of partial claims, forged owners, privilege escalation and reuse.
- Staff can read the contact directory, but not owner records or business totals.
- Staff may create a valid sale, but not change or remove an earlier sale.
- Removing staff access takes effect and prevents replay of the consumed invitation.
- Cancellation by the owner only.
- Push preference validation without unsupported snapshot methods.

## Status

The test suite is provided for reproducible verification. It has not been executed in the coding environment used to prepare this change, because no terminal or emulator runner is available there. Run it before publishing permissions for real staff.

## Publish

After the tests pass, replace the entire editor contents in Firebase Console > Realtime Database > Rules for `custopadi-default-rtdb` with the contents of `database.rules.json`, then publish. Do not paste these JSON rules into Firestore or Storage. Publishing rules does not upload the website files or change the stored records.

The owner may also use Business settings > Team & workspaces > View / copy Realtime Database rules to view or download the same full file.