# Resume file formats and layouts Greenhouse, Lever and Ashby parse reliably

Research for issue #17. Question: which file types and layouts can the Tailor Stage emit so the tailored resume uploads and parses on Greenhouse, Lever and Ashby, and what limits should Apply respect when it fills the upload field?

Researched 2026-11-13. Primary sources are vendor help centres and docs. Anything not confirmed from a vendor page is flagged **[unverified]**.

## Answer in brief

- Emit a **single-column, text-based DOCX or PDF**. Both are accepted by all three boards. No vendor says one parses better than the other.
- Keep the file **under 2.5 MB**, the tightest documented limit (Greenhouse parser). Ashby's parse limit is 16 MB.
- **No columns, tables, text boxes, graphics/photos, or name/contact details in a header or footer.** Greenhouse names all of these as parse failures. Lever and Ashby publish no layout list.
- Use standard section headings, full company names with Inc/Ltd/LLC style identifiers, and full job titles.
- The resume upload is the parsed path. No source describes a paste-text alternative for the Resume field on any of the three boards.

## Per-board findings

### Greenhouse

| Item | Finding | Source |
|---|---|---|
| Accepted types | .doc, .docx, .pdf, .rtf, .txt | [Supported formats](https://support.greenhouse.io/hc/en-us/articles/360052218132) |
| Upload size | Up to 100 MB (resume, cover letter, attachment questions) | same |
| Parse size | "Greenhouse Recruiting can't parse resumes larger than 2.5MB"; a resume with many high-quality images may exceed it | [Unsuccessful resume parse](https://support.greenhouse.io/hc/en-us/articles/200989175-Unsuccessful-resume-parse) |
| Layout features that fail | Tables, headers and footers in complex resumes; columned layout; name and contact info in header, footer or text box; graphics, photos, word art; resume uploaded as an image; spaces between letters; no clear sections or inconsistent formats per section | same |
| Content that hurts | Company names without Inc/Co/LTD/LLC; abbreviated titles such as "Sr. Account Exec" | same |
| On failure | Resume is only attached; recruiter enters details manually. Formatting problems may give a partial parse | same |
| Other | Non-standard file type or unrecognised characters also cause import failure; externally linked images are not loaded in the PDF preview (embedded images are fine) | [Why didn't the resume import](https://support.greenhouse.io/hc/en-us/articles/200721684-Why-didn-t-the-candidate-s-resume-import-correctly) |
| File name limit | None documented | checked both pages above |

The parse page gives ".docx or .pdf" as examples and no full list; the supported-formats page is the authoritative type list.

### Lever

| Item | Finding | Source |
|---|---|---|
| Parser-supported types | Microsoft Word (incl. .docx), Adobe PDF, RTF, Corel WordPerfect, HTML, MS Office HTML, Open Office (ODF) | [Understanding resume parsing](https://help.lever.co/hc/en-us/articles/20087345054749) **[unverified directly]**: the page rendered only a CSS error when fetched; the list comes from a search-engine summary of that official article |
| Scanned files | Older help page recommends converting scans to a supported type with Acrobat or Google Drive | [legacy article](https://lever-old.zendesk.com/hc/en-us/articles/360056337151) **[unverified]**: returned 403; known only via search summary |
| Layout features | No vendor list found. Claims that Lever cannot parse image files are from third-party guides only **[unverified]** | none |
| Size | Application-question uploads: 100 MB reported; API upload endpoint: 30 MB ([Lever API docs](https://hire.lever.co/developer/documentation)). Third parties say 10 MB for resumes **[unverified]** | search summaries; help articles returned 401 |
| File name limit | None found | |

Lever is the weakest-evidenced board; its help articles blocked automated fetches. A live test upload would settle it.

### Ashby

| Item | Finding | Source |
|---|---|---|
| Accepted types | Upload fields take standard documents (PDF, DOC, DOCX), images and video; executables and some text formats unsupported | [Application forms](https://docs.ashbyhq.com/application-forms) (types list via search summary; size lines fetched directly) |
| Plain text | .txt and .md accepted in application-form file fields since 2026-08-21 (All-in-one ATS, Foundations, Plus and Enterprise plans). Whether the Resume field parses them is not stated | [Product update](https://www.ashbyhq.com/product-updates/txt-md-application-file-field) |
| Size | 50 MB maximum for resume uploads; resumes must be 16 MB or smaller "to be processed for full text searches and auto-filling application fields" | [Application forms](https://docs.ashbyhq.com/application-forms) |
| Autofill | "Autofill from resume" (admin-enabled) fills resume, name, email, location, education history, social links; only for fields on the form; not guaranteed complete | [Job board setup](https://docs.ashbyhq.com/job-board-configuring-your-setup) |
| Layout features | No layout rules published. An optional AI feature, enhanced resume parsing, is documented as improving parsing of "more complex layouts or formatting" and more languages, applied only to resumes added after it is enabled | [AI features](https://docs.ashbyhq.com/ai-features-in-ashby) (via search summary) |
| File name limit | None found | |

## Upload versus pasted text

- Resume fields on all three boards are file uploads; the parser and, on Ashby, the autofill run on the uploaded file.
- No vendor source found describes pasting resume text into the Resume field. Greenhouse's documented text route is a short-text custom question holding a link, for files over 100 MB.
- Ashby's autofill happens on upload, so upload is the path that fills form fields; Apply's Fill plan should still check every field on read-back, since Ashby says autofill may leave fields empty.

## Implications for Tailor and Apply

1. Tailor's default output: one-column DOCX and a text-based (not scanned/outlined) PDF generated from the same content. Picking one is a design choice; the sources do not rank them.
2. Tailor should lint its output against the Greenhouse failure list (the strictest published) and cap size well under 2.5 MB.
3. Apply should attach the file via the form's file input, then verify parsed fields on read-back rather than trusting autofill.
4. Plain text (.txt) is accepted by Greenhouse and by Ashby upload fields; not listed for Lever's parser. Avoid it as the primary format.

## Gaps and secondary-source flags

- Lever file-size and layout rules, and its parser list, rest on search summaries; confirm with a test upload or Lever support.
- Ashby's parser format list is not published separately from the upload-field types.
- No board documents a file name length or character limit. Using a plain ASCII name with no spaces (e.g. `Firstname-Lastname-Resume.pdf`) is a precaution, not a documented requirement.
- Third-party "ATS guide" sites were seen in searches and deliberately not relied on.
