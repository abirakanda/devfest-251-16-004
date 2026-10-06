# Tender Document Package Builder

AI DevFest 2026 – Vibe Coding Contest (Solo)

- **Name:** Abir Akanda
- **Registration number:** 251-16-004
- **Live link:** https://abirakanda.github.io/devfest-251-16-004/
- **Repository:** https://github.com/abirakanda/devfest-251-16-004

A frontend-only web app (Bangla + English) that helps office staff turn a set of tender PDF files into one complete, checked and correctly ordered PDF package. All processing happens in the browser. No file is uploaded anywhere.

## How to run

No build step is needed. It is plain HTML/CSS/JavaScript.

- **Online:** open the live link in Google Chrome.
- **Locally:** open `index.html` in Chrome, or serve the folder (for example `npx serve .`) and open the shown URL.

Libraries (loaded from cdnjs): [pdf-lib](https://pdf-lib.js.org/) 1.17.1 to combine pages and add footers, and [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 to check that PDFs open.

## How to use

1. **Choose requirements.json.** The app shows the tender details and the required documents, sorted by `order`.
2. **Choose PDF files.** Pick or drag many files at once. Each file shows its name, number of pages and size. Non-PDF, fake, damaged and password-protected files are rejected with a clear message.
3. **Match files.** For each document, choose a file from the list, or click "Suggest matches from file names" and then check the suggestions. Enter an expiry date where asked.
4. **Generate the package.** The button stays disabled, with a list of reasons, until nothing is blocking. The download is named `<tender_id>_Package.pdf`.

## Main features done

- Loads `requirements.json` and shows the tender details and requirements sorted by `order`.
- Uploads many PDFs at once and shows each file's name and page count.
- Rejects non-PDF files with a clear message, including files that are named `.pdf` but are not PDFs. Any file can be removed.
- Enforces the matching rules: one document gets at most one file, and one file goes to at most one document. A match can be changed or undone at any time.
- Asks for an expiry date when `has_expiry = true` and a file is matched.
- Shows the status of each document (Missing / Expiry date needed / Expired / Not provided / OK) and updates it instantly. A document that expires on the deadline day counts as OK.
- Detects duplicates by comparing the SHA-256 hash of each file's content, so files with different names are still caught. Duplicates are marked in the file list and cannot be matched to different documents.
- Disables the Generate button while any status is blocking, and lists the reasons.
- Builds the package as follows:
  - an English cover page with the tender ID, title, procuring entity, bidder, deadline, the date the package was made, and the list of included documents in order;
  - the documents after the cover, sorted by `order`, with all pages in their original order; optional documents with no file are skipped;
  - the footer `<tender_id> | Page X of Y` on every page, including the cover.
- Keeps the footer from covering content: each original page is placed above an extra 28 pt white strip, and the footer is printed inside that strip. Rotated pages keep their correct orientation.
- Downloads the package as `<tender_id>_Package.pdf`.
- Lets the user switch the whole app between Bangla and English, and remembers the choice. Document names come from `title_bn` or `title_en`.

## Bonus features

- An index page after the cover, showing where each document starts (can be turned off).
- Checklist export as CSV (document, file name, pages, expiry date, status). The file is UTF-8 with BOM so Excel opens it correctly.
- Save and reopen: matches and expiry dates are saved in browser storage by tender ID and file content. If you upload the same files again, your work comes back.
- Auto-match: suggests matches from file names.
- Damaged and password-protected PDFs are handled safely with a clear message instead of a crash.

## Known problems

- The cover and index pages are in English only, because the standard PDF fonts cannot show Bangla text.
- Signature/seal placement and AI help are not implemented.
- Saved work keeps only matches and dates, not the files. The files must be uploaded again.

## Output (sample pack)

- `output/T-2026-0417_Package.pdf`: the package built from the provided sample pack. It has 17 pages: cover, index, then R01–R05 and R08–R10 in order.
- `screenshots/sample_problems_found.png`: the statuses while the problems are still there (expired license).
- `screenshots/sample_statuses_en.png`, `screenshots/sample_statuses_bn.png`: the final statuses, all OK, in English and in Bangla.

Problems found in the sample pack and how they were solved:

| Problem | How the app shows it | Fix |
|---|---|---|
| `company_logo.png` is not a PDF | Rejected with a message | Not used |
| `experience_cert.pdf` and `experience_cert (1).pdf` have exactly the same content | Marked "Duplicate"; cannot be matched to another document | Only one copy used, for R05 |
| `trade_license_2025.pdf` expired on 2025-06-30, before the 2026-10-20 deadline | Status "Expired"; Generate is blocked | Used `trade_license_2026.pdf` (valid until 2027-06-30) |
| The signed declaration has an unclear name (`scan_0042.pdf`, a scanned image) | R10 shows "Missing" until it is matched | Matched by hand after checking it with "View" |
| Trade license and bank solvency need expiry dates | Status "Expiry date needed" | Entered 2027-06-30 and 2026-12-31 |
| R06 and R07 are optional and have no file | "Not provided" (not blocking) | Skipped in the package |

## AI tools used

- Claude Code (Claude Opus 5.5)

## Most useful prompt

> "ekhon start koro" + the full problem statement: build a frontend-only app that loads requirements.json, uploads PDFs, matches files, checks expiry/duplicates and generates one ordered PDF package with cover and footer, in Bangla and English.

## License

MIT. See [LICENSE](LICENSE).
