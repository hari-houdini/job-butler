# What evidence establishes UK Sponsorship for a Listing?

Resolves issue #4. Researched 2026-11-12 against GOV.UK primary sources. This is not legal advice. Thresholds change with each Statement of Changes, so the agent should load figures from data files rather than hard-coding them (see section 6).

**Answer in one line:** a Listing is *likely* sponsorable only when three independent checks pass: (a) the hiring legal entity is on the Home Office register with an A-rating on the Skilled Worker route, (b) the role maps to a SOC 2020 code marked eligible, and (c) the advertised salary clears both the general threshold and that code's going rate. Wording in the Listing can override all three ("no sponsorship"), and it is the only signal of whether the employer *will* sponsor rather than *can*.

---

## 1. The register of licensed sponsors (can this employer sponsor?)

### Where and what
- Published as "Register of licensed sponsors: workers" on GOV.UK. It "lists Worker and Temporary Worker sponsors" and "includes information about the category of workers they're licensed to sponsor and their sponsorship rating." https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers
- It is a single CSV file whose name includes the date, e.g. `SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-11-12.csv` (10.4 MB). The asset URL changes with every release (`assets.publishing.service.gov.uk/media/<id>/...`), so the agent should scrape the publication page for the current link and must not pin a URL. Same source.
- **Cadence:** no schedule is stated, but the page's update history shows updates on almost every working day. First published 13 Nov 2013. Same source.
- A sponsor's rating "appears on the published register of licensed sponsors" (Sponsor guidance Part 1, L8.26). https://www.gov.uk/government/publications/workers-and-temporary-workers-guidance-for-sponsors-part-1-apply-for-a-licence/workers-and-temporary-workers-guidance-for-sponsors-part-1-apply-for-a-licence-accessible

### Columns (checked against the 2026-11-12 file)
`Organisation Name, Town/City, County, Type & Rating, Route`

There is no company number, no postcode and no trading-name column. Observed in the 2026-11-12 file (my own analysis of the CSV):
- 142,998 rows and about 127k distinct organisation names. There is **one row per (organisation, route)**, so the same employer appears once for Skilled Worker and again for Global Business Mobility.
- `Type & Rating` values: `Worker (A rating)` 137,189; `Temporary Worker (A rating)` 5,588; `Worker (B rating)` 116; `Worker (UK Expansion Worker: Provisional )` 97; and a handful of `A (Premium)` / `A (SME+)`.
- `Route` values include `Skilled Worker` (123,036 rows), `Global Business Mobility: Senior or Specialist Worker`, `Scale-up`, `Creative Worker`, `Charity Worker `, legacy `Tier 2 General ` and others. **Values contain trailing spaces**, and names and towns have leading or trailing whitespace (`" London  "`).
- About 9,400 names contain `T/A` or "trading as", e.g. `Maxico Uk limited t/a The Amazon`, so trading names sometimes appear *inside* the legal-name field.

### Ratings and what they mean
- "An A-rated licence lets you start assigning certificates of sponsorship." A **B-rated** sponsor "will not be able to issue new certificates of sponsorship until you've made improvements". It can still issue them to current workers who are extending. https://www.gov.uk/uk-visa-sponsorship-employers/your-licence-rating
- B-rating means a time-limited action plan, and failing it leads to revocation (L8.28). A Provisional rating applies to UK Expansion Worker sponsors only (L8.29–L8.30). The Premium service "is now closed" (L9.6), so `Premium`/`SME+` labels are legacy and should be treated as A. Part 1 guidance, link above (version 08/26, updated 3 Sep 2026).
- **For a new hire, only `Worker (A …)` together with `Route = Skilled Worker` counts as "can sponsor Skilled Worker".** Global Business Mobility (intra-company) or Temporary Worker routes do not cover an external hire.

