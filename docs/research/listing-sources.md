# Listing sources: how to read Listings and fill application forms

Research for issue #2: "How can Listings be read from LinkedIn, ATS boards and career pages?"
Researched 2026-11-12. Primary sources only. Every claim cites its source. Claims marked
**[observed]** come from live requests made on 2026-11-12 to public demo/vendor boards
(Greenhouse's own board `greenhouse`, Lever's `leverdemo`, Ashby's own board `Ashby`, Workday's own
career site `workday.wd5.myworkdayjobs.com`). Those requests used no credentials. They show what
the endpoints actually return today.

## TL;DR: recommended access method per source

| Source | Read Listings | Fill application | Main risk |
|---|---|---|---|
| **Greenhouse** | Public Job Board API, no auth (`boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`) | Playwright on the hosted form. The field schema comes from `GET /jobs/{id}?questions=true` | reCAPTCHA / email verification on submit. The POST API needs the employer's secret key |
| **Lever** | Public Postings API, no auth (`api.lever.co/v0/postings/{site}?mode=json`) | Playwright on the hosted `/apply` page. The API does not expose custom questions | hCaptcha on the hosted form. The POST API needs the employer's key |
| **Ashby** | Public Posting API, no auth (`api.ashbyhq.com/posting-api/job-board/{name}`) | Playwright on the hosted page, which is a client-rendered SPA. The form schema API needs the employer's key | reCAPTCHA. SPA markup with no stable `name` attributes |
| **Workday** | No documented public API. Use the tenant's `robots.txt` sitemaps plus JSON-LD `JobPosting` on each job page. An undocumented internal JSON endpoint also exists | Playwright, multi-step wizard, Candidate Home account per tenant | Account creation/login, multi-page flow, tenant-specific questions. Lowest determinism |
| **Company career pages** | Detect the ATS behind the page and use that ATS's route. Otherwise read JSON-LD `JobPosting` from the detail page | Same as the underlying ATS. Otherwise Playwright with label-based locators | Arbitrary markup. Respect each site's robots.txt/ToS |
| **LinkedIn** | **No automated reading.** No read API is open to third parties, and the User Agreement bans scraping and bots. The human pastes a LinkedIn URL or text, then the agent resolves to the employer's ATS posting | **Do not automate Easy Apply.** Hand off to a human, or apply via the employer's ATS | Account restriction or shutdown |

## 1. LinkedIn

### Reading Listings

- **No public read API for jobs.** LinkedIn's Job Posting API is for *posting* jobs *to* LinkedIn.
  It "enables authorized third parties such as clients, ATS systems, and job distributors to post jobs
  directly to LinkedIn on behalf of customers". LinkedIn is also "currently not accepting new
  partnerships for LinkedIn's Job Posting API". Use "is restricted to those developers approved by
  LinkedIn". https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview
- **User Agreement (effective November 3, 2025), §8.2 "Don'ts"** prohibits the following:
  - "Develop, support or use software, devices, scripts, robots or any other means or processes
    (such as crawlers, browser plugins and add-ons or any other technology) to scrape or copy the
    Services, including profiles and other data from the Services".
  - "Use bots or other unauthorized automated methods to access the Services".
  - "Override any security feature or bypass or circumvent any access controls or use limits of the
    Services".
  https://www.linkedin.com/legal/user-agreement
- **Help Center, "Prohibited software and extensions":** LinkedIn does not "permit the use of any
  third party software, including 'crawlers', bots, browser plug-ins". This includes "browser
  extensions that scrape, modify the appearance of, or automate activity on LinkedIn's website".
  Members using such tools "risk having their accounts restricted or shut down".
  https://www.linkedin.com/help/linkedin/answer/a1341387
- **robots.txt** opens with a notice that "the use of robots or other automated means to access
  LinkedIn without the express permission of LinkedIn is strictly prohibited". Even for whitelisted
  crawlers it disallows job paths such as `/jobs/view/externalApply/`, `/jobs-guest/`, `/job-apply/`
  and `/api/jobPostings/jobs*`. https://www.linkedin.com/robots.txt

**Implication:** a Playwright session logged in as the job seeker, or a guest-page crawler, that
reads LinkedIn job search results is "automated access" under §8.2. Its consequence lands on the
user's own account. Note that Playwright driving a real logged-in browser is exactly the "software ...
to scrape" case.

### Applying

- Easy Apply / onsite apply is available to programmatic partners only through Apply Connect, an
  ATS-partner integration. Job Posting API access is redirected to "request access to Apply Connect".
  https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview ,
  https://learn.microsoft.com/en-us/linkedin/talent/apply-connect
