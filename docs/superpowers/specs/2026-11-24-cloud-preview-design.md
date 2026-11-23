# Isolated Cloud Preview Design

## Intent

Publish a working NatCut visitor preview at a presentable Firebase Hosting URL while preserving all existing Sprout applications, Hosting content, Firestore databases, rules, collections, Storage objects, and functions.

## Resource isolation

NatCut uses new resources inside Google Cloud project `sprout-dev-66f08`:

- Firebase Hosting site ID `natcut`, if globally available, producing `https://natcut.web.app`.
- Firebase web app named `natcut` attached to that Hosting site.
- Firestore Standard database ID `natcut` in `asia-southeast1`.
- Cloud Run service `natcut-submission` in `asia-southeast1`.
- Dedicated runtime service accounts and a dedicated status-token secret.

No command may deploy Firestore rules or indexes to the existing `(default)` or AI Studio databases. No existing Hosting site, release, Firebase app, Cloud Run service, function, database, collection, bucket, or secret may be modified or deleted.

## Request path

The visitor opens Firebase Hosting over HTTPS. Static assets are served from the NatCut Hosting site. `/api/**` requests are rewritten to the Cloud Run submission service. The API verifies anonymous Firebase Auth tokens, recalculates the trusted raster and cut geometry, and stores accepted submissions in the named `natcut` Firestore database.

The Mac worker connects outbound to the named database. For the cloud-preview milestone it may run the existing simulator; real printer execution remains out of scope and retains the existing fail-closed boundary.

## Authentication and security

- Anonymous Firebase Authentication is enabled for the project if not already enabled.
- The browser receives only the public Firebase web configuration.
- Cloud Run uses a dedicated service account with the minimum roles required for the NatCut database and secret.
- The API status-token secret lives in Secret Manager, never source control or Hosting configuration.
- Firestore is server-only for NatCut; visitors cannot write queue records directly.
- Hosting and Cloud Run deployments target explicit resource names.

## Cost controls

Cloud Run scales to zero with zero minimum instances and a bounded maximum instance count. The named Firestore database is not eligible for the project's single free database, so its small rehearsal workload is billable. Set a project budget alert before broader testing. AI generation is not part of this deployment and cannot consume AI Studio credits.

## Naming fallback

Firebase Hosting site IDs are globally unique and cannot be renamed. Attempt to create `natcut` exactly once. If unavailable, stop before creating another site and ask the owner to choose a fallback.

## Non-goals

- Custom domain setup.
- Marketing survey, selfie storage, or AI generation.
- Real printer job mutation.
- Migrating or combining historical Sprout data.
- Editing existing Firestore rules.

## Approaches considered

1. **Firebase Hosting + Cloud Run + named Firestore database — selected.** Matches NatCut's Node 24 Fastify API, creates a public HTTPS path, and gives the strongest separation from existing Sprout data.
2. **Firebase Hosting + Cloud Functions.** Deployable with the existing Firebase CLI, but Firebase-managed Functions currently targets Node 22 while NatCut is pinned to Node 24.
3. **Hosting-only with direct browser Firestore writes.** Rejected because it bypasses trusted render/geometry validation and would let clients manufacture queue records.
4. **Hosting frontend calling the Mac.** Rejected because public HTTPS cannot reliably or safely reach a private HTTP service on the booth Mac.