### Name-matching pitfalls
1. **Legal entity vs brand.** The register holds the licensed organisation's name (L3.7: "your organisation's name will be added to the register"). Listings use brands: "Amazon" vs `Amazon UK Services Ltd`; "Google" vs `Google (UK) Limited`. A naive substring search for "amazon" also hits `Amazon Filters Ltd` and `Amazonico UK Limited` (observed in the CSV). The fix is to normalise (lowercase, strip `ltd/limited/plc/llp/uk/(uk)/group`, punctuation and whitespace), then fuzzy-match. Treat any match below high confidence as "unknown", never as "yes".
2. **Groups and subsidiaries.** One licence may cover the head office and all UK branches, or branches may hold separate licences (L5.5–L5.6). The entity named on the Listing may therefore be absent while its parent is present, or the reverse. Town/City can help break ties.
3. **Recruiters posting on behalf.** Agencies "cannot sponsor a worker and then supply them as labour to another organisation" (L5.12). A CoS must not be assigned where the worker is hired out to "a third party who is not the sponsor" (Sponsor a Skilled Worker SK3.8). https://www.gov.uk/government/publications/sponsor-a-skilled-worker/workers-and-temporary-workers-sponsor-a-skilled-worker-accessible. So when a Listing comes from an agency, the **end client** must be on the register. An unnamed client gives "unknown". The agency's own licence is irrelevant unless the role is in-house at the agency.
4. **Staleness.** Licences are granted, downgraded and revoked continually, so cache the CSV for at most about a day and record the file date in the verdict.
5. **Presence ≠ willingness.** Being licensed only shows the employer *can* sponsor. Nothing in the register says it will sponsor *this* role.

## 2. Does the role itself qualify? (occupation + salary)

### Eligible occupations (SOC 2020)
- The job must be on the list of eligible occupations. "Higher skilled" codes qualify. "Medium skilled" codes qualify only if the job is on the Immigration Salary List or Temporary Shortage List, or (narrowly) for prison officers. https://www.gov.uk/skilled-worker-visa/your-job
- The table "Skilled Worker visa: eligible occupations and codes" (HTML) has the columns *Occupation code, Job type, Related job titles, Eligibility* (Higher Skilled / Medium Skilled / Ineligible). Example: 2134 "Programmers and software development professionals" is Higher Skilled, with related titles such as "Software developers". Codes changed to SOC 2020 on 4 Apr 2024. https://www.gov.uk/government/publications/skilled-worker-visa-eligible-occupations/skilled-worker-visa-eligible-occupations-and-codes (last updated 22 Jul 2025).
- The sponsor must choose "an appropriate and eligible SOC 2020 occupation code". A less appropriate code leads to refusal (SK4.54–SK4.57), and CASCOT is the suggested coding tool. Sponsor a Skilled Worker guidance v04/26 (valid from 8 Apr 2026), link above.

### Salary
- The minimum is the **higher of £41,700/yr or the occupation's going rate**. https://www.gov.uk/skilled-worker-visa/your-job. The threshold rose from £38,700 to £41,700 on **22 Jul 2025**, which is also when the skill level moved back to RQF 6 (degree level). Statement of Changes HC 997 explanatory memorandum: https://assets.publishing.service.gov.uk/media/68629fbcb466cce1bb121a3a/E03394848_-__HC_997__-_EXPLANATORY_MEMORANDUM__Print_Ready_.pdf
- **Going rates** table columns: *code, job type, related titles, standard rate, lower rate* (annual, with hourly in brackets). Rates are based on 37.5 h/week and pro-rated for other patterns. Examples: 2134 £54,700; 2133 £54,900; 2135 £48,500; 2136 £41,200; 2139 £52,300; 2431 £50,200. The lower rate applies only to some Health and Care roles or people whose first CoS predates 4 Apr 2024. https://www.gov.uk/government/publications/skilled-worker-visa-going-rates-for-eligible-occupations/skilled-worker-visa-going-rates-for-eligible-occupation-codes (last updated 22 Jul 2025).
- **What counts:** only guaranteed basic gross pay. Overtime, bonuses, allowances, employer pension or NI and benefits in kind are excluded, and hours count up to 48/week (SK7.2–SK7.3, SK5.11). A Listing showing "£40k + bonus" or an OTE figure must be judged on the base.
- **Discounts** ("when you can be paid less"): https://www.gov.uk/skilled-worker-visa/when-you-can-be-paid-less
  - New entrant (under 26, recent Graduate-route holder within 2 years, working towards professional registration, etc.): 70% of the going rate, floor **£33,400**, 4-year cap (SK6.45–SK6.47).
  - STEM PhD: 80%, floor £33,400. Non-STEM PhD: 90%, floor £37,500.
  - Immigration Salary List: floor £33,400, but the standard going rate is still required.
  - Health and education jobs use national pay scales, and the Health and Care threshold is a separate £25,000.
