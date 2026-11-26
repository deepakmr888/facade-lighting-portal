# Facade Lighting Tender Portal

A standalone local web app for facade-lighting tenders. It has its own server,
dependencies, JSON, Excel export and document folders. It does not use the GeM Bid
Tracker server or its large Tenderkart database.

## Start on Windows

1. Clone this project's GitHub repository into a writable folder.
2. Double-click `start.cmd`. First setup needs internet. It uses Node.js 22 or
   newer if installed; otherwise it downloads a checksum-verified Node.js 22
   runtime into `.runtime`, without a system installation. Node is not bundled.
3. Open **http://localhost:4070**. Keep the command window open.

For development on Windows/macOS/Linux with Node.js 22+: `npm ci`,
`node scripts/build-connector.cjs`, then `npm start`.

`start-lan.cmd` allows browsers on the same trusted network to view the portal
using `http://SERVER-IP:4070`. Configure the server firewall if needed. Sync,
login and editing controls operate on the server computer. This app has no user
accounts; do not expose it to the public internet. Keep port 4070 for the supplied
connector. `PORT`, `HOST`, `FACADE_DATA_DIR` are optional environment variables.

## Connect Tenderkart once

Use normal Chrome/Edge on the server computer, without automation browser flags:

1. Open `chrome://extensions` / `edge://extensions` and enable Developer mode.
2. Click **Load unpacked**, select this project's `connector` folder.
3. Reload the portal. Click **Sync latest**, sign into Tenderkart in the tab that
   opens, and return to the portal. The waiting job resumes automatically.
4. Leave the signed-in Tenderkart tab open. The app page can be closed or changed;
   the server and connector continue the job while they are running.

This is a separate connector from the main GeM Bid Tracker extension. It uses
port 4070 and does not interfere with that app's port 4000. It only requests the
Tenderkart listing/detail API and document URLs returned for those tenders.
Tenderkart login tokens stay inside the Tenderkart tab; they are not sent to
this server or written to the repository. A local pairing token is kept in the
extension's storage and ignored `data/browser-pairing.json` so pairing can survive
a server restart. This is not the Tenderkart login token; keep the data folder private.

Expired login, security verification and account quotas require attention in
Tenderkart. The app does not solve CAPTCHAs or work around access restrictions.
After restarting the server, the connector normally resumes its saved pairing.
Click Sign in / reconnect if you replace or move the data folder.

## What daily Sync does

- Searches **live tenders for `facade light`**, including Tenderkart's indexed
  document matches. Historical Results are not downloaded.
- Checks all saved tender IDs for changes, including saved tenders that have
  since closed. Closed/absent tenders are retained, not deleted.
- Upserts by tender identifier/source ID without replacing your review or comment.
  Conflicting source identifiers are marked for manual review.
- Fetches full tender-detail responses, keeps their raw JSON, discovers available
  document URLs, downloads them and extracts PDF/XLSX/CSV/text content. Existing
  file hashes reuse cached text. URLs not exposed by the source remain unavailable;
  the app does not guess private endpoints or invent missing information.
- Displays all saved metadata and document evidence for eligibility, amounts,
  deadlines, contacts and lighting specifications. Excerpts are labelled evidence,
  not confirmed eligibility. Verify the source PDF for bidding decisions.
- Saves each listing page **together with its checkpoint** before moving on.
  Each detail/document result is also saved. A restarted process resumes from
  the saved phase/page/queue after reconnecting, while an explicit pause remains
  paused. In-flight work finishes safely when Pause is clicked.
- Regenerates Excel on completion, Pause, review edits and Excel download. JSON is
  saved after each unit of work; Excel is a generated snapshot of it. Windows
  cannot replace an Excel file open in another application: close it and download
  Excel again if export reports a sharing error.
- Backs off on HTTP 429 and server failures, waits for login on 401/403, and tells
  you when a run is complete or partial. Page closure does not cancel the job.

Press Sync latest daily; this is a manual daily check, not a scheduled login bot.
Scripts and a persisted queue implement this workflow. No AI agent/service is
required. Scanned PDFs need OCR/manual review; legacy binary XLS, ZIP archives,
images and other unsupported files are explicitly marked for manual review.
Public document links must use HTTPS. Individual downloads are limited to 100 MB.
Tenderkart's 10,000-result search window is reported as incomplete, never as a
fully successful sync.

## Existing data and documents

The local project was initialized from the 65-tender Desktop facade-light portal.
`data/tenders.json` is the source of truth, `data/tenders.json.bak` is its previous
valid version, `data/documents` holds the original linked files, and
`data/extracted` holds text by SHA256. Excel lives at `data/exports/tenders.xlsx`
with separate Tenders, Documents and Document evidence worksheets.

**Data and documents are deliberately ignored by Git and excluded from the source
ZIP.** To use the current dataset on another machine, pause, stop this server,
then copy the complete `data` folder separately. Login must be established again.
A fresh clone starts empty and can populate records using Sync latest.

To initialize an empty project from the original standalone HTML bundle:

```powershell
npm run import:snapshot -- "C:\path\Facade_Lighting_Tender_Portal_With_Documents"
npm run index:documents
```

Stop the server before running these offline utilities. Import refuses to replace
existing records. The original file-page stored reviews in that browser's
`localStorage`; those browser-only comments are not part of the HTML export and
are not silently copied. Reviews in this new app are saved in the server JSON.

## Connector 1.1 and original-portal document flows

After updating this project, reload **Facade Lighting Portal – Tenderkart
connection** in `chrome://extensions` (or Edge Extensions). Version 1.1 adds
document-download permission, local reply-cache storage and access to the 26 configured portal hosts.
Reload the app page after reloading the extension. Do not replace it with the
old GeM tracker connector on port 4000.

