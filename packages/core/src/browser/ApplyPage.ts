import type { Page } from "playwright";
import { SelectorError, UnknownStateError } from "../errors.js";
import type { ApplicationPayload, DocumentType } from "../models/index.js";
import { clean } from "./pageUtils.js";
import { DOC_LABELS, DOC_TYPE_IDS, sel } from "./selectors.js";

/**
 * The "Submit Application" wizard (popup tab). Step 1 "Application Options" builds a custom
 * package from per-type radios; the wizard's Submit button only advances to step 2
 * "Confirmation", whose final button performs the actual submission.
 */
export class ApplyPage {
  constructor(private page: Page) {}

  async requiredDocLabels(): Promise<string[]> {
    const body = await this.page.locator("body").innerText();
    const lines = body.split("\n").map(clean);
    const i = lines.findIndex((l) => /must contain the following documents/i.test(l));
    if (i < 0) return [];
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l) continue;
      if (/Application Package/i.test(l)) break;
      out.push(l);
    }
    return out;
  }

  async chooseCustomPackage(): Promise<void> {
    await this.page.getByText(sel.apply.customPackageLabel, { exact: true }).first().click();
    await this.page.waitForTimeout(800);
    if ((await this.page.locator(sel.apply.packageName).count()) === 0) throw new SelectorError("Custom package form did not appear.");
  }

  async setPackageName(name: string): Promise<void> {
    await this.page.locator(sel.apply.packageName).first().fill(name);
  }

  private async checkRadio(typeId: string, docId: string): Promise<boolean> {
    const radio = this.page.locator(sel.apply.docRadio(typeId, docId)).first();
    if ((await radio.count()) === 0) return false;
    // A label span overlays the input; dispatch the click on the element itself.
    await radio.evaluate((el) => (el as HTMLInputElement).click());
    await this.page.waitForTimeout(200);
    return radio.isChecked();
  }

  /**
   * Non-default documents have a disabled, hidden radio that the site's
   * `addExistingDocToSelection(typeId)` enables and clicks after the "Select Existing" modal.
   * Do exactly that on the real radio (its own JS, no modal timing), then verify.
   */
  private async enableAndCheckRadio(typeId: string, docId: string): Promise<boolean> {
    const radio = this.page.locator(sel.apply.docRadio(typeId, docId)).first();
    if ((await radio.count()) === 0) return false;
    await radio.evaluate((el, tid) => {
      const input = el as HTMLInputElement;
      const all = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${tid}"]`);
      for (const r of all) {
        if (r.classList.contains("js--non-default-doc")) {
          r.disabled = true;
          r.parentElement?.classList.add("display--none");
        }
      }
      input.parentElement?.classList.remove("display--none");
      input.disabled = false;
      input.click();
    }, typeId);
    await this.page.waitForTimeout(300);
    return radio.isChecked();
  }

  /** Select a user document (résumé / cover letter / other) by WaterlooWorks doc ID. */
  async selectDocument(type: DocumentType, docId: string, name: string): Promise<void> {
    const typeId = DOC_TYPE_IDS[type];
    if (await this.checkRadio(typeId, docId)) return;
    if (await this.enableAndCheckRadio(typeId, docId)) return;
    // No radio for this document at all: fall back to the "Select Existing …" modal.
    const btn = this.page.locator(sel.apply.selectExistingButton(typeId)).first();
    if ((await btn.count()) === 0) throw new SelectorError(`No "Select Existing" control for ${type}.`);
    await btn.click();
    const modal = this.page.locator(sel.apply.selectExistingModal(typeId)).first();
    await modal.waitFor({ state: "visible", timeout: 10_000 });
    const select = modal.locator(sel.apply.selectExisting(typeId)).first();
    if ((await select.count()) === 0) throw new SelectorError(`Select for ${type} not found in modal.`);
    const values = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    if (!values.includes(docId)) throw new SelectorError(`${type} "${name}" (id ${docId}) is not selectable on this posting.`);
    await select.selectOption(docId);
    // Confirm button inside the modal.
    const confirm = modal.locator("button").filter({ hasText: /^(Select|Add|OK|Save|Done)$/i }).first();
    if ((await confirm.count()) > 0) await confirm.click();
    else await this.page.keyboard.press("Escape");
    await this.page.waitForTimeout(800);
    if (!(await this.checkRadio(typeId, docId))) throw new UnknownStateError(`Selected ${type} ${docId} but no matching radio became checked.`);
  }

  /** System documents (work history, grade report) are pre-generated; make sure one is selected. */
  async ensureSystemDocSelected(type: DocumentType): Promise<void> {
    const radios = this.page.locator(sel.apply.docRadiosForType(DOC_TYPE_IDS[type]));
    const n = await radios.count();
    if (n === 0) throw new SelectorError(`No ${type} document available on this account.`);
    for (let i = 0; i < n; i++) if (await radios.nth(i).isChecked()) return;
    await radios.first().evaluate((el) => (el as HTMLInputElement).click());
  }

  /** Validate that everything the payload needs exists on the form. Throws without mutating. */
  async preflight(payload: ApplicationPayload): Promise<void> {
    const missing: string[] = [];
    if ((await this.page.locator(sel.apply.packageName).count()) === 0) missing.push("package name input");
    if ((await this.page.locator(sel.apply.nextButton).count()) === 0) missing.push("wizard Submit button");
    for (const d of payload.documents) {
      const isSystem = DOC_LABELS.find((l) => l.type === d.type)?.system;
      if (isSystem) continue;
      const typeId = DOC_TYPE_IDS[d.type];
      const hasRadio = (await this.page.locator(sel.apply.docRadio(typeId, d.id ?? "")).count()) > 0;
      const hasSelect = (await this.page.locator(sel.apply.selectExistingButton(typeId)).count()) > 0;
      if (!hasRadio && !hasSelect) missing.push(`${d.type} controls`);
    }
    if (missing.length) throw new SelectorError(`Apply wizard is missing: ${missing.join(", ")}. Refusing to submit.`);
  }

  async fill(payload: ApplicationPayload, packageName: string): Promise<void> {
    await this.chooseCustomPackage();
    await this.preflight(payload);
    await this.setPackageName(packageName);
    for (const d of payload.documents) {
      const meta = DOC_LABELS.find((l) => l.type === d.type);
      if (meta?.system) await this.ensureSystemDocSelected(d.type);
      else {
        if (!d.id) throw new SelectorError(`Document ${d.type} "${d.name}" has no WaterlooWorks ID; cannot select it.`);
        await this.selectDocument(d.type, d.id, d.name);
      }
    }
    if (payload.questions.length) throw new SelectorError("This wizard has no question fields; refusing to drop answers.");
  }

  /**
   * Press the wizard's "Submit" button. Calibrated live 2026-09-13: this button *is* the
   * submission — the wizard then shows a "Confirmation" step whose content (a receipt) is
   * loaded over AJAX; there is no further button to press. We wait for that receipt, fail
   * loudly if it reads like an error, and leave final verification to the caller, which
   * re-reads the applications list.
   */
  async submit(): Promise<void> {
    const next = this.page.locator(sel.apply.nextButton).first();
    if ((await next.count()) === 0) throw new SelectorError("Wizard Submit button not found; nothing submitted.");
    const label = clean(await next.innerText());
    if (!/^submit/i.test(label)) throw new UnknownStateError(`Wizard next button reads "${label}", expected "Submit"; nothing submitted.`);
    await next.click();

    // Wait for the Confirmation step to become current and its AJAX receipt to finish loading.
    const deadline = Date.now() + 45_000;
    let confirmText = "";
    // The apply form's onsubmit closes the popup (`window.open('', '_self').close()`), so the
    // window can vanish at any point after the click. That is a success signal, not an error.
    try {
      while (Date.now() < deadline) {
        if (this.page.isClosed()) return;
        const step = this.page.locator(sel.apply.finalStep).first();
        const isCurrent = (await step.count()) > 0 && (await step.evaluate((el) => el.classList.contains("current-step")).catch(() => false));
        if (isCurrent) {
          const box = step.locator(sel.apply.confirmContent).first();
          const loading = (await box.locator(".ajaxLoader:visible").count().catch(() => 0)) > 0;
          confirmText = clean(await box.innerText().catch(() => ""));
          if (!loading && confirmText) break;
        }
        await this.page.waitForTimeout(500);
      }
    } catch (e) {
      if (this.page.isClosed()) return;
      throw e;
    }
    if (this.page.isClosed()) return;
    if (!confirmText) {
      throw new UnknownStateError("Submit was pressed but the Confirmation receipt did not load; verify the application manually.");
    }
    if (/error|unable|could not|not been submitted|failed|invalid/i.test(confirmText) && !/success/i.test(confirmText)) {
      throw new UnknownStateError(`Confirmation step reports a problem: ${confirmText.slice(0, 300)}`);
    }
    // Close the wizard politely if it offers "Done"; otherwise the caller closes the popup.
    const done = this.page.locator(sel.apply.finishButton).first();
    if ((await done.count()) > 0 && (await done.isVisible().catch(() => false))) {
      await done.click().catch(() => {});
      await this.page.waitForTimeout(1000);
    }
  }
}