- These discounts depend on the **job seeker**, not the Listing. The agent needs the Profile (age, Graduate visa status, PhD) to apply them, so it must not assume them.

### Estimating eligibility from a Listing
1. Map title plus duties to candidate SOC 2020 codes. Match against the "Related job titles" column first, then fall back on an LLM classification or CASCOT, and keep the top 1–3 candidates.
2. Look up each code's eligibility and going rate. Use the *strictest* plausible code for a "likely" verdict, and note when codes disagree.
3. Normalise the salary: annualise, pro-rate to 37.5 h, base only, and use the *bottom* of any advertised range.
4. Required = max(general threshold, going rate). Then apply Profile-specific discounts.
5. With no salary stated, the salary check is "unknown", not a fail.

## 3. Wording signals in the Listing (will they sponsor?)

No primary source regulates this wording. The phrases below are observed conventions; treat them as a classifier vocabulary.
- **Strong negative** (override everything, verdict *unlikely*): "unable to sponsor", "no visa sponsorship", "sponsorship not available", "must already have the right to work in the UK", "we cannot offer sponsorship now or in the future", "UK/Irish citizens or settled status only", "security clearance (SC/DV) required", which in practice implies residency history.
- **Weak or ambiguous:** "must have the right to work in the UK" on its own. Employers must check every hire's right to work ("You must check that a job applicant is allowed to work for you in the UK before you employ them") and "must not discriminate against anyone because of where they're from". https://www.gov.uk/check-job-applicant-right-to-work. The phrase is often boilerplate and should be scored as mildly negative, not as a refusal.
- **Positive:** "visa sponsorship available", "we sponsor Skilled Worker visas", "relocation and visa support", "open to candidates requiring sponsorship".
- **Time-limited permission:** wording such as "Graduate visa holders welcome" may mean "no sponsorship *now*". Flag it as ambiguous.

## 4. Recommended decision procedure

Inputs: Listing (employer name, agency/client, title, description, salary, hours, location) and Profile (regime, age, visa history, qualifications).

```
1. Wording:   strong-negative phrase           -> UNLIKELY (reason: quote)
2. Employer:  resolve hiring entity (end client if agency)
              register match (A-rated, Route=Skilled Worker)
                 high-confidence match          -> employer_ok
                 B-rated / Provisional only     -> UNLIKELY (cannot issue new CoS)
                 no match, confident name       -> UNLIKELY (not licensed today*)
                 ambiguous / unnamed client     -> employer_unknown
3. Occupation: candidate SOC codes
                 all Ineligible                 -> UNLIKELY
                 Medium Skilled, not on ISL/TSL -> UNLIKELY
                 Higher Skilled                 -> occ_ok
4. Salary:    base salary vs max(threshold, going rate) after Profile discounts
                 below                          -> UNLIKELY (gap £x)
                 not stated                     -> salary_unknown
5. Verdict:   positive wording + all ok        -> LIKELY (high)
              all ok, no wording               -> LIKELY (medium: can, not shown will)
              any *_unknown, no negatives      -> UNKNOWN (list what to ask)
```
*An employer can apply for a licence after making an offer, so "not licensed" is a strong negative, not an absolute one. Lower the confidence for small firms with positive wording.

Each verdict should carry: the verdict, confidence, the reasons (each with evidence: the register row and file date, SOC code and going-rate source date, the quoted phrase), and the open questions to ask the recruiter.

## 5. Other regimes (keep the design regime-agnostic)

The same three checks generalise as **employer evidence + role/wage evidence + wording**. Each regime supplies its own data sources and thresholds:

| Regime | Employer evidence | Role / wage evidence | Notes |
|---|---|---|---|
| UK Skilled Worker | Daily CSV register with rating and route (above) | SOC 2020 eligibility + going rates | Prospective "can sponsor" register |
| US H-1B | No sponsor register. *Historical* evidence: DOL OFLC LCA disclosure data, quarterly .xlsx, cumulative per fiscal year, FEIN omitted. https://www.dol.gov/agencies/eta/foreign-labor/performance. USCIS H-1B Employer Data Hub, FY2009–FY2026 Q4, searchable by employer, city, state, NAICS; employer identified only by last 4 digits of tax ID. https://www.uscis.gov/tools/reports-and-studies/h-1b-employer-data-hub | LCA records list the SOC code and wage per filing. Prevailing wage levels come from DOL | Past filings show propensity, not a licence. Lottery and cap apply |
| Canada (TFWP) | ESDC "Positive LMIA Employers List", quarterly CSV/XLSX, by stream, NOC and location. Excludes personal-name businesses. https://open.canada.ca/data/en/dataset/90fed587-1364-4f33-a9ee-208181dc0b97 | NOC codes; LMIA is per position | Past approvals, not open jobs |
| EU Blue Card | No EU-wide register. Directive (EU) 2021/1883: contract or binding offer of at least 6 months (Art 5(1)). Salary threshold set by each Member State at 1.0–1.6× average gross annual salary (Art 5(3)), with 80% for shortage occupations or graduates within 3 years (Art 5(4)–(5)). Optional "recognised employer" schemes (Art 13). https://eur-lex.europa.eu/eli/dir/2021/1883/oj | National thresholds, published yearly | E.g. the Netherlands IND public register of recognised sponsors, updated monthly: https://ind.nl/en/public-register-recognised-sponsors |

Design implication: define a `SponsorshipRegime` interface with `employerEvidence(listing)`, `roleEvidence(listing, profile)` and `wordingLexicon`. Each check returns `{status: ok|fail|unknown, evidence[], sourceDate}`. Keep the verdict combiner in section 4 regime-neutral. Only the UK has a *prospective* licence register. The other regimes provide historical propensity, which should cap confidence at "likely (medium)".

## 6. Recent changes and dates to watch
- **4 Apr 2024:** SOC 2020 codes adopted, and standard vs lower going rates split by first-CoS date. Sources: eligible occupations and going rates pages above.
- **22 Jul 2025:** RQF 6 skill level; general threshold £38,700 → £41,700; medium-skilled roles only via ISL/TSL (HC 997).
- **5 Mar 2026 (HC 1691):** prison officer transitional threshold £31,300 until 31 Dec 2027; care-worker overseas recruitment closed. https://www.gov.uk/government/publications/statement-of-changes-to-the-immigration-rules-hc-1619-5-march-2026/explanatory-memorandum-to-the-statement-of-changes-in-the-immigration-rules-hc-1691-5-march-2026-accessible
- **8 Apr 2026:** Sponsor a Skilled Worker guidance v04/26. **Aug/Sep 2026:** Sponsor guidance Part 1 v08/26.
- **End of 2026:** Temporary Shortage List entries are due to be removed unless the MAC recommends keeping them. See the MAC TSL Stage 1 report: https://assets.publishing.service.gov.uk/media/69c55a454321776215360941/TSL_Stage_1_Report_Final_011025_-_Revised_17_March_2026__3_.pdf. This could change medium-skilled eligibility in weeks, so re-check in January 2027.
- **Immigration Salary List** page last updated 11 Nov 2025: https://www.gov.uk/government/publications/skilled-worker-visa-immigration-salary-list/skilled-worker-visa-immigration-salary-list

## 7. Open questions surfaced
- Should the job seeker's Profile include age, Graduate-visa expiry and PhD status so that new-entrant and PhD discounts can be applied? This is a privacy trade-off.
- How should the agent resolve brand → legal entity reliably? Companies House lookup (it has an API) or LLM + fuzzy match? Companies House is out of scope here.
- What is the policy when an agency hides the end client: ask the recruiter, or exclude?
- Cache and refresh: should the register CSV (10 MB, daily) be stored locally by the plugin or fetched per run?
- After the TSL review at the end of 2026, should the occupation and going-rate tables be scraped from GOV.UK HTML (no CSV is published) on a schedule?