Heartbeat polling now runs independently of long API requests. The server allows
90 seconds for MV3 worker wakeups, preserves pairing and in-flight requests on
repeated Connect clicks, retries a saved unsent reply, and leases an abandoned
read request again after a worker restart. A real 401/403/verification response
stays visible until you complete the site's login/security step and reconnect.
For background lifecycle behavior see the [official Chrome documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
This does not suppress site challenges, extend expired sessions or bypass quotas.

On the app page, use **Portal document downloads**:

1. **Find documents needing a portal** creates persistent tasks for missing files.
   Direct-download failures also create these tasks during Sync.
2. **Open next queued flow**, or **Open / reopen flow**, opens a normal browser tab
   for that specific tender and document. Only one flow is active at once.
3. The adapter opens the platform's search/detail/document view where recognized.
   Enter any CAPTCHA directly in the portal and submit it yourself. Login and
   CAPTCHA values are never read or filled by the helper. The helper pauses at
   ambiguous search results, changed layouts and unconfigured redirects.
4. A matching document is selected only from a page containing the tender ID.
   A related browser download is captured and copied from the default Downloads
   folder, validated, extracted and added to the tender/JSON/Excel.
5. For custom download folders or an unsupported portal screen, download manually
   in that same flow, then use **Attach downloaded file** and confirm its identity.
   The expected checksum is enforced when available. Otherwise exact filename
   and explicit tender identity confirmation are required. Files outside Downloads
   cannot be read automatically by the server.

The 26 observed hosts are mapped to 11 adapters in `connector/portal-adapters.js`.
NIC/GePNIC shares one adapter across its state/central hosts; its live Uttar Pradesh
search form was checked. IREPS public search navigation and the CHiPS RFQ field
were also checked. Other platform definitions have separate search selectors,
entry URLs and document sections, but their complete CAPTCHA/download stages
have **not** all been verified live. The UI lists each adapter's verification
status. A configured host is not a claim of a fully verified download flow.
Unknown layouts require human navigation or an adapter update, not an AI agent
on every run. `connector/portal-step.js` contains the DOM steps and
`server/portal-flows.cjs` persists checkpoints and validates received files.

New tenders whose source portal has no registered adapter are still fetched from
Tenderkart and displayed with all available metadata. Their documents are not
downloaded, even if a direct file URL is present. They are marked `needs_adapter`
with a `documentDownloadPolicy` reason/hostname in JSON and a Document downloads
field on the page/Excel. Deferred files appear in the All portal-flow view and
are excluded from the active queue. Existing files are preserved. A future agent
can use those saved records to add an adapter to `connector/portal-adapters.js`;
after its script/permissions are installed and the server restarted, rescanning
re-enables the deferred files. No agent is run or installed automatically.

Portal errors skip the affected tender's remaining document tasks and advance
to the next queued tender. The reason is retained in JSON/Excel and the All view;
existing downloaded files are preserved. Skipped tenders are not automatically
retried by later daily syncs. Open a skipped flow explicitly to retry it.
CAPTCHA/login prompts pause for manual input and are not counted as portal errors.
Pausing the active portal flow also stops automatic queue advancement.

Pause a portal flow separately from the main Tenderkart Sync job. Completed
files remain saved. A restarted connector recovers its saved portal task;
CAPTCHAs or source sessions can still expire and need another manual step.

## GitHub and another development machine

This folder is an independent Git repository with its own `main` branch. It does
not use the parent GeM Bid Tracker remote. ZIP transfers are not required.

Private repository: https://github.com/deepakmr888/facade-lighting-portal

The original checkout is connected to that repository. For a separately
initialized copy, connect it once from **this project folder**:

```powershell
git remote add origin https://github.com/deepakmr888/facade-lighting-portal.git
git push -u origin main
```

If `origin` is already configured, check `git remote -v` and use
`git remote set-url origin URL` only when changing repositories.

On the second computer:

```powershell
git clone https://github.com/deepakmr888/facade-lighting-portal.git facade-lighting-portal
cd facade-lighting-portal
.\start.cmd
```

Before editing on **either** computer, get the other computer's published changes:

```powershell
git pull --ff-only
```

After making and checking changes on either computer:

```powershell
git status
git add .
git commit -m "Describe the change"
git push
```

Then run `git pull --ff-only` on the other computer. GitHub receives changes only
after a commit and push; it does not automatically copy unsaved or uncommitted work.
Stop the web server before pulling code, then restart `start.cmd`. The launcher
installs changed dependencies when `package-lock.json` changes. Reload the browser
extension if its code or manifest changed.

If both computers committed different changes before pulling, `--ff-only` stops
without replacing your work. Use `git pull --rebase`, resolve any reported conflicts,
then `git push`. Do not use force pushes or hard resets to synchronize machines.

Inspect `git status` before committing. `data`, `.runtime`, `node_modules`,
credentials and downloaded documents are ignored. **Git synchronizes code only**;
each machine has its own data and browser login. To copy the current dataset,
pause/stop the app and transfer the complete `data` folder separately once.
Install the connector and sign into Tenderkart on each computer that downloads.

## Validation and packaging

`npm test` exercises resume checkpoints, merge/review preservation, limits,
pause races, document extraction/security, exports and API behavior using fixtures.
Those tests do not claim that a current Tenderkart account is connected.

`npm run package` creates `release/facade-lighting-portal-source.zip` using a source
allowlist. It excludes real records, documents, sessions, Node and dependencies.
