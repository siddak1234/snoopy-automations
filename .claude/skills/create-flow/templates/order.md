# <Flow name>: the merge and release order

The order the platform enforces: each step reads what the one before it published, so a step starts
only when the one before it is done. The session writes this list out for the owner at stage 6 and
fills it in as it goes — each pull request's link once its required check is green on the head, each
printed line as printed. The owner merges every pull request and says go, in manual permission mode,
for each step that publishes or touches production.
Section 10 empty: steps 3 to 5 only, the platform's pins unchanged in step 4.

0. **A client that is red for another reason** — an advisory failing its blocking audit — gets that
   fix as its own pull request before any lane; the client's lane branches from it and is rebased
   once it merges (Round 19's website `next` bump, #60).
1. **The backend pull request**: the contract, the platform and the round's records. The session
   pushes and opens it; while Actions is out of minutes, `node scripts/local-ci.mjs --pr <n>` posts
   the required check, `local/all-green`. The owner squash-merges it.
2. **The platform image**, from the squash-merge commit:
   ```bash
   node scripts/local-publish.mjs --commit <40-hex sha> --dry-run
   node scripts/local-publish.mjs --commit <40-hex sha>   # on the owner's go, manual mode
   ```
   It posts `local/publish` and prints the two pin lines for step 4 (SYSTEM-MANIFEST §12.1 #245).
   With Actions back, CI's publish job does this instead.
3. **The automations pull request.** First re-vendor its `contract/` from the backend's
   squash-merge commit, byte for byte, and cite that commit in
   `snoopy-automations/contract/README.md`: the lanes' contract commit is not on `main` after a
   squash (Round 19's `7a4baa6` merged as `2d93d99`). Then its gate; the owner merges; its CI's
   Publish job gives the image digest and the source commit.
4. **The registration pull request** in `snoopy-backend`, by the `pin-pr` skill's steps, with:
   ```bash
   node scripts/add-automation.mjs --template-id <id> --version <n> \
     --image ghcr.io/siddak1234/autom8x-<id>@sha256:<64 hex> \
     --source-commit <40-hex snoopy-automations sha> --manifest <path> --dry-run
   ```
   then the same without `--dry-run`, and the platform's pins from step 2. It does not write the
   lists a new flow moves (SYSTEM-MANIFEST §12.1 #294): `snoopy-backend/docs/MAP.md` (`npm run map`); the mounted
   list in `snoopy-backend/test/manifest-registry.test.ts`, the containers in `snoopy-backend/test/automation-containers.test.ts`,
   the manifest count and the served templates in `snoopy-backend/test/catalog-retirement.test.ts` (which versions
   a retirement leaves, the register job's answer compared sorted, the probed and offered templates);
   SYSTEM-MANIFEST §1.1a (its date and a dated block), §3.2, §10a and §14
   (`node scripts/run-tests.mjs --record`); `npm run records:facts`;
   `snoopy-backend/docs/repo-facts/snoopy-automations.json`. The new container's memory ceiling is its nearest
   measured precedent's, never the `56M` default — Candidate Reviewer took Invoice Processing v7's
   `88M`, the overlay's comment saying why and the declared total inside what a 2 GB host leaves
   (Round 19's registration, #240). `local/all-green` on the head; the owner merges.
5. **The release**, by the `release` skill: `npm run release -- --dry-run`, then `npm run release`,
   whose one line runs in manual mode on the owner's go (or the owner pastes it). While Actions is out
   of minutes the dry run refuses `ci`, `e2e` and the platform's digest artifact; the owner decides
   on `-- --override "<reason>"`, the reason naming the `local/all-green` head whose tree equals
   `main`'s (Round 19's FORTY-FIRST). Then
   `npm run release -- --read-back`, and the catalog's entry read back with what the flow declares.
6. **The clients' pull requests.** Each client's `Deployed contract` check is red by design until
   production serves the contract its types came from (Round 19, the app's lane): after step 5,
   re-run it. The owner merges the website's and the app's once their required checks are green on
   the head.
7. **TestFlight**: the app's build from its merged `main`, on the owner's go; then the owner's test
   on the phone, and stage 7's screens.
