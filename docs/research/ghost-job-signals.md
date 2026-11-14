# What signals reliably identify a Ghost job?

Research for issue #3. Researched 2026-11-12.

**Question.** What evidence (listing age, repost patterns, missing details, company hiring signals, ATS metadata, known data sources) reliably identifies a Ghost job, and how strong is each signal? Which can an agent check cheaply from the Listing and its source alone?

**Short answer.** No single signal is reliable, and nobody has a validated detector. Official statistics don't measure ghost postings at all ([CRS IF12977, Apr 2025](https://www.everycrsreport.com/reports/IF12977.html)). Industry estimates of prevalence cluster at around 1 in 5 postings, though they use different definitions. The best-grounded *stale* signal is **listing age**: economic theory and every survey point to older listings being more likely to be "phantoms". The best *intent* signals are **structural**: a careers-page post with no backing job (e.g. Greenhouse prospect posts), or an employer's own legal disclosure that there is "no current vacancy" (Ontario since 2026, NY pending). **Scam** signals (payment requests, crypto, text-only interviews) are different in kind and well documented by regulators. They should be a hard filter, not a score input.

---

## 1. Two different things: ghost vs. scam

| | **Ghost (stale / no intent to fill)** | **Scam (fraudulent)** |
|---|---|---|
| Who posts | A real employer (or a board that copied it) | A fraudster, often impersonating a real employer |
| Harm | Wasted time and effort | Loss of money or identity |
| Typical causes | Talent pipelining, appearing to grow, signalling to staff, internal candidate already chosen, plans changed, forgotten posting, board copies that outlive the original ([CRS](https://www.everycrsreport.com/reports/IF12977.html)) | Advance fees, fake checks, reshipping, crypto "task" jobs ([FTC](https://consumer.ftc.gov/articles/job-scams), [FBI IC3](https://www.ic3.gov/PSA/2024/PSA240604)) |
| Evidence base | Mostly vendor surveys plus a little economics | Regulator guidance (FTC, FBI) |
| Right response | Down-rank, warn | Hard reject, warn the user |

The glossary's "Ghost job" ("fake, stale, or never intended to be filled") covers both. The research suggests Screen should model them as two checks with different actions.

## 2. How big is the problem (calibration for priors)

| Source | Claim | Quality |
|---|---|---|
| [CRS IF12977](https://www.everycrsreport.com/reports/IF12977.html) (Apr 2025) | "No official statistics" on ghost postings. Many estimates come from firms that sell verification tools and disclose their methods unevenly. JOLTS counts only openings that are specific, available within 30 days and actively recruited. | High (neutral, government) |
| [Greenhouse 2024 State of Job Hunting](https://www.greenhouse.com/blog/greenhouse-2024-state-of-job-hunting-report) | 18–22% of jobs posted on Greenhouse in a given quarter are "classified as ghost jobs". 3 in 5 candidates suspect they've met one. | Medium. Platform data, but the classification method isn't disclosed. |
| [Revelio Labs](https://www.reveliolabs.com/news/macro/ghost-job-postings/) (Oct 2023) | Hires per posting (a posting matched to a hire at the same company, role, seniority and state within 6 months) fell from 0.75 in 2018 to below 0.5 in 2023. Labor shortages may explain part of the fall. | Medium. Transparent method, but it measures *unfilled* postings, not intent. |
| [Ng, arXiv 2410.21771](https://arxiv.org/abs/2410.21771) (Oct 2024) | Up to 21% of Glassdoor postings may be ghost. Higher at larger firms and in specialized industries. LLM/BERT labelling. | Low–medium. Single-author preprint, not peer reviewed. The full labelling method could not be retrieved for this note. |
| [Albrecht, Decreuse & Vroman, *Int. Econ. Rev.* 64(2) 2023](https://econpapers.repec.org/RePEc:wly:iecrev:v:64:y:2023:i:2:p:837-869) ([WP](https://repec.iza.org/dp13704.pdf)) | Ads for filled vacancies often stay up ("phantom vacancies"). **Older listings are more likely to be phantoms.** Job seekers rationally favour young listings. | High (peer-reviewed theory with a US calibration) |
| Resume Builder, hiring-manager survey, May 2024 ([Scripps summary](https://www.scrippsnews.com/business/jobs-employment/4-in-10-companies-have-posted-a-fake-job-listing-this-year-heres-why)) | n=649. About 40% of companies had posted a fake listing that year, and 79% of those still had one active. Top motives were appearing open to talent and appearing to grow. About 84% sometimes or always contacted the applicants. | Low–medium. Self-reported, by a vendor survey site. |
| [Resume Builder, job-seeker survey, Aug 2026](https://www.resumebuilder.com/ghost-jobs/) | n=1,011. Why seekers *suspected* a ghost: listing up too long or after being filled (38%), repeatedly removed or reposted (34%), no response or no timeline (34%), role frozen or cancelled (24%). | Low. These are perceptions, but they show which signals people actually notice. |
| Clarify Capital manager survey, Aug–Sep 2022, n=1,045 ([CRS cites it](https://www.everycrsreport.com/reports/IF12977.html); [coverage](https://www.audacy.com/wxrt/news/local/what-are-ghost-jobs-more-seekers-getting-trapped-by-them)) | 68% had postings up for more than 30 days, and about 1 in 10 for more than 6 months. About half keep postings open because they are "always open to new candidates". 27% forgot to take a posting down. 40% didn't expect to fill active posts for 2–3 months. | Low–medium. The [primary page](https://clarifycapital.com/job-seekers-beware-of-ghost-jobs-survey) returned 403, so these figures come via secondary coverage. |

Revelio itself notes labor shortages and economic uncertainty also depress hires-per-posting, so "unfilled" is not the same as "never intended" ([Revelio](https://www.reveliolabs.com/news/macro/ghost-job-postings/)).

**Implication.** A base rate of about 20% means a weak signal alone will produce many false positives. Screen should down-rank and explain rather than drop on soft signals.

## 3. Candidate signals

Ratings:
- **Strength** is how much the signal shifts the odds.
- **Evidence** is the quality of the support for it.
- **Cost:** **L** = checkable from the Listing and its source page or API alone. **X** = needs external data or a second fetch.

### 3a. Ghost (stale / no hiring intent)

| # | Signal | Strength | Evidence | Cost | Notes |
|---|---|---|---|---|---|
| G1 | **Listing age** (days since original post) | Medium–High | High in theory ([Albrecht et al.](https://econpapers.repec.org/RePEc:wly:iecrev:v:64:y:2023:i:2:p:837-869)). Surveys back it (Clarify: 68% more than 30 days; [Resume Builder 2026](https://www.resumebuilder.com/ghost-jobs/): 38%). | L | Sources: schema.org `datePosted`, which Google says is "the original date that employer posted the job" ([Google JobPosting docs](https://developers.google.com/search/docs/appearance/structured-data/job-posting)). Greenhouse `first_published` / `updated_at` ([Job Board API](https://docs.greenhouse.io/job-board.html)). Ashby `publishedAt`, "when the job was last published" ([Ashby API](https://developers.ashbyhq.com/docs/public-job-posting-api)). The Lever public API documents **no** date field ([lever/postings-api](https://github.com/lever/postings-api)). Caveat: "last published" and `updated_at` reset on edits or reposts, so they *understate* age. Prefer the earliest date seen. A 30-day threshold mirrors JOLTS's "available within 30 days" ([CRS](https://www.everycrsreport.com/reports/IF12977.html)); 60–90+ days is a stronger flag. |
| G2 | **Expired but still served** (`validThrough` in the past, or a filled job still listed) | High when present | High. [Google](https://developers.google.com/search/docs/appearance/structured-data/job-posting) requires expired jobs to set a past `validThrough`, return 404/410, or drop the markup. | L | Also check Greenhouse `application_deadline` ([API](https://docs.greenhouse.io/job-board.html)). |
| G3 | **Aggregator copy whose original is gone** (board listing live, employer careers page or ATS returns 404 / job missing) | High | Medium. CRS names "job boards automatically copy postings" that outlive removal at the source as a cause ([CRS](https://www.everycrsreport.com/reports/IF12977.html)). | X (one extra fetch) | Probably the most decisive cheap check: follow the apply URL to the employer ATS and confirm the job exists. |
| G4 | **Pipeline / evergreen post** (not tied to a requisition) | High for "no current vacancy" | High (vendor documentation). | L | Greenhouse "prospect posts" are "not linked to any specific job" and skip job approvals ([Greenhouse support](https://support.greenhouse.io/hc/en-us/sections/360004675132-Prospect-Post)). In the Job Board API, `internal_job_id` is **null for prospect posts** ([API](https://docs.greenhouse.io/job-board.html)). That makes it a machine-checkable flag. Text cues include "talent community", "general application" and "talent bank" ([Indeed classes "talent bank" listings created only to collect resumes as fake](https://au.indeed.com/help/job-seekers/articles/360028156452-how-to-report-a-job)). Ashby `isListed=false` means the job is reachable only by direct link ([Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api)). |
| G5 | **Employer's own vacancy disclosure** | Very high where present (a legal statement) | High (statute) | L | Ontario ESA s.8.5, in force 2026-01-01: employers with 25+ employees must state whether a public posting is for an "existing vacancy" ([ontario.ca recent changes](https://www.ontario.ca/document/your-guide-employment-standards-act-0/recent-changes)). NY S8877 passed both chambers and is pending signature as of the source date. It would require a bold, capitalized statement: vacancy filled within 90 days (with a start date), not within 90 days ("no sooner than" date), or **no current vacancy / collecting resumes** ([Saiber, Jun 2026](https://www.saiber.com/insights/publications/2026-06-29-new-york-state-senate-and-assembly-pass-legislation-that-requires-greater-transparency-for-job-postings)). Pending elsewhere: NJ, CA AB 1251, KY HB 57 ([CRS](https://www.everycrsreport.com/reports/IF12977.html)). Parse the text for these statements. A *missing* statement from a covered Ontario employer is a weak negative. |
| G6 | **Repost pattern** (same title, company and location reappearing with a fresh date) | Medium | Low–medium. Perception survey only ([Resume Builder 2026](https://www.resumebuilder.com/ghost-jobs/): 34%). LinkedIn documents that a repost "will be treated as a new job" ([LinkedIn help](https://www.linkedin.com/help/learning/answer/a522249)). LinkedIn's "Reposted" label has no official documentation. | X (needs history) | Job Butler can build the history itself by remembering Listings across Discover runs, at no extra cost after the first run. Reposting also defeats G1, which makes the history worth keeping. Caveat (inference, unsourced): legitimate high-turnover roles also repost. |
| G7 | **Hiring freeze / recent layoffs** at the company | Medium | Medium. Resume Builder 2026: 24% cite frozen or cancelled roles. WARN notices are a statutory primary source (60-day notice to state and local officials, [29 USC 2102](https://www.law.cornell.edu/uscode/text/29/2102); [DOL WARN](https://www.dol.gov/agencies/eta/layoffs/warn)). | X | WARN data is per state and in inconsistent formats. Layoffs don't stop all hiring. Treat this as a contextual down-rank. |
| G8 | **Missing salary / vague details** | Low–Medium | Low as a ghost signal: no study links it. In pay-transparency jurisdictions (e.g. CO, NY, CA, WA, IL) a missing range breaks the law ([Brightmine summary](https://www.brightmine.com/us/resources/u-s-pay-transparency-laws-by-state-and-locality/)), which says more about the poster's care than its intent. | L | Lever `salaryRange` is optional ([Lever](https://github.com/lever/postings-api)). Ashby returns compensation only with `includeCompensation=true` ([Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api)). Use this as a tie-breaker, not a driver. |
| G9 | **Firm size / industry priors** | Low | Low–medium. Larger firms and specialized industries ([Ng](https://arxiv.org/abs/2410.21771)). Construction 38%, arts 34%, legal 29% on Greenhouse ([Greenhouse via coverage](https://www.unleash.ai/artificial-intelligence/greenhouse-61-of-job-seekers-have-been-ghosted-during-the-recruitment-process/)). Management and Finance show unexplained hires-per-posting declines ([Revelio](https://www.reveliolabs.com/news/macro/ghost-job-postings/)). | L/X | Too coarse to act on. At most a small prior. |
| G10 | **Low hires-per-posting for the company** (many postings, few hires) | Medium | Medium (Revelio's method) | X (paid workforce data) | Out of scope for v1. |

### 3b. Scam (fraudulent)

| # | Signal | Strength | Evidence | Cost | Notes |
|---|---|---|---|---|---|
| S1 | **Any payment by the applicant** (fees, starter kits, training, certification, equipment) | Decisive | High. "If someone asks you to pay to get a job, that's a scam" ([FTC](https://consumer.ftc.gov/articles/job-scams)). Google bans postings that require applicant payment ([Google](https://developers.google.com/search/docs/appearance/structured-data/job-posting)). | L (text) | |
| S2 | **Cryptocurrency payments to the employer**, or "optimization" tasks | Decisive | High ([FBI IC3 I-060424-PSA](https://www.ic3.gov/PSA/2024/PSA240604)) | L | |
| S3 | **Check deposit and send-back**, check for home-office equipment | Decisive | High ([FTC](https://consumer.ftc.gov/articles/job-scams), [FTC alert 2023](https://consumer.ftc.gov/consumer-alerts/2023/11/searching-job-work-remotely-avoid-scams-identity-theft)) | Usually only after contact | Matters more in Apply / Track than in Screen. |
| S4 | **Off-platform, text-only interview** (Signal, Telegram, WhatsApp) and very fast hiring | High | High ([FTC alert 2023](https://consumer.ftc.gov/consumer-alerts/2023/11/searching-job-work-remotely-avoid-scams-identity-theft)) | L (if stated in the Listing), otherwise later | |
| S5 | **Reshipping / package forwarding**, buy-and-resell luxury goods, mystery shopping with fees | Decisive | High ([FTC](https://consumer.ftc.gov/articles/job-scams)) | L | |
| S6 | **Unrealistic pay for little effort**, simple tasks, no references required | Medium–High | High ([FTC](https://consumer.ftc.gov/articles/job-scams), [IC3](https://www.ic3.gov/PSA/2024/PSA240604)) | L | Fuzzy. Use it as a score input. |
| S7 | **Impersonation**: apply link or contact domain doesn't match the employer's real domain or ATS | High | High. The FTC says scammers impersonate real employers on Indeed and ZipRecruiter ([FTC alert](https://consumer.ftc.gov/consumer-alerts/2023/11/searching-job-work-remotely-avoid-scams-identity-theft)). The FTC Impersonation Rule applies ([CRS](https://www.everycrsreport.com/reports/IF12977.html)). | L/X | Compare the apply-URL host against known ATS hosts and the company domain. |
| S8 | **Early requests for bank, tax or ID data** before an interview | High | High ([FTC alert](https://consumer.ftc.gov/consumer-alerts/2023/11/searching-job-work-remotely-avoid-scams-identity-theft)) | Later stages | |
| S9 | **Platform trust markers** (LinkedIn verification badge) | Low (positive only) | High that it means what it says. LinkedIn: the badge does **not** mean you're likelier to be hired, and its absence isn't evidence of fraud. It is still a pilot ([LinkedIn help](https://www.linkedin.com/help/linkedin/answer/a1492056)). | L | A badge lowers scam risk. It says nothing about ghost risk. |

## 4. Recommended v1 signal set

Cheap (L), plus one extra fetch (G3). Ordered by value per cost.

**Scam gate (hard filter: reject and tell the user why):**
- S1 payment requested
- S2 crypto or "optimization" tasks
- S5 reshipping, resale or mystery shopping
- S4 text-only or off-platform interview stated in the Listing
- S7 apply domain mismatched with the employer, when unambiguous

**Ghost score (soft: down-rank and explain):**

| Signal | Suggested weight | Trigger |
|---|---|---|
| G5 employer says "no current vacancy" / resumes only | Treat as a hard ghost label, overridable by the user | Text match |
| G4 prospect / evergreen post (`internal_job_id == null` on Greenhouse, "talent community", "general application") | High | API field or text |
| G2 expired (`validThrough` in the past or `application_deadline` passed) | High | Structured data |
| G3 original missing at the employer ATS or careers page | High | One fetch of the apply URL |
| G1 age: more than 30 days = medium, more than 60–90 days = high, using the earliest date ever observed | Medium → High | Dates |
| G6 repost seen in Job Butler's own Listing history | Medium | Local history |
| G8 no salary (stronger in a pay-transparency jurisdiction) | Low | Field / text |
| S6 / S9 fuzzy scam cues or a positive trust badge | Small ± | Text |

**How to combine them.** Use a **two-tier design**:
1. A **hard filter** only for decisive, regulator-backed scam indicators and the employer's own "no vacancy" statement. These have near-zero false positives and the cost of a miss is high.
2. An **additive, explainable ghost score** (points per signal, banded as Low / Medium / High risk) for everything else. Screen keeps or lowers rank and always shows the reasons, e.g. "posted 74 days ago; reposted twice; not found on employer careers page". The 20% base rate and the lack of any validated detector ([CRS](https://www.everycrsreport.com/reports/IF12977.html)) argue against dropping Listings on soft signals. A learned model is not justified until Job Butler has its own outcome data (Track stage: response vs. no response).

Signals deferred from v1: G7 (WARN / layoff feeds), G9 and G10 (priors, paid data).

## 5. Open questions surfaced

1. **Date semantics per ATS.** Greenhouse doesn't define `first_published` or `updated_at`, Ashby's `publishedAt` is "last published", and Lever exposes no date. Does any public field reliably give the *original* post date? Otherwise Job Butler must record first-seen dates itself.
2. **Listing history store.** G6 and the earliest-date version of G1 need Listings to persist across Discover runs. Where does that state live, and how are duplicates detected across boards (title + company + location normalisation)?
3. **The G3 fetch.** Is one extra HTTP fetch per Listing acceptable for Screen's cost and rate-limit budget? What about ATSs that render client-side, such as Workday?
4. **Jurisdiction awareness.** G5 and G8 depend on where the job is (Ontario, NY, pay-transparency states). Should Screen infer jurisdiction from the location field?
5. **User override and feedback.** Should the user be able to un-hide ghost-flagged Listings, and should Track outcomes feed back to tune weights?
6. **Ghost vs. scam in the glossary.** Should "Ghost job" be narrowed to stale or no-intent postings, with a separate term for fraudulent ones (e.g. "Scam listing")?

## Sources

- CRS, "Ghost" Job Postings, IF12977 (2025-04-25): https://www.everycrsreport.com/reports/IF12977.html
- Greenhouse 2024 State of Job Hunting: https://www.greenhouse.com/blog/greenhouse-2024-state-of-job-hunting-report
- Greenhouse Job Board API: https://docs.greenhouse.io/job-board.html
- Greenhouse prospect posts: https://support.greenhouse.io/hc/en-us/sections/360004675132-Prospect-Post
- Lever Postings API: https://github.com/lever/postings-api
- Ashby Public Job Posting API: https://developers.ashbyhq.com/docs/public-job-posting-api
- Google JobPosting structured data guidelines: https://developers.google.com/search/docs/appearance/structured-data/job-posting
- Revelio Labs, ghost job postings: https://www.reveliolabs.com/news/macro/ghost-job-postings/
- Ng (2024), arXiv:2410.21771: https://arxiv.org/abs/2410.21771
- Albrecht, Decreuse & Vroman (2023), Directed Search with Phantom Vacancies: https://econpapers.repec.org/RePEc:wly:iecrev:v:64:y:2023:i:2:p:837-869
- Resume Builder ghost jobs (2026 seeker survey): https://www.resumebuilder.com/ghost-jobs/
- Resume Builder 2024 hiring-manager survey (via Scripps): https://www.scrippsnews.com/business/jobs-employment/4-in-10-companies-have-posted-a-fake-job-listing-this-year-heres-why
- Clarify Capital 2022 survey: https://clarifycapital.com/job-seekers-beware-of-ghost-jobs-survey (403 on fetch; figures via https://www.audacy.com/wxrt/news/local/what-are-ghost-jobs-more-seekers-getting-trapped-by-them)
- Ontario ESA recent changes: https://www.ontario.ca/document/your-guide-employment-standards-act-0/recent-changes
- NY S8877 summary (Saiber): https://www.saiber.com/insights/publications/2026-06-29-new-york-state-senate-and-assembly-pass-legislation-that-requires-greater-transparency-for-job-postings
- FTC Job Scams: https://consumer.ftc.gov/articles/job-scams
- FTC consumer alert, remote job scams (Nov 2023): https://consumer.ftc.gov/consumer-alerts/2023/11/searching-job-work-remotely-avoid-scams-identity-theft
- FBI IC3 PSA I-060424-PSA: https://www.ic3.gov/PSA/2024/PSA240604
- Indeed, how to report a job: https://au.indeed.com/help/job-seekers/articles/360028156452-how-to-report-a-job
- LinkedIn job post verification: https://www.linkedin.com/help/linkedin/answer/a1492056
- LinkedIn repost a job: https://www.linkedin.com/help/learning/answer/a522249
- WARN Act notice, 29 USC 2102: https://www.law.cornell.edu/uscode/text/29/2102 ; DOL WARN: https://www.dol.gov/agencies/eta/layoffs/warn
- Pay transparency overview (Brightmine, secondary): https://www.brightmine.com/us/resources/u-s-pay-transparency-laws-by-state-and-locality/
