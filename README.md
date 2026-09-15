# waterlooworks-agent

Local automation for WaterlooWorks with a CLI (`ww`) and an MCP server (`ww-mcp`) sharing one core library.

V1 use case: find applications submitted with an outdated résumé, decide which can still be changed, and
reapply with the corrected résumé while preserving the rest of the package (cover letter, transcript,
work history, pre-screening answers).

## Layout

```
packages/core   domain models, SQLite persistence, provider interface, services, Playwright page objects
packages/cli    `ww` (Commander)
packages/mcp    `ww-mcp` (MCP over stdio)
data/ww.db      SQLite: résumés, snapshots, plans, operations
browser-profile persistent Chromium profile holding the login session (never read by application code)
```

Requires Node 22+ (uses the built-in `node:sqlite`).

```bash
npm install
npm run build
npm test                       # 20 Vitest tests against the in-memory fake provider
npx playwright install chromium   # once, if Chromium is not already cached
```

## CLI

```bash
node packages/cli/dist/index.js --help        # or `npm link -w @ww/cli` to get `ww` on PATH

ww login                     # opens Chromium; finish Waterloo SSO + MFA in the window
ww auth status
ww logout                    # clears the browser profile

ww resume list
ww resume upload ./resume-fixed.pdf --name "SWE Resume Fixed"

ww applications list [--status submitted] [--resume "SWE Resume Old"] [--editable]
ww application show 38192
ww application snapshot 38192
ww job 38192

# Batch résumé replacement: preview is the default, execution is opt-in.
ww applications replace-resume --from resume_old.pdf --to resume_fixed.pdf            # dry run, prints plan
ww applications replace-resume --from resume_old.pdf --to resume_fixed.pdf --execute  # asks for confirmation
ww applications replace-resume --plan plan_abc123 --execute --yes                     # run a stored plan

ww application replace-resume 38192 --to resume_fixed.pdf [--execute]                 # one application
ww application replace-resume 38192 --from swe,swe-jerry --to quantDEF --execute      # when two identical uploads match
ww application replace-resume 38192 --to swe_jerry-1 --other nreplit --execute        # also swap the "Other - Per Job Posting" doc

ww document list --type other                                   # other | cover_letter | resume; marks [default]
ww document upload ./nreplit.pdf --type other --name nreplit    # PDF only; the name must be unique for that type
ww document cleanup --default swe_jerry-1 [--keep a,b]          # preview: archive unused docs, single default résumé
ww document cleanup --default swe_jerry-1 --execute [--yes]     # apply (archiving is reversible in the UI)
ww document archive --type cover_letter 11047169 11047189       # archive specific documents
ww document set-default --type resume swe_jerry-1 [--unset]

ww plans list | ww plans show <planId>
ww operations list
ww operations incomplete     # exit code 3 when recovery is required
ww recover 38192 [--dry-run] [--to <résumé>] [--other <doc>]   # resubmit from snapshot, optionally with swaps

# Job market scan: read every posting in your program and export it.
ww jobs scan                        # "My Program" filter on; resumable, caches each posting in SQLite
ww jobs scan --all --limit 100      # every program, first 100 postings
ww jobs scan --refresh              # re-read postings already cached
ww jobs list [--all] [--ai] [--external]   # cached postings, highest pay first
ww jobs export -o jobs.xlsx [--all] # "All Jobs" + "AI Tooling" + "External Applications" sheets

ww debug page /myAccount/co-op/applications.htm -o page.html   # selector calibration
```

Global flags: `--json` for machine output, `--headless`, `--fake` (in-memory provider, no browser).

Environment: `WW_ROOT`, `WW_DB_PATH`, `WW_PROFILE_DIR`, `WW_BASE_URL`, `WW_HEADLESS=1`, `WW_FAKE=1`, `WW_LOG_LEVEL`.

## Job scan and spreadsheet export

`ww jobs scan` walks the job search results grid (clicking the **My Program** quick filter unless
`--all`), opens every row's posting panel, and splits the panel text into WaterlooWorks' own fields
using the closed label list in `POSTING_LABELS` — employer headings like "About the role:" are not
boundaries, so descriptions survive whole. Each posting is committed to `job_postings` as it is read,
so an interrupted scan (the session times out after a few idle hours) resumes rather than restarts.

`ww jobs export` writes one workbook:

- **All Jobs** — one row per posting, highest pay first, with the verbatim compensation text next to
  the parsed figure.