- Automating Easy Apply in the user's browser falls under the same §8.2 bot prohibition.

**Recommendation:** treat LinkedIn as a *human-supplied* source. The user pastes a job URL or the
text, or forwards LinkedIn job-alert emails. The agent extracts company and title, then finds the same
Listing on the employer's ATS board (Greenhouse/Lever/Ashby/Workday) and reads and applies there.
Never drive linkedin.com with Playwright.

## 2. Greenhouse

### Reading Listings: Job Board API (public, no auth)

- Base: `https://boards-api.greenhouse.io/v1/boards/{board_token}`. "Job Board data is publicly
  available, so authentication is not required for any GET endpoints."
  https://docs.greenhouse.io/job-board.html (formerly developers.greenhouse.io/job-board.html)
- `GET /jobs`: `content=true` adds "full post description, department, and office of each job
  post". The fields include `id`, `internal_job_id`, `title`, `updated_at`, `requisition_id`,
  `location`, `absolute_url`, `language`, `metadata`, and `meta.total`. (same source)
- `GET /jobs/{id}?questions=true` returns the **application form schema**: `questions[]` each with
  `required`, `label`, and `fields[]` of `{name, type, values}`. The types are `input_file`,
  `input_text`, `input_hidden`, `textarea`, `multi_value_single_select` and
  `multi_value_multi_select`. Optional `location_questions`, `compliance` (EEOC) and
  `demographic_questions` also appear. `pay_transparency=true` adds `pay_input_ranges`. (same source)
- **[observed]** The board `greenhouse` returned 19 jobs. The keys also include `first_published`,
  `application_deadline`, `company_name`, `departments`, `offices` and AI-disclaimer fields
  (`ai_disclaimer`, `include_ai_disclaimer`, `ai_opt_out_request_url`). `questions` returned for
  example `first_name`/`last_name`/`email`/`phone` (`input_text`, required), `resume`
  (`input_file`) + `resume_text` (`textarea`), and custom `question_<id>` textareas.
- Rate limits: none documented for the Job Board API (same source).

### Applying

- `POST /jobs/{id}` exists. It requires HTTP Basic Auth with the **employer's** API key. The doc
  calls that key "a secret key" and says "Any form posts should be proxied by your own servers". It
  is meant for employers' custom career sites, so a job seeker cannot use it.
  "Validation for required fields must be done on the client side." https://docs.greenhouse.io/job-board.html
- The hosted form is at `job-boards.greenhouse.io/{token}/jobs/{id}`. **[observed]** It renders
  inputs whose `id` matches the API field `name` (`first_name`, `last_name`, `email`, `phone`,
  `resume`). It loads reCAPTCHA.
- Greenhouse uses "Google's reCAPTCHA to help keep robots and spammers from easily applying". An
  applicant may get "an invisible reCAPTCHA or be asked to verify their email", and failing that,
  "a captcha test". Sensitivity is configured per job board.
  https://support.greenhouse.io/hc/en-us/articles/115005448066
- robots.txt: `job-boards.greenhouse.io` has no active rules. `boards.greenhouse.io` disallows only
  `/embed/`. https://job-boards.greenhouse.io/robots.txt , https://boards.greenhouse.io/robots.txt

**Determinism: HIGH.** The questions API gives a machine-readable schema (label, name, type,
required, options) *before* opening the browser. The agent can build a fill plan, map it to DOM
inputs by `name`/`id` or label, and verify every required field is set before submission. The
CAPTCHA/email verification step must be left to the human.

## 3. Lever

### Reading Listings: Postings API (public)

- `GET https://api.lever.co/v0/postings/{SITE}` (EU: `api.eu.lever.co`). `mode=json` gives JSON.
  The filters are `location`, `commitment`, `team`, `department`, `level` and `group`, with
  `skip`/`limit` for paging. The fields are `id`, `text`, `categories`, `country`, `description(Plain)`,
  `opening`, `descriptionBody`, `additional`, `lists`, `hostedUrl`, `applyUrl`, `workplaceType`
  and `salaryRange`/`salaryDescription`. https://github.com/lever/postings-api
- **[observed]** `leverdemo` also returns `createdAt` (epoch ms).
- No key is needed to list published postings. CORS is limited to the company's own domains, which
  does not matter for a server-side or CLI agent. (same source)

### Applying

- `POST /v0/postings/{SITE}/{POSTING-ID}?key=APIKEY` needs an employer API key generated by a Super
  Admin. Requests are rate limited: more than "2 application POST requests per second" gets a 429.
  Lever states that "directing candidates to Lever's hosted application form is considered a best
  practice". The API does not expose "custom questions built into your job postings".
  https://github.com/lever/postings-api
