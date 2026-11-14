# Sender domains for ATS and scheduling-tool mail

Research for issue #19. Question: which domains do Greenhouse, Lever, Ashby, Workday and common scheduling tools send candidate mail from, and where can the employer send from its own domain instead? This feeds Track's match order (thread, then sender domain, then company, then role) from issue #5. Public vendor documentation only; no mailbox was read. Researched 2026-11-13.

## Summary

- A fixed list of ATS sender domains is only a weak hint. It identifies the vendor, not the employer, so it can never match an Application to a company on its own.
- Greenhouse, Ashby and GoodTime let employers send from their own domain after DNS verification. Workday and Calendly send from vendor-owned addresses. ModernLoop sends as the individual user's own mailbox.
- The reliable signals for Track are therefore the thread (including `In-Reply-To`/`References`), then the Reply-To and display name, then company and role in the body. Sender domain is useful mainly as an "is this ATS or scheduling mail at all" filter.

## Per-vendor findings

| Vendor | Default sender | Employer can use own domain? | Source quality |
|---|---|---|---|
| Greenhouse | `no-reply@greenhouse.io`, `no-reply@us.greenhouse-mail.io`, `no-reply@eu.greenhouse-mail.io`, `no-reply@anz.greenhouse.io` | Yes. Verified domain, with a `gh-mail` subdomain on the envelope | Primary |
| Lever | Outbound default not confirmed. `hire.lever.co` / `hire.eu.lever.co` are documented as inbound forwarding addresses | Unconfirmed | Mostly secondary |
| Ashby | `no-reply@ashbyhq.com` | Yes, Enterprise plan only | Primary |
| Workday Recruiting | Tenant address `<tenant>@myworkday.com` (one university example) | Not documented in what was reachable | One customer example only |
| Calendly | `notifications@calendly.com` | No for email confirmations | Primary |
| GoodTime | Vendor `no-reply`, domain not named | Yes, via three CNAMEs | Primary |
| ModernLoop | The user's own Gmail or Microsoft 365 address | Not applicable (sends as the user) | Primary |
| Greenhouse scheduling | Same Greenhouse no-reply addresses for self-schedule requests | Yes, via verified domain and global email address | Primary |

### Greenhouse

- Greenhouse documents four no-reply From addresses used for automated mail to candidates, including self-schedule requests and forms: `no-reply@greenhouse.io`, `no-reply@us.greenhouse-mail.io`, `no-reply@eu.greenhouse-mail.io`, `no-reply@anz.greenhouse.io`. The From address depends on the message and the region; the page does not map one to the other. https://support.greenhouse.io/hc/en-us/articles/17675865619099
- After an employer verifies its domain it can send no-reply mail from its own address by setting a global email address. Same page.
- Domain verification generates SPF, a 2048-bit DKIM key and an MX record, and Greenhouse "will automatically append the subdomain gh-mail to your existing domain". The `gh-mail` subdomain appears only on the envelope; users see their own address as From, but mail is "sent on behalf of one of our third-party mail servers" (Mailgun). https://support.greenhouse.io/hc/en-us/articles/201111684
- Candidate-facing messages can therefore arrive with the recruiter's employer-domain address as From while the envelope sender and DKIM domain belong to Greenhouse or to `gh-mail.<employer-domain>`.
- Secondary-only: a search summary said unverified domains send via `outbound-mail.greenhouse.io`. Not confirmed on the primary pages fetched.
- Calendar invites for interviews carry a Greenhouse calendar address as a guest; that address is per organization, so it cannot be a fixed domain. https://support.greenhouse.io/hc/en-us/articles/360050154551

### Lever

- Lever's help centre describes `applicant@hire.lever.co` (and a `hire.eu.lever.co` form for EU) as addresses to forward applications to. That is an inbound address, not proof of the outbound sender. https://help.lever.co/hc/en-us/articles/20087329859869 (page body failed to load when fetched; this is from a search snippet, so unverified).
- "Lever Mail" lets recruiters send without exposing their personal address, showing the company name. https://help.lever.co/hc/en-us/articles/20087369773725 (body failed to load; snippet only).
- Secondary-only: Email Detective reports Lever mail DKIM-signs with `hire.lever.co` via Mailgun and a DMARC policy of `p=quarantine`. Treat as unverified. A Lever status page incident confirms Mailgun carries a "Lever-created sub-domain" and Lever Mail. https://status.lever.co/incidents/vxwmbt90f85l
- No official Lever guide for employer custom sending domains was found. This remains an open gap.

