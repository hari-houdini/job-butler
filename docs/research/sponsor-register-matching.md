# How can a Listing's employer be matched to its entry on the UK sponsor register?

Resolves issue #18. Researched 2026-11-13. Builds on `docs/research/uk-sponsorship-evidence.md` (branch `research/uk-sponsorship-evidence`, issue #4), which established the register's shape (CSV columns `Organisation Name, Town/City, County, Type & Rating, Route`; no company number; `T/A` names inside the name field) and the A-rating plus `Route = Skilled Worker` rule. That is not repeated here. Not legal advice.

**Answer in one line:** there is no authoritative key joining a Listing to the register, because the register carries no company number. Matching is therefore a name-and-town problem. The Companies House API can turn a brand or trading name into candidate legal entities (with company number, status and address), but it does not map brands to licence holders. The register-side match must still be a normalised fuzzy match, and anything short of high confidence must give Screen's Sponsorship check an **unknown**, never a yes. Agency Listings that hide the end client cannot be resolved from public data; detect them and ask.

---

## 1. Companies House API (brand or trading name to legal entity)

Primary source: https://developer-specs.company-information.service.gov.uk/

- **Auth:** an API key sent via HTTP Basic Authentication; the key is the username and the password is ignored, so it can be blank (`curl -u my_api_key:`). https://developer-specs.company-information.service.gov.uk/guides/authorisation. The key is tied to a registered application on the Companies House developer hub (registration step not verified here). A key shipped inside a public plugin would be shared by all users, so it should be the job seeker's own key (see open questions).
- **Rate limit:** 600 requests per five-minute period per application. Over the limit gives `429 Too Many Requests` until the window resets. No rate-limit headers are documented. Companies House "reserve the right to ban without notice applications that regularly exceed" the limit, and higher limits can be requested. https://developer-specs.company-information.service.gov.uk/guides/rateLimiting. One Screen run over a few dozen Listings is far below this.
- **Search endpoint:** `GET https://api.company-information.service.gov.uk/search/companies?q=...`, with `items_per_page`, `start_index` and `restrictions`. https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference/search/search-companies
  - Each item has `title` (usually the company name), `company_number`, `company_status` (`active`, `dissolved`, `liquidation`, `administration`, `removed`), `company_type`, `date_of_creation`, `address` (including `locality` and `postal_code`), `address_snippet`, and `matches` (character offsets of what matched). https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/resources/companysearch?v=latest
  - The reference does **not** describe the ranking or matching algorithm, and does not say whether previous names are searched. Treat both as unknown until tested.
- **Advanced search:** `GET /advanced-search/companies` filters by `company_name_includes`, `company_name_excludes`, `company_status`, `company_type`, `sic_codes`, `location`, and incorporation or dissolution dates, with `size` up to 5000. It is substring-based, so it suits "all active companies whose name includes X", not ranking. https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference/search/advanced-company-search
- **What it cannot do:** it resolves a *company name* to a *company*. It has no concept of a brand, and a trading style that is not a registered company name or previous name will not be found (a consumer brand often equals a company name; a style like "The Amazon" for `Maxico Uk limited t/a The Amazon` does not). The register publishes no company number, so even a perfect Companies House hit has to be joined back to the register by name (and town), not by key.
- **Bulk alternative:** the Free Company Data Product is a monthly snapshot of live companies (`BasicCompanyDataAsOneFile-2026-11-01.zip`, 471 MB; seven parts of about 50-70 MB), "provided free of charge and will not be supported", updated within 5 working days after month end. https://download.companieshouse.gov.uk/en_output.html. The field list is in a separate PDF I did not read, so whether it includes previous names is **unverified**. At 471 MB it is too large to ship in a plugin, and the API fits a per-Listing lookup better.

**Useful role for Companies House in the design:** not as the matcher, but as a *verifier and disambiguator*. Given a candidate register row (name plus Town/City), confirm a live company with a matching name and `locality` exists, and exclude dissolved look-alikes. It yields a company number to store against the employer, so later Sightings of the same employer skip the lookup.

## 2. How the register and the going-rate tables are published