- **[observed]** The hosted `/apply` page (`jobs.lever.co/{site}/{id}/apply`) is a server-rendered
  HTML form with stable `name` attributes: `name`, `email`, `phone`, `org`, `location`, `resume`,
  `urls[...]`, `cards[<uuid>][field<n>]` (custom questions), `surveysResponses[...]`, and `eeo[gender|race|veteran|disability]`.
  It includes `h-captcha-response`, which means hCaptcha.
- robots.txt for `jobs.lever.co`: `User-agent: *` allowed with `Crawl-delay: 1`. A content signal
  says `ai-train=no`. Named AI *training* crawlers are fully disallowed, including `ClaudeBot`,
  `anthropic-ai` and `Claude-Web`. https://jobs.lever.co/robots.txt

**Determinism: MEDIUM-HIGH.** The standard fields are stable names. Custom questions are "cards"
with UUID keys that must be read from the DOM, because the API doesn't expose them. hCaptcha must
be left to the human.

## 4. Ashby

### Reading Listings: Public Job Posting API (no auth)

- `GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}?includeCompensation=true`.
  It returns `apiVersion` and `jobs[]` with `title`, `location`, `secondaryLocations`, `department`,
  `team`, `isListed`, `isRemote`, `workplaceType`, `descriptionHtml`, `descriptionPlain`,
  `publishedAt`, `employmentType`, `address`, `jobUrl`, `applyUrl` and compensation summaries.
  Per the doc, unlisted jobs (`isListed: false`) should only be reachable by direct link. https://developers.ashbyhq.com/docs/public-job-posting-api
- **[observed]** `Ashby` returned 73 jobs with those keys plus `id` and
  `shouldDisplayCompensationOnJobPostings`. No auth was needed.
- Rate limits: not documented on the posting-API page (same source).

### Applying

- The application-form schema (`jobPosting.info` returns `fields[]` with `path`, `type`, `title`,
  `isRequired`, typed String/Email/File/Date/Number/Boolean/LongText/ValueSelect/MultiValueSelect/Phone/
  SocialLink) and `applicationForm.submit` are part of the **authenticated** API.
  https://developers.ashbyhq.com/docs/creating-a-custom-careers-page
- `jobPosting.info` "Requires the `jobsRead` permission". `applicationForm.submit` "Requires the
  `candidatesWrite` permission". Auth is "HTTP Basic Auth ... Put your API key as the basic auth
  username". These are employer keys.
  https://developers.ashbyhq.com/reference/jobpostinginfo ,
  https://developers.ashbyhq.com/reference/applicationformsubmit ,
  https://developers.ashbyhq.com/docs/authentication
- **[observed]** The hosted form `jobs.ashbyhq.com/{org}/{id}/application` is a client-rendered
  app. The initial HTML has no `<form>`/input `name`s, so fields exist only after JS runs. It loads
  reCAPTCHA. `jobs.ashbyhq.com/robots.txt` disallows `/api/`, `/b/` and `/meeting/`.
  https://jobs.ashbyhq.com/robots.txt

**Determinism: MEDIUM.** There is no public schema, so the agent must take a Playwright accessibility
snapshot and map fields by visible label. Labels are reasonably consistent because Ashby renders
from a typed form definition, but there are no stable `name` attributes to anchor on.

## 5. Workday

### Reading Listings

- No documented anonymous public job API. The Workday Recruiting web services (e.g.
  `Get_Job_Postings`) are tenant-authenticated integrations. Workday's own admin docs cover career
  sites but no public feed. https://doc.workday.com/admin-guide/en-us/human-capital-management/recruiting/career-sites/gtv1538650489786.html
- Career sites publish **sitemaps** in robots.txt. Example: `workday.wd5.myworkdayjobs.com/robots.txt`
  lists `Sitemap: .../Workday/siteMap.xml` and similar. Site paths are allowed, and only `/refreshFacet/` is
  disallowed. https://workday.wd5.myworkdayjobs.com/robots.txt
- **[observed]** Job detail pages embed a schema.org `JobPosting` JSON-LD block. That is the
  documented Google format, with required `datePosted`, `description`, `hiringOrganization`,
  `jobLocation` and `title`. https://developers.google.com/search/docs/appearance/structured-data/job-posting
