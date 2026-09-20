import { readFile } from "node:fs/promises";

const invalidated = JSON.parse(await readFile(new URL("./invalidated-runs.json", import.meta.url), "utf8"));
const escape = (value) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Key by the frozen run fingerprint so copied/offline reports keep the notice.
export function comparisonValidity(fingerprint) {
  return invalidated[fingerprint] ?? { status: "unverified" };
}

export function validityMarkdown(fingerprint) {
  const validity = comparisonValidity(fingerprint);
  return validity.status === "invalid" ? `> **比較無効（${validity.invalidatedAt}）**: ${validity.reason}\n\n` : "";
}

export function validityHtml(fingerprint) {
  const validity = comparisonValidity(fingerprint);
  return validity.status === "invalid" ? `<aside class="caveat" aria-label="比較の無効化"><p><strong>比較無効（${escape(validity.invalidatedAt)}）</strong></p><p>${escape(validity.reason)}</p></aside>` : "";
}