- **Register:** GOV.UK publication "Register of licensed sponsors: workers", first published 13 Nov 2013 by UK Visas and Immigration, one CSV (`SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-11-12.csv`, 10.4 MB, with an online preview). The update history shows entries on 5, 6, 9, 10, 11 and 12 Nov 2026, so effectively every working day, but no schedule is promised. https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers
- **URL stability:** the filename carries the date and the asset URL changes on each release (from #4). The stable thing is the publication page, so the plugin should fetch the page, extract the current CSV link, and store the file date with each verdict.
- **Name conventions:** the publication page says nothing about how names are written. L3.7 of the sponsor guidance says only that the organisation's name "will be added to the register"; the part of Part 1 I could read says nothing about trading names or name changes (sections after L8 and the annexes were not read). https://www.gov.uk/government/publications/workers-and-temporary-workers-guidance-for-sponsors-part-1-apply-for-a-licence/workers-and-temporary-workers-guidance-for-sponsors-part-1-apply-for-a-licence-accessible
- **Going rates and eligible occupations:** published as HTML tables on GOV.UK, last updated 22 Jul 2025 (per #4): https://www.gov.uk/government/publications/skilled-worker-visa-going-rates-for-eligible-occupations/skilled-worker-visa-going-rates-for-eligible-occupation-codes and https://www.gov.uk/government/publications/skilled-worker-visa-eligible-occupations/skilled-worker-visa-eligible-occupations-and-codes. I did not find a CSV for either, so they would be scraped from HTML, or kept as a plugin data file refreshed by hand. Cadence follows Statements of Changes (irregular, see #4 section 6).

## 3. Fuzzy-matching approaches and failure rates

**No primary source gives a failure rate for matching trading names to the sponsor register.** I found no GOV.UK, Companies House or Home Office statement on it, and the register has no key to measure against. Any percentage quoted by third-party job boards or visa-sponsor-search tools would be secondary and unverified, and none is relied on here. Accuracy must be measured by us on a labelled sample.

What the primary sources do establish about *why* failures happen:
1. The register holds the licensed organisation's name while the Listing holds a brand, so legal-name versus brand mismatches are structural (from #4, with example rows observed in the CSV such as `Maxico Uk limited t/a The Amazon`).
2. Substring matching over-matches (observed in #4: "amazon" also hits `Amazon Filters Ltd`), and exact matching under-matches. The costs differ: a false positive makes an unlicensed employer look sponsorable, a false negative hides a real sponsor.
3. One licence may cover a head office and UK branches, or branches may hold separate licences (L5.5-L5.6 per #4), so the entity on the Listing may be absent while its parent is present.

**Proposed approach (design inference, not sourced):** a tiered matcher that returns a confidence, not a boolean.
1. **Normalise** both sides: lowercase, strip punctuation and whitespace, strip legal suffixes (`ltd`, `limited`, `plc`, `llp`, `(uk)`, `uk`, `group`), split `t/a` / `trading as` into two candidate names, trim the trailing spaces seen in `Route` and `Town/City`.
2. **Tier A (exact):** normalised-name equality, with Town/City agreeing where available. Confidence high.
3. **Tier B (candidates):** token-set or Jaro-Winkler / trigram similarity above a threshold. Accept only if one candidate clearly leads and Town/City agrees with the Listing's location or the Companies House address.
4. **Tier C (verify):** for Tier B candidates, query Companies House `search/companies` with the register name and confirm an `active` company with consistent `locality`. Record the `company_number`.
5. **Otherwise** return *unknown* with the top candidates as evidence. Never default to "not on the register".
6. **Calibrate:** hand-label a sample of real Listings and report precision and recall per tier before trusting thresholds.

## 4. Detecting recruitment-agency Listings that hide the end client

- **Why it matters:** agencies "cannot sponsor a worker and then supply them as labour to another organisation" (L5.12); a licence is revoked if sponsored workers are found to be supplied as labour (L5.13); a CoS for an agency-supplied worker is allowed only where the sponsor genuinely decides "all the duties, functions and outcomes or outputs" of the job and agrees and pays the salary (L5.14). So the end client is the entity to check, and an agency's own presence on the register says little. Same Part 1 guidance URL as above.
- **Legal basis for the signal:** advertising by employment agencies and employment businesses is regulated by the Conduct of Employment Agencies and Employment Businesses Regulations 2003. Regulation 27 requires the advert to show the agency's or business's full name and whether the position is temporary or permanent, and the agency must have the hirer's written authority for each advertised role. I found **no requirement to name the hirer**, so hidden clients are lawful and common. https://www.legislation.gov.uk/uksi/2003/3319 and https://www.gov.uk/government/publications/conduct-regulations-2003-guidance-for-employment-agencies-and-employment-businesses/overview-of-the-conduct-regulations-2003. (Read via a search summary, not the full text; confirm regulation 27's wording before relying on it.)
- **Detection signals (design inference, not sourced):**
  - The employer name has recruiter patterns (`recruitment`, `resourcing`, `staffing`, `talent`).
  - The poster's Companies House `sic_codes` include employment-agency activity (the exact code list was not verified here; advanced search can filter by SIC code).
  - The description says "our client", "on behalf of", "confidential client", or the role is temporary or contract through the poster.
  - The same role text appears under several employer names across Sightings.
- **Policy suggestion:** when an agency is detected and no client is named, the Sponsorship check is **unknown** with the reason "end client hidden", and the question for the recruiter is the client's legal name and whether the client will sponsor. If the role is in-house at the agency, the agency is the hiring entity. Public data cannot tell the two apart, so the check should surface that as a flag, not hide it.

## 5. Open questions
- Where does the Companies House API key live? A shared key shares one 600/5-minute budget across installs; a per-job-seeker key adds a setup step to the Profile.
- Does `search/companies` surface previous names, and how does it rank near-matches? Needs a small live experiment with a key (not done: no key was available).
- What precision and recall does the tiered matcher reach on a hand-labelled sample, and what confidence threshold separates "match" from "unknown"?
- Should a confirmed match (register row plus company number) be cached as a per-employer record in the pipeline state, so later Sightings reuse it?
- Does the Free Company Data Product include previous names, and is a monthly offline snapshot worth shipping instead of live API calls?
