# Booth plant catalog import

The eleven plants in the 28 November visual review gallery were imported as
one normal sticker and two phrase stickers each. The original drafts are in
`/Users/natsim/Documents/Codex/2026-11-27/natcut-completion-fencing/outputs`.
Run `scripts/prepare-approved-plants.py` with that directory and the existing
Prickly pear PNG to reproduce the sRGB-tagged input roster, then
`npm run sprites:import -- --input <roster.json>` to publish the hashed artwork.

The review PNGs had no embedded colour profile. This preparation explicitly
assigns sRGB to those pixels as a booth assumption. It removes the visual
cream backing and subthreshold debris, and adds a connected white paper
backing under each sticker so its outer alpha makes one cut silhouette.
White backing is invisible on white sticker paper. The colour origin of the
untagged drafts is **not proven** by this assignment. A physical registration
and colour check remains necessary before calling the sheets print approved.

The two approved brand designs are stored as tagged RGBA PNGs at native
500×170 and 500×210 aspect ratios. The catalog preserves the earlier
Prickly pear entry as an active fallback and archives older sprite identities.
