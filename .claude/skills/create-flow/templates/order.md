# <Flow name>: the merge order

The order the platform enforces: each step reads what the one before it deployed, so a step starts
only when the one before it is done. A merge to `main` is the deploy (the platform's ADR-0047): no
pin, registration or release pull request follows one. The session writes this list out for the
owner at stage 6 and fills it in as it goes — each pull request's link once its required check is
green on the head, each run's summary as read. The owner merges every pull request, and says go, in
manual permission mode, for any step that touches production outside a merge.
Section 10 empty: no step 1; the platform is unchanged.

0. **A client that is red for another reason** — an advisory failing its blocking audit — gets that
   fix as its own pull request before any lane; the client's lane branches from it and is rebased
   once it merges (Round 19's website `next` bump, #60).
1. **The backend pull request** (section 10 not empty): the contract, the platform and the round's
   records. The session pushes and opens it; while Actions is out of minutes,
   `node scripts/local-ci.mjs --pr <n>` posts the required check, `local/all-green`. Merge; read
   its CD run (`snoopy-backend/.github/workflows/cd.yml`): its summary, then the public entrance.
2. **The automations pull request.** First re-vendor its `contract/` from the backend's
   squash-merge commit, byte for byte, and cite that commit in
   `snoopy-automations/contract/README.md`: the lanes' contract commit is not on `main` after a
   squash (Round 19's `7a4baa6` merged as `2d93d99`). Then its gate. Merge; read the Deploy job:
   the flow's version NEW, every other automation SKIP (or UPDATE where its image changed). A red
   Deploy changed nothing served, and its summary names the refusal.
3. **The clients' pull requests.** Each client's `Deployed contract` check is red by design until
   production serves the contract its types came from (Round 19, the app's lane): after step 1's CD
   run, re-run it. The owner merges the website's and the app's once their required checks are green on
   the head.
4. **TestFlight**: the app's build from its merged `main`, on the owner's go; then the owner's test
   on the phone, and stage 7's screens.
