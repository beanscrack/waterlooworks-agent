/**
 * ALL WaterlooWorks selectors and routes live here (spec section 7).
 * Calibrated against the live Orbis "Outcome" deployment on 2026-09-12.
 * Nothing outside src/browser/ may import this file.
 */
import type { DocumentType } from "../models/index.js";

export const routes = {
  login: "/waterloo.htm?action=login",
  dashboard: "/myAccount/dashboard.htm",
  applications: "/myAccount/co-op/full/applications.htm",
  documents: "/myAccount/co-op/full/documents.htm",
  jobs: "/myAccount/co-op/full/jobs.htm",
};

export const loginHostHints = ["adfs", "login.microsoftonline", "duosecurity", "cas.uwaterloo", "sso"];
export const loginPathHints = ["/waterloo.htm", "/login", "/notLoggedIn", "/home.htm"];

/** WaterlooWorks document type IDs, as used by the apply wizard's radio/select names. */
export const DOC_TYPE_IDS: Record<DocumentType, string> = {
  cover_letter: "66",
  resume: "67",
  other: "70",
  transcript: "71", // "Grade Report"
  work_history: "76", // "University of Waterloo Co-op Work History"
};

/** Human labels WaterlooWorks uses for document categories → our types. */
export const DOC_LABELS: { label: string; type: DocumentType; system: boolean }[] = [
  { label: "University of Waterloo Co-op Work History", type: "work_history", system: true },
  { label: "Grade Report", type: "transcript", system: true },
  { label: "Résumé", type: "resume", system: false },
  { label: "Cover Letter", type: "cover_letter", system: false },
  { label: "Other - Per Job Posting", type: "other", system: false },
];

export const sel = {
  authenticatedMarker: 'a[href="/logout.htm"], a[href*="logout.htm"]',

  /** Landing pages show "<label> <count> View" summary tables. */
  stat: {
    table: "table.stat-table",
    row: "table.stat-table tbody tr",
    viewLink: (label: string) => `table.stat-table tr:has-text("${label}") a:has-text("View")`,
  },

  /** Vue data viewer used by applications and job search. */
  viewer: {
    table: "table.data-viewer-table",
    headers: "table.data-viewer-table thead th",
    rows: "table.data-viewer-table tbody tr",
    titleLink: "a.overflow--ellipsis",
    button: (ariaLabel: string) => `button[aria-label="${ariaLabel}"]`,
    cancelLabel: "Cancel Application",
    applyLabel: "Apply",
    viewApplicationLabel: "View Application",
  },

  confirmModal: {
    visible: ".modal.is--visible",
    ok: '.modal.is--visible button:has-text("OK")',
    cancel: '.modal.is--visible button:has-text("Cancel")',
    deleteText: /delete this application/i,
  },

  /** jQuery grid used on the documents page. */
  grid: {
    table: "#doc_commonTableTableID",
    rows: "#doc_commonTableTableID tbody tr",
    headers: "#doc_commonTableTableID thead th",
    checkbox: "input.ms_check",
    download: 'a:has-text("Download PDF")',
    badge: ".badge",
    rowCheckbox: (docId: string) => `#doc_commonTable_record${docId}`,
    archiveButton: (docId: string) => `a.archiveBtn[data-id="${docId}"]`,
    makeDefault: (docId: string) => `a[onclick="setDefaultDocument(${docId})"]`,
    removeDefault: (docId: string) => `a[onclick="unsetDefaultDocument(${docId})"]`,
    message: ".alert, .notification, .orbis-notification, .messages",
  },

  jobs: {
    keyword: 'input[placeholder*="keyword" i]',
    /** Quick-filter pills carry a hidden checkbox named after the filter key. */
    quickFilter: (key: string) => `div.js--data-grid-toggle-quick-filter:has(input[name="${key}"]) button`,
    quickFilterOn: (key: string) => `div.js--data-grid-toggle-quick-filter:has(input[name="${key}"]) i.button--toggle-on`,
    myProgramKey: "studentPerspective",
  },

  pagination: {
    /** "1296 results" and "1 - 50". */
    data: ".pagination--data",
    next: 'a[aria-label="Go to next page"]',
  },

  /** "Upload A Document" page reached from the documents landing/grid pages (form POST). */
  upload: {
    openLink: 'a.btn:has-text("Upload A Document"), button:has-text("Upload A Document")',
    form: "#fileUploadForm",
    name: "#fileUploadForm input[name=docName]",
    type: "#fileUploadForm select[name=docType]",
    file: "#fileUpload_docUpload",
    uploadedMarker: "#fileUploadForm input[name=docUploaded]",
    submit: "#submitFileUploadFormBtn",
  },

  posting: {
    header: ".dashboard-header__posting-title",
    title: ".dashboard-header__posting-title h2",
    deadlineLabel: "Application Deadline",
    requiredDocsLabel: "Application Documents Required:",
  },

  apply: {
    customPackageLabel: "Create Custom Application Package",
    defaultPackageLabel: "Default Application Package",
    packageName: 'input[name="name"]',
    docRadio: (typeId: string, docId: string) => `input[type="radio"][name="${typeId}"][value="${docId}"]`,
    docRadiosForType: (typeId: string) => `input[type="radio"][name="${typeId}"]`,
    selectExistingButton: (typeId: string) => `button[onclick*="selectExistingDocModal_${typeId}"]`,
    selectExistingModal: (typeId: string) => `#selectExistingDocModal_${typeId}`,
    selectExisting: (typeId: string) => `select[name="selectExisting_${typeId}"]`,
    nextButton: "button.js--ui-wizard-next-btn",
    finalStep: "#finalConfirmation",
    confirmContent: "#confirmStepAjax",
    finishButton: "button.js--ui-wizard-finish-btn",
    currentStep: ".js--ui-wizard-step.current-step",
    wizard: "#applyWizard",
  },
};

/**
 * Field labels WaterlooWorks renders inside a posting panel. Used as section boundaries when
 * splitting the panel text; employer-written headings are deliberately absent.
 */
export const POSTING_LABELS = [
  "Work Term",
  "Job Type",
  "Job Title",
  "Number of Job Openings",
  "Level",
  "Region",
  "Job - Address Line One",
  "Job - City",
  "Job - Province/State",
  "Job - Postal/Zip Code",
  "Job - Country",
  "Employment Location Arrangement",
  "Additional Employment Arrangement Location Information",
  "Work Term Duration",
  "Special Job Requirements",
  "Job Summary",
  "Job Responsibilities",
  "Required Skills",
  "Transportation and Housing",
  "Compensation and Benefits",
  "Targeted Degrees and Disciplines",
  "Application Deadline",
  "Application Documents Required",
  "Additional Application Information",
  "Application Method",
  "Organization",
  "Division",
] as const;
