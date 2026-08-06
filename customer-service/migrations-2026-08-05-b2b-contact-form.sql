-- 2026-08-05 — reach orgs that only publish a contact form.
--
-- Small orgs frequently have no published address at all, just a form (the
-- referral to Genderswap is the case that surfaced it: genderswap.org/contact-us
-- and nothing else). Today that leaves two bad options — invent `info@` and
-- risk a bounce, or drop a real referred lead on the floor.
--
-- Guessing is the worse one. Unverified addresses at any scale push bounce rate
-- toward the ~2% that actually burns sender reputation, and that damage lands
-- on rubyshines.com, the same domain Klaviyo uses to reach customers. A form is
-- also usually the channel a small org actually monitors, so using it is
-- respecting how they asked to be contacted, not a workaround.
--
-- So: keep the lead, keep the referral provenance, draft the message normally,
-- and hand the operator the text plus the URL instead of a Send button. The
-- delivery channel is DERIVED (an email on file always wins) rather than stored
-- as a flag, so it can't drift out of date when a contact is added later.
--
-- Distinct from `contact_unknown`, which means "we had an address and lost it"
-- (bounce or departure) and pauses cadence entirely. A form company is
-- reachable, so it stays in the queue.

ALTER TABLE b2b_companies ADD COLUMN IF NOT EXISTS contact_form_url TEXT;

COMMENT ON COLUMN b2b_companies.contact_form_url IS
  'Contact-form URL, for orgs that publish no email. Used only when no contact and no general_email exist; the panel shows copy-paste text and this link instead of Send.';