- **AI Tooling** — every posting whose title/summary/responsibilities/skills mention AI at all, with
  the terms that matched, the sentence each matched in, and a **Specific?** column reading
  `specific tooling` (named a concrete tool, platform or technique — Copilot, Cursor, LLM, RAG,
  agents, a model provider) or `generic AI` (only bare AI/ML/deep-learning wording). Filter on that
  column rather than trusting the keyword list to make the judgment for you.

- **External Applications** — postings you cannot finish inside WaterlooWorks, with the apply link
  and the sentence that says so. Two kinds: `apply elsewhere` (the posting's **Application Method**
  is not WaterlooWorks) and `also apply elsewhere` (WaterlooWorks *and* the employer's own form —
  what WaterlooWorks calls a "two step process" when it warns you that cancelling here does not
  withdraw the external half). Matching demands an apply verb aimed somewhere other than
  WaterlooWorks, so interview-process blurbs, recruiter-contact notes and informational links do not
  qualify; a required portfolio or take-home is likewise not an external *application*.

Pay is free-form employer prose, so `parseSalary` extracts the figures and normalises them to an
hourly rate (40 h/week, 17-week term) *only so the sheet can be sorted*; the raw text always travels
with the row. Figures outside a plausible range for their unit are dropped, which is what keeps
"401(k) with a 4% match" and wellness stipends out of the salary column. Rows whose pay could not be
parsed sort to the bottom with their text intact — check those by hand.

`findAITooling` matches an explicit term list (`AI_TERMS`), each term carrying a category. Bare
"AI"/"ML"/"machine learning" hits are categorised `general-ai`; everything else counts as specific
tooling. Both kinds reach the AI sheet — the `Specific?` column separates them, so a posting is never
dropped by the keyword list's judgment. Edit the list in
`packages/core/src/services/aiTooling.ts` to taste and re-run `ww jobs export` — re-scanning is not
needed, the export reads from the cache.

## MCP server

```json
{
  "mcpServers": {
    "waterlooworks": {
      "command": "node",
      "args": ["/path/to/waterlooworks-agent/packages/mcp/dist/index.js"],
      "env": { "WW_MCP_ALLOW_MUTATION": "0" }
    }
  }
}
```

Tools by permission level:

| Level | Tools |
|---|---|
| 0 read-only | `ww_auth_status`, `ww_list_resumes`, `ww_list_documents`, `ww_list_applications`, `ww_get_application`, `ww_get_job`, `ww_get_plan`, `ww_list_incomplete_operations` |
| 1 local | `ww_snapshot_application`, `ww_preview_resume_replacement` |
| 2 external mutation | `ww_upload_resume`, `ww_upload_document`, `ww_execute_resume_replacement`, `ww_recover`, `ww_replace_application_resume` (non-dry-run) |

Level 2 tools return `MUTATION_DISABLED` unless the server runs with `WW_MCP_ALLOW_MUTATION=1`, and every
call must also pass `confirm: true`. `ww_replace_application_resume` additionally needs
`WW_MCP_ALLOW_DIRECT_REPLACE=1`; the intended path is preview → plan_id → user approval → execute.

Logs go to stderr with password/cookie/token/authorization fields redacted.

## Safety properties (enforced in code)

- A snapshot is committed to SQLite before any cancellation; the operation row is updated before each external call.
- Eligibility is re-checked from a fresh read immediately before mutating (deadline, status, can-cancel, can-reapply).
- Batch execution is strictly sequential: snapshot → cancel → reapply → verify per application. Stops on first error.
- Plans are immutable and single-use. Execution is refused while any incomplete operation exists.
- Verification compares the resubmitted application against the snapshot (job, status, résumé, other documents, answers). Only `VERIFIED` counts as success.
- If a cancel/submit throws, the live application is re-read; recovery is flagged only when it is no longer submitted.
- Recovery first looks for an existing submitted application and verifies it instead of submitting a duplicate.
- Page objects fail with `SELECTOR_MISMATCH` or `UNKNOWN_STATE` rather than guessing when the DOM does not match.

## How WaterlooWorks actually works (calibrated 2026-09-12)

- **Navigation is form POSTs, not URLs.** Landing pages show "Status of Applications" / document-category
  summary tables; each "View" link runs `orbisApp.buildForm({...action token...})`. Page objects click those.
- **Session cookies are not persisted by Chromium.** `ww login` saves Playwright storage state to
  `browser-profile/storage-state.json` (mode 600) and every launch re-injects it. `ww logout` deletes it.
- **Applications are keyed by job ID.** One active application per posting, so `application_id == job_id`.
  The applications viewer (`table.data-viewer-table`) has per-row *View Application*, *Print* and
  *Cancel Application* buttons; cancel opens an "Are you sure you wish to delete this application?" dialog.
