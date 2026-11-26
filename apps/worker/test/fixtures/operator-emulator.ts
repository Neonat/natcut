import { Firestore } from 'firebase-admin/firestore';

export function operatorEmulator() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) throw Error('Operator tests require a loopback emulator');
  return new Firestore({ projectId: 'demo-natcut', databaseId: 'operator-tests', host, ssl: false });
}
