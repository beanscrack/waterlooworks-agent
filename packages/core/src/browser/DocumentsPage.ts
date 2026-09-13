import type { Page } from "playwright";
import { SelectorError } from "../errors.js";
import { clean, parseDate, settle } from "./pageUtils.js";

const KNOWN_TYPES = /^(R[ée]sum[ée]|Cover Letter|Grade Report|Other - Per Job Posting|University of Waterloo Co-op Work History|Package)$/i;
import { routes, sel } from "./selectors.js";

export interface DocRow {
  docId: string;
  name: string;
  type: string;
  createdAt?: Date;
  isPackage: boolean;
  archived: boolean;
  isDefault: boolean;
  index: number;
}

/** Documents landing page + its jQuery grid views (Résumé, Cover Letter, Application Packages, …). */
export class DocumentsPage {
  constructor(private page: Page, private baseUrl: string) {}

  async open(): Promise<void> {
    await this.page.goto(new URL(routes.documents, this.baseUrl).toString(), { waitUntil: "domcontentloaded" });
    await settle(this.page);
  }

  async categories(): Promise<{ label: string; count: number }[]> {
    const rows = this.page.locator(sel.stat.row);
    const n = await rows.count();
    const out: { label: string; count: number }[] = [];
    for (let i = 0; i < n; i++) {
      const cells = (await rows.nth(i).locator("td").allInnerTexts()).map(clean);
      if (cells.length >= 2 && /^\d+$/.test(cells[1])) out.push({ label: cells[0], count: Number(cells[1]) });
    }
    return out;
  }