### Ashby

- Default no-reply address is `no-reply@ashbyhq.com`, used for candidate-facing mail such as application confirmations. https://docs.ashbyhq.com/email-domain-setup
- Enterprise admins can add a custom domain (three CNAMEs, one MX, one TXT); sender addresses must then belong to that domain. Admins can replace the default no-reply under Shared Email Aliases. Same page.
- Ashby also supports personal and shared email aliases (linked from https://docs.ashbyhq.com/emails-and-candidate-texting), whose detail pages were not read.

### Workday

- Workday's own admin page reached (https://doc.workday.com/admin-guide/en-us/human-capital-management/recruiting/candidates/prospect-and-candidate-management/configure-email-notifications.html) does not name the From address or say whether a tenant can change it.
- A customer (University of Wisconsin-Madison) documents that the candidate message template From Email Address "will default to 'wisconsin@myworkday.com'", with From Display Name and Reply-To "changed as needed". https://hr.wisc.edu/hr-guides/for-hr-professionals/candidate-message-templates/ This is customer documentation, so a secondary source for Workday's general behaviour.
- Pattern: the local part is the tenant name and the domain is `myworkday.com`, so the domain is shared by every Workday employer and the tenant name is the employer signal. Reply-To is editable, so replies may go to a real employer address.

### Scheduling tools

- Calendly: "Calendly sends email confirmations from notifications@calendly.com"; Reply-To defaults to the host's login email and can be switched to an unmonitored no-reply. https://calendly.com/help/how-to-use-a-no-reply-email-for-confirmations Calendar invitations route through the host's connected calendar provider, so they arrive from the host's own address instead (community staff replies, secondary; the help page itself does not say). A staff community reply says confirmations cannot be sent from the host's address. https://community.calendly.com/how-do-i-40/can-i-change-the-email-address-email-confirmations-are-sent-from-1531
- GoodTime: without DNS setup, candidate mail goes via "no-reply"; with it GoodTime sends "from your company domain". https://support.goodtime.io/hc/en-us/articles/4411646627479 The setup is three CNAMEs (`gtmail.<company-domain>`, `gt._domainkey.<company-domain>`, `gt2._domainkey.<company-domain>`) pointing at SendGrid. https://support.goodtime.io/articles/4569531780 The default no-reply domain is not named in any page read.
- ModernLoop: sends through the user's own Gmail or Microsoft 365 account so mail "appear[s] to come directly from your email address". https://help.modernloop.io/articles/3497473200-google-workspace-user-app-install-email-send (Microsoft equivalent, title only: https://help.modernloop.io/articles/9952284511-microsoft-365-user-app-install-email-send-calendar). These look like ordinary employer mail with no vendor domain at all.
- Greenhouse scheduling: self-schedule and reminder emails come from the Greenhouse no-reply addresses above; reminders "cannot be edited". https://support.greenhouse.io/hc/en-us/articles/17435302491547-Candidate-interview-reminders (search snippet).

## Implications for Track

1. Sender domain identifies the platform, not the employer, for Greenhouse, Ashby, Calendly and Workday defaults. Matching an Application by domain only works when the employer's own domain is used.
2. When employers verify a domain (Greenhouse, Ashby Enterprise, GoodTime) or when ModernLoop and Calendly invites send as a person, the From domain is the employer's. These mails match by domain with no vendor list needed, but cannot be recognised as ATS mail by domain alone.
3. Practical match order: thread first; then From or Reply-To domain compared with the Application's company domain; then, for known vendor domains, the display name and body text for company, then role. Treat known vendor domains as "ATS mail, company unknown" rather than a miss.
4. Keep the vendor-domain list small, data-driven and versioned, since the vendors above change addresses (Greenhouse already has four).

## Open gaps

- Lever's real outbound sender and whether employers can use their own domain.
- Workday's default sender beyond one customer's example, and whether tenants can use their own domain.
- GoodTime's default no-reply domain; ModernLoop's Microsoft article body.
- Which Greenhouse no-reply address goes with which message type.
