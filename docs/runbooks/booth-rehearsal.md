# Rehearse the queue on the Mac

Start the local stack with `npm run dev`. Use two independent browser profiles at the [visitor editor](http://127.0.0.1:4174/edit) and open the [simulator desk](http://127.0.0.1:8090) on the Mac. The fixture art and simulated worker let you rehearse without a physical sticker.

1. Join the queue in each visitor profile. Note both ticket numbers and refresh the desk. The earlier ticket appears first.
2. Choose **Claim next** and refresh the first visitor’s ticket. It reads **You’re next** and the **Leave queue** action is disabled.
3. Choose **Start simulation**. Use **Refresh** on the desk to follow the worker phases. The visitor’s next refresh shows **Ready for pickup** when the simulation finishes.
4. Claim the next ticket. In the first ticket’s ready row, choose **Mark collected**. Refresh the first visitor’s ticket to see **Sticker collected**.
5. On the collected ticket, choose a 1–5 star rating and submit once without selecting product updates. The page changes to **Thanks for your feedback!**; no email or marketing lead is created.
6. For an opt-in rehearsal, use a fresh private browser session and ticket. Select **Email me Sprout product updates**, enter an address, and submit. The server normalizes the address and links one marketing lead to that session’s survey.
5. Choose **Start simulation** for the second ticket. Refresh each screen to check its status.

The desk lists the current event’s waiting and ready tickets in pages of 25 each. Each group has its own next-page button. The active ticket stays in view on every page. **First page** returns to the front of both groups.

## Worker interruption drill

Stop the local stack before running `npm run emulators:test -- --only worker`, which starts disposable emulators. The operator recovery test starts a separate desk process on a temporary loopback port and uses one temporary SQLite journal across three worker launches.

The drill claims a ticket, interrupts the worker, and recovers that claim on the next launch. It starts simulated execution, interrupts the worker after it enters an execution phase, and opens the desk again. The original queue number now shows **needs reconciliation** with a hold message. Claim, Start, and premature pickup cannot advance that ticket or the next visitor. A **failed** phase also holds the queue. Stop the rehearsal on either hold.

A full `npm run dev` restart begins a fresh emulator session and journal. The worker-only recovery drill keeps both in place.
