# LAN Demo Mode Design

## Intent

Let the booth operator run NatCut on the MacBook and open the visitor flow from a phone on the same Wi-Fi by scanning a QR code. This is a rehearsal tool, not the production DevFest deployment.

## Goals

- Keep the existing `npm run dev` loopback-only behavior unchanged.
- Add `npm run dev:lan` that detects a private IPv4 address and prints a terminal QR code for the visitor URL.
- Expose the visitor app on port `4174`, submission API on `8088`, and Auth emulator on `9099` to the LAN.
- Keep simulator/operator control port `8090` and the Firestore emulator on `127.0.0.1`.
- Restrict submission API CORS to the detected visitor origin.
- Continue using only Firebase project `demo-natcut` and local emulators.
- Fail clearly when no suitable LAN address exists.

## Non-goals

- A branded or public HTTPS URL.
- Conference-network reliability, tunnelling, DNS, or Bonjour.
- Production Firebase access.
- Printer access or any physical print command.

## Approaches considered

1. **Dedicated LAN command — selected.** `npm run dev:lan` opts into LAN exposure while normal development remains private. This makes the safety boundary obvious and keeps operator controls local.
2. **Always expose normal development.** Less code, but unnecessarily exposes emulators and APIs whenever the project runs.
3. **Use `natcut.local` or a public tunnel.** A local hostname is less reliable across Wi-Fi networks; a public tunnel expands scope and is not needed for same-network rehearsal.

## Runtime behavior

LAN mode selects a non-loopback private IPv4 address from active network interfaces. It starts the Auth emulator on all interfaces, while the Firestore emulator remains loopback-only. The Mac runtime continues to connect to both emulators through `127.0.0.1`; only the browser-facing Auth endpoint uses the LAN address. Vite and the submission API listen on all interfaces. The control server remains bound to loopback.

The terminal prints the visitor URL and a QR code. If the Mac changes networks, LAN mode must be restarted so the generated origin and QR code remain correct. The phone and Mac must share a network that permits device-to-device traffic; macOS may request permission for Node to accept incoming connections.

## Security boundary

LAN mode is explicit and demo-only. It must never select a production Firebase project, widen the operator control listener, or introduce printer mutation commands.