- **The package is a merged PDF.** WaterlooWorks never lists which résumé an application used. The provider
  downloads the application package and every candidate résumé / cover letter / other document (cached in
  `data/docs/`, they are immutable), renders them at 36 dpi with poppler and finds each document's pages
  inside the package. Results are cached in the `package_analyses` table. If two résumés render identically
  the résumé is reported as `a|b` and the application is `ambiguous_resume` **unless** every candidate is
  named as old: `--from swe,swe-jerry` (batch) or `--from swe,swe-jerry` on the single-application command.
- **Sessions time out.** `JSESSIONID` is a session cookie; after a few hours idle `ww auth status` reports
  "Not authenticated" and `ww login` must be run again.
- **Documents grid defaults to the last 30 days.** The provider replays the View form with `numOfDays:'-1'`.
- **Applying** happens in a popup wizard: *Create Custom Application Package* → per-type radios named by
  document type ID (66 cover letter, 67 résumé, 70 other, 71 grade report, 76 work history). Non-default
  documents have a disabled, hidden radio; the site's `addExistingDocToSelection(typeId)` enables and clicks
  it, and `ApplyPage` does the same directly on the radio. The wizard's *Submit* button **is the submission**
  (verified live 2026-09-13); the following *Confirmation* step is only an AJAX-loaded receipt with no further
  button. `ApplyPage.submit()` waits for that receipt and the provider re-reads the applications list.
- **Documents cannot be deleted, only archived** (per-row *Archive* button → AJAX post; *Unarchive Selected* in the
  archived view reverses it). Defaults (*Make Default* / *Remove Default* per row; several résumés can be flagged at
  once) cannot be archived until un-flagged. `ww document cleanup` never archives anything a submitted application's
  package references, because the apply wizard only offers non-archived documents.
- **Uploading** goes through the *Upload A Document* page (`#fileUploadForm`: `docName`, `docType` 66/67/70,
  an AJAX file input that fills the hidden `docUploaded`, then `#submitFileUploadFormBtn`). PDF only, 5 MB max.
- Work history and grade report are system-generated documents; they are auto-selected, not uploaded.
- Pre-screening questions were not present on any inspected posting; `questions` is always empty for now.

Requires `poppler-utils` (`pdftoppm`, `pdfinfo`) on PATH.

## Verified live (read-only)

`ww auth status`, `ww resume list` (12 résumés incl. older than 30 days), `ww applications list` (42 rows),
`ww job <id>`, `ww application show <id>` (deadline, required docs, résumé/other identified from the package).

`ww jobs scan` (2026-09-13): "My Program" quick filter, grid pagination, and posting-panel reads all
work against the live site — 722 postings, matching the "722 results" the grid reports.

Postings store the whole label/value map in `sections` alongside the mapped fields. The first live
run mapped only the fields the spreadsheet then needed and dropped the rest, so the next question
("which jobs are applied to outside WaterlooWorks?") needed a second 20-minute scrape for a field
that had already been on screen. Keep the raw blob.

Posting fields are read from the `div.tag__key-value-list.js--question--container` label/value pairs,
taking each container's whole innerText minus its label line. Two earlier approaches were wrong and
are worth not repeating: splitting the panel text on a hardcoded label list silently merged a field
into its predecessor whenever WaterlooWorks rendered a label the list did not know (`Job - Country`
swallowed `Job Location (If Exact Address Unknown...)`), and reading only the value's `<p>` elements
dropped every bullet list, because employers write a `<p>` lead-in ("You will:") followed by a
sibling `<ul>`.

## Verified live (mutating, 2026-09-13)

- `ww resume upload <pdf> --name <n>` — two uploads, both listed with new IDs afterwards.
- Cancel + reapply on one application (job 486534): cancel worked first time; the reapply failed twice on
  page-object assumptions (document radio, confirmation button) that are now fixed. The second attempt did
  submit; `ww recover <job> --to <résumé>` then verified the live application against the snapshot and closed
  the operation. `ww recover --to` lets recovery resubmit with a different résumé than the failed operation's.

## Not yet exercised live

- A full uninterrupted `snapshot → cancel → reapply → verify` run of `ww application replace-resume` with the
  fixed `ApplyPage` (each step has now succeeded individually). Run the next one **without `--headless`**
  and watch the browser; then execute a batch plan with `--plan <id> --execute` (plans are single-use).
- Applications in status views other than *Applied* (none existed on the inspected account).