- **[observed, undocumented]** The career-site SPA calls an internal JSON API:
  `POST https://{tenant}.wdN.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` with
  `{"limit","offset","searchText","appliedFacets"}`. It returns `total` and `jobPostings[]`
  (`title`, `externalPath`, `locationsText`, `postedOn`, `remoteType`). `GET .../wday/cxs/{tenant}/{site}{externalPath}`
  returns `jobPostingInfo` (`jobDescription`, `jobReqId`, `timeType`, `canApply`, `questionnaireId`...).
  It is unversioned and undocumented, so it may change without notice.

### Applying

- Employers can "require accounts for all job applications" (a "Require Candidate Home Account"
  tenant setting). (Workday admin guide above.) Employer guides say external candidates "are
  required to create a Workday candidate home account when submitting their first application".
  https://kb.wisconsin.edu/workday/152462
- The wizard is multi-step and varies by employer. A typical sequence is My Information → My Experience →
  Application Questions → Voluntary Disclosures → Self Identify → Review, with an "Autofill with
  Resume / Apply Manually / Use My Last Application" start step.
  https://das.nebraska.gov/personnel/docs/NE_DAS_Personnel_Workday_User_Guides-Navigate_External_Career_Site.pdf
  (employer guide. Workday's own candidate help is not public.)

**Determinism: LOW.** The flow has account creation or login (email verification) per tenant, a
multi-page wizard, resume-parse autofill that must be *checked and corrected* rather than trusted,
repeated sections (work history entries), and tenant-specific questionnaires. It is feasible with
Playwright, but each page needs snapshot → plan → fill → verify, and the human must handle account
and verification steps.

## 6. Official company career pages

- Most company career pages embed or link to one of the ATSs above. Detect the ATS from the apply URL
  host (`job-boards.greenhouse.io`/`boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`,
  `*.myworkdayjobs.com`) and switch to that ATS's route.
- Otherwise, read the `JobPosting` JSON-LD that Google asks sites to put "on the most detailed leaf
  page possible". https://developers.google.com/search/docs/appearance/structured-data/job-posting
- Respect each site's robots.txt and terms. Fetch only pages the user asked about or the site's
  sitemap, at low rate.

## 7. Playwright mechanics for deterministic filling and verification

- Prefer user-facing locators. "We recommend prioritizing role locators". For form fields,
  `getByLabel`: "Use this locator when locating form fields". "Locators are strict": an action
  throws if more than one element matches, which works as a cheap determinism check.
  Embedded forms in iframes (e.g. Greenhouse embeds) need `frameLocator(...)`. https://playwright.dev/docs/locators
- `fill()` "works for `<input>`, `<textarea>` and `[contenteditable]`". `check()`/`setChecked()`
  handles checkboxes and radios. `selectOption()` handles `<select>`. `setInputFiles()` "expects ... an input
  element with the type 'file'". For dynamically created inputs, use
  `page.waitForEvent('filechooser')`. https://playwright.dev/docs/input
- Logged-in state (e.g. a Workday Candidate Home session) can be saved with
  `context.storageState({path})`. It "may hold sensitive cookies" and Playwright "strongly
  discourage[s] checking them into private or public repositories". Keep it gitignored.
  https://playwright.dev/docs/auth
- Suggested verify loop: read the schema (Greenhouse questions API, or a DOM snapshot), produce a
  field→value plan, fill, read values back from the DOM (`inputValue()`, checked state, uploaded
  file name), diff against the plan, and **stop before Submit** for human review and CAPTCHA.

## 8. Risks

1. **LinkedIn account loss.** Any automated read or apply against linkedin.com breaches §8.2 and
   risks restriction or shutdown of the user's account (sources in §1).
2. **CAPTCHAs on every hosted ATS form.** Greenhouse reCAPTCHA plus email verification, Lever
   hCaptcha, and Ashby reCAPTCHA. Fully unattended submission is not achievable without circumventing
   them, which we must not do. Final submit stays human-in-the-loop.
3. **Application APIs are employer-only.** Greenhouse, Lever and Ashby submit endpoints need the
   employer's secret key, so a job seeker's agent cannot use them.
4. **Undocumented Workday JSON.** The `cxs` endpoint can break without notice. Prefer sitemap plus
   JSON-LD as the stable fallback.
5. **Form drift.** Custom questions change per job (Lever card UUIDs, Greenhouse `question_<id>`),
   so fill plans must be built per Listing, never cached per company.
6. **Rate and politeness.** No documented read limits for Greenhouse or Ashby boards. Lever robots
   asks for `Crawl-delay: 1`. Poll boards infrequently, e.g. daily, and cache by `updated_at` /
   `publishedAt` / `createdAt`.
7. **AI-training opt-outs.** Lever's robots.txt sets `ai-train=no` and blocks Anthropic training
   crawlers. Job Butler must only fetch on the user's behalf and never retain board content for
   training.
