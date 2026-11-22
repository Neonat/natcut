#!/usr/bin/env node

import { findByIds } from 'usb';

import { readPrinterSnapshot } from '../src/snapshot.mjs';
import { openUsbSession } from '../src/usb-session.mjs';

const asJson = process.argv.includes('--json');

try {
  const snapshot = await readPrinterSnapshot({
    openSession: () => openUsbSession({ usbModule: { findByIds } }),
  });
  if (asJson) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(`Printer: ${snapshot.identity.model} (${snapshot.identity.sku})`);
    console.log(`Firmware: ${snapshot.identity['firmware-revision']} · Hardware: ${snapshot.identity['hardware-revision']}`);
    console.log(`Status: ${snapshot.status.label} / ${snapshot.status.subLabel}`);
    console.log(`Alerts: ${snapshot.status.alerts.length ? snapshot.status.alerts.join(', ') : 'none'}`);
    console.log(`Active jobs: ${snapshot.activeJobs.length ? snapshot.activeJobs.join(', ') : 'none'}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