  /**
   * Open a category grid. The landing links are pre-filtered to the last 30 days
   * (`numOfDays:'30'` inside the buildForm call); with `allTime` we replay the same
   * form submission with `numOfDays:'-1'`, which WaterlooWorks uses for "all".
   */
  async openCategory(label: string, opts: { allTime?: boolean } = {}): Promise<void> {
    const link = this.page.locator(sel.stat.viewLink(label)).first();
    if ((await link.count()) === 0) throw new SelectorError(`Documents category "${label}" not found on landing page.`);
    if (opts.allTime) {
      const onclick = await link.getAttribute("onclick");
      if (onclick && /numOfDays/.test(onclick)) {
        const patched = onclick.replace(/numOfDays'?\s*:\s*'\d+'/, "numOfDays':'-1'");
        await this.page.evaluate((code) => {
          // eslint-disable-next-line no-new-func
          new Function(code)();
        }, patched);
        await settle(this.page);
        return;
      }
    }
    await link.click();
    await settle(this.page);
  }

  async readGrid(): Promise<DocRow[]> {
    const table = this.page.locator(sel.grid.table);
    if ((await table.count()) === 0) throw new SelectorError("Documents grid not found.");
    const raw = await this.page.locator(sel.grid.rows).evaluateAll((rows, args) =>
      rows.map((row, index) => {
        const cb = row.querySelector<HTMLInputElement>(args.checkbox);
        const cells = [...row.querySelectorAll("td")];
        const texts = cells.map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim());
        const badges = cells.map((c) => [...c.querySelectorAll(args.badge)].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim()));
        return { index, id: cb?.id ?? "", texts, badges };
      }),
    { checkbox: sel.grid.checkbox, badge: sel.grid.badge });
    const out: DocRow[] = [];
    for (const r of raw) {
      const m = r.id.match(/record(\d+)/);
      if (!m) continue;
      // Anchor on the Type cell: a bare category label immediately followed by a parsable date.
      let typeIdx = -1;
      for (let i = 1; i < r.texts.length - 1; i++) {
        if (KNOWN_TYPES.test(r.texts[i]) && parseDate(r.texts[i + 1])) {
          typeIdx = i;
          break;
        }
      }
      if (typeIdx < 1) throw new SelectorError(`Documents grid row ${r.index} has no recognisable Type cell: ${r.texts.join(" | ")}`);
      let name = r.texts[typeIdx - 1];
      for (const b of r.badges[typeIdx - 1]) name = clean(name.replace(b, ""));
      const isDefault = r.badges[typeIdx - 1].some((b) => /default/i.test(b));
      const yesNo = (t: string | undefined) => /^yes$/i.test(t ?? "");
      out.push({
        docId: m[1],
        name,
        type: r.texts[typeIdx],
        createdAt: parseDate(r.texts[typeIdx + 1]),
        isPackage: yesNo(r.texts[typeIdx + 2]),
        archived: yesNo(r.texts[typeIdx + 3]),
        isDefault,
        index: r.index,
      });
    }
    return out;
  }

  /** Download the PDF for a grid row (by index within the currently open grid). */
  async downloadRow(index: number, destPath: string): Promise<void> {
    const row = this.page.locator(sel.grid.rows).nth(index);
    const link = row.locator(sel.grid.download).first();
    if ((await link.count()) === 0) throw new SelectorError(`Row ${index} has no "Download PDF" link.`);
    const [dl] = await Promise.all([this.page.waitForEvent("download", { timeout: 60_000 }), link.click()]);
    await dl.saveAs(destPath);
  }

  /** Download several documents from the currently open grid. Returns docId → saved path. */
  async downloadMany(rows: DocRow[], destFor: (docId: string) => string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const r of rows) {
      const dest = destFor(r.docId);
      await this.downloadRow(r.index, dest);
      out.set(r.docId, dest);
    }
    return out;
  }

  /**
   * Upload a PDF through the "Upload A Document" page. The file input is driven by Orbis'
   * AJAX uploader, which stores the server-side handle in the hidden `docUploaded` field and
   * re-arms the submit link ~3 s after a file is chosen; we wait for both before submitting.
   */
  async uploadDocument(filePath: string, name: string, typeId: string): Promise<void> {
    await this.open();
    const link = this.page.locator(sel.upload.openLink).first();
    if ((await link.count()) === 0) throw new SelectorError('"Upload A Document" control not found on documents page.');
    await link.click();
    await settle(this.page);
    if ((await this.page.locator(sel.upload.form).count()) === 0) throw new SelectorError("Upload form did not appear.");
    const missing: string[] = [];
    for (const [label, s] of [["name", sel.upload.name], ["type", sel.upload.type], ["file", sel.upload.file], ["submit", sel.upload.submit]] as const)
      if ((await this.page.locator(s).count()) === 0) missing.push(label);
    if (missing.length) throw new SelectorError(`Upload form is missing controls: ${missing.join(", ")}. Refusing to upload.`);

    await this.page.locator(sel.upload.name).fill(name);
    const typeValues = await this.page.locator(`${sel.upload.type} option`).evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    if (!typeValues.includes(typeId)) throw new SelectorError(`Document type ${typeId} is not offered by the upload form (${typeValues.join(", ")}).`);
    await this.page.locator(sel.upload.type).selectOption(typeId);
    await this.page.locator(sel.upload.file).setInputFiles(filePath);

    // Wait for the AJAX upload handle, then for the submit link to be re-armed.
    const marker = this.page.locator(sel.upload.uploadedMarker);
    const deadline = Date.now() + 90_000;
    let handle = "";
    while (Date.now() < deadline) {
      handle = (await marker.count()) ? (await marker.inputValue().catch(() => "")) : "";
      if (handle) break;
      await this.page.waitForTimeout(500);
    }
    if (!handle) throw new SelectorError("File did not finish uploading (docUploaded stayed empty); nothing saved.");
    await this.page.waitForTimeout(3500);
    const submit = this.page.locator(sel.upload.submit).first();
    if (await submit.isDisabled().catch(() => false)) throw new SelectorError("Upload submit button is still disabled; nothing saved.");
    await Promise.all([this.page.waitForLoadState("load", { timeout: 60_000 }).catch(() => {}), submit.click()]);
    await settle(this.page);
    if ((await this.page.locator(sel.upload.form).count()) > 0) {
      const err = clean(await this.page.locator(".alert-error, .alert-danger, .error, .help-inline").allInnerTexts().then((t) => t.join(" | ")).catch(() => ""));
      throw new SelectorError(`Upload form is still displayed after submit${err ? `: ${err}` : ""}.`);
    }
  }

  /** Wait until the jQuery grid has re-rendered after an AJAX action (the row element is replaced). */
  private async waitForRowState(docId: string, predicate: (row: DocRow | undefined) => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(600);
      const rows = await this.readGrid().catch(() => undefined);
      if (rows && predicate(rows.find((r) => r.docId === docId))) return;
    }
    const msg = clean((await this.page.locator(sel.grid.message).allInnerTexts().catch(() => [])).join(" | "));
    throw new SelectorError(`Grid did not reflect "${what}" for document ${docId}${msg ? ` (page says: ${msg})` : ""}.`);
  }

  /** Archive one row of the currently open (non-archived) grid via its per-row Archive button. */
  async archiveRow(docId: string): Promise<void> {
    const btn = this.page.locator(sel.grid.archiveButton(docId)).first();
    if ((await btn.count()) === 0) throw new SelectorError(`Document ${docId} has no Archive button in the open grid.`);
    await btn.click();
    await this.waitForRowState(docId, (row) => !row || row.archived, "archive");
  }

  async setDefaultRow(docId: string): Promise<void> {
    const btn = this.page.locator(sel.grid.makeDefault(docId)).first();
    if ((await btn.count()) === 0) {
      const already = (await this.readGrid()).find((r) => r.docId === docId)?.isDefault;
      if (already) return;
      throw new SelectorError(`Document ${docId} has no "Make Default" button in the open grid.`);
    }
    await btn.click();
    await this.waitForRowState(docId, (row) => !!row?.isDefault, "make default");
  }

  async unsetDefaultRow(docId: string): Promise<void> {
    const btn = this.page.locator(sel.grid.removeDefault(docId)).first();
    if ((await btn.count()) === 0) {
      const row = (await this.readGrid()).find((r) => r.docId === docId);
      if (row && !row.isDefault) return;
      throw new SelectorError(`Document ${docId} has no "Remove Default" button in the open grid.`);
    }
    await btn.click();
    await this.waitForRowState(docId, (row) => !!row && !row.isDefault, "remove default");
  }

  async listCategory(label: string, allTime = true): Promise<DocRow[]> {
    await this.open();
    await this.openCategory(label, { allTime });
    return this.readGrid();
  }
}
