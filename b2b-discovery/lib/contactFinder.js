// Email noise: addresses we should ignore
const EMAIL_NOISE_DOMAINS = [
  'noreply', 'no-reply',
  'shopify.com', 'myshopify.com',
  'sentry.io', 'sentry-cdn.com',
  'facebook.com', 'instagram.com', 'twitter.com',
  'example.com', 'w3.org', 'schema.org',
  'google.com', 'googleapis.com', 'googletagmanager.com',
  'klaviyo.com', 'mailchimp.com', 'sendgrid.net',
  'wixpress.com', 'squarespace.com',
];

const EMAIL_NOISE_PREFIXES = ['noreply', 'no-reply', 'bounce', 'mailer-daemon', 'postmaster'];

// Unfilled template placeholders. These are worse than ordinary noise: the
// local part of a placeholder ("user", "youremail", "john.doe") is not in
// GENERIC_PREFIXES, so it classifies as *personal*, and pickBestEmail ranks
// personal above generic — a placeholder therefore beats the org's real info@
// address and becomes the contact we would write to. Observed live:
// user@domain.com harvested from two org sites, outranking a working address.
//
// Sending to one of these is not a wasted email, it is a bounce, and bounces
// land on rubyshines.com — the same sending domain Klaviyo uses to reach
// customers. Same reasoning as the standing rule never to guess an address.
const EMAIL_PLACEHOLDER_DOMAINS = [
  'domain.com', 'yourdomain.com', 'your-domain.com', 'mydomain.com',
  'email.com', 'youremail.com', 'yoursite.com', 'mysite.com', 'sitename.com',
  'company.com', 'yourcompany.com', 'domain.tld', 'domain.net', 'domain.org',
  'test.com', 'sample.com', 'placeholder.com', 'address.com',
];

const EMAIL_PLACEHOLDER_PREFIXES = [
  'user', 'username', 'youremail', 'your-email', 'yourname', 'your-name',
  'email', 'name', 'firstname', 'lastname', 'someone', 'somebody', 'anyone',
  'john.doe', 'jane.doe', 'johndoe', 'janedoe', 'test', 'sample',
  'placeholder', 'yourusername', 'address',
];

/**
 * Is this an unfilled template placeholder rather than a real address? A hit on
 * EITHER half is enough: `user@realorg.org` is as unsendable as
 * `info@yourdomain.com`. Pure.
 */
function isPlaceholderEmail(email) {
  const lower = String(email || '').toLowerCase().trim();
  const [prefix, domain] = lower.split('@');
  if (!prefix || !domain) return false;
  if (EMAIL_PLACEHOLDER_DOMAINS.includes(domain)) return true;
  if (EMAIL_PLACEHOLDER_PREFIXES.includes(prefix)) return true;
  // "example" as a bare label in any position — example.org, example.co.uk.
  if (/^example\./.test(domain) || domain === 'example') return true;
  return false;
}

// Generic vs personal email classification
const GENERIC_PREFIXES = [
  'info', 'hello', 'contact', 'support', 'help', 'sales', 'wholesale',
  'orders', 'admin', 'team', 'store', 'shop', 'enquiries', 'enquiry',
  'inquiries', 'inquiry', 'customerservice', 'customer', 'general',
  'mail', 'office', 'press', 'media', 'pr', 'marketing',
];

// Email priority order for pickBestEmail (lower index = higher priority)
const EMAIL_PRIORITY = ['wholesale', 'sales', 'info', 'hello', 'contact'];

function extractEmails(html) {
  if (!html) return [];

  // Match email addresses in HTML (including mailto: links)
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  const raw = html.match(emailRegex) || [];

  const seen = new Set();
  const emails = [];

  for (const email of raw) {
    const lower = email.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    // Filter noise domains
    const domain = lower.split('@')[1] || '';
    if (EMAIL_NOISE_DOMAINS.some((nd) => domain === nd || domain.endsWith('.' + nd))) continue;

    // Filter noise prefixes
    const prefix = lower.split('@')[0];
    if (EMAIL_NOISE_PREFIXES.some((np) => prefix === np || prefix.startsWith(np + '.'))) continue;

    // Filter unfilled template placeholders
    if (isPlaceholderEmail(lower)) continue;

    // Classify personal vs generic
    const isGeneric = GENERIC_PREFIXES.some((gp) => prefix === gp || prefix.startsWith(gp + '.'));
    emails.push({ email: lower, type: isGeneric ? 'generic' : 'personal' });
  }

  return emails;
}

function pickBestEmail(emails) {
  if (!emails || emails.length === 0) return null;

  // Personal emails first
  const personal = emails.filter((e) => e.type === 'personal');
  if (personal.length > 0) return personal[0];

  // Among generic, use priority order
  for (const priority of EMAIL_PRIORITY) {
    const match = emails.find((e) => e.email.startsWith(priority + '@'));
    if (match) return match;
  }

  return emails[0];
}

function extractPhone(html) {
  if (!html) return null;

  // US phone number patterns — require 10+ digits
  const phonePatterns = [
    /(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
  ];

  const faxIndicators = /fax[:\s]*(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/gi;

  // Build set of fax numbers to exclude
  const faxNumbers = new Set();
  const faxMatches = html.match(faxIndicators) || [];
  for (const faxLine of faxMatches) {
    const digits = faxLine.replace(/\D/g, '');
    if (digits.length >= 10) faxNumbers.add(digits.slice(-10));
  }

  for (const pattern of phonePatterns) {
    const matches = html.match(pattern) || [];
    for (const raw of matches) {
      const digits = raw.replace(/\D/g, '');
      const normalized = digits.slice(-10);
      if (normalized.length === 10 && !faxNumbers.has(normalized)) {
        return raw.trim();
      }
    }
  }

  return null;
}

function findContactForm(html, pageUrl) {
  if (!html) return null;

  const lower = html.toLowerCase();

  // Shopify contact page pattern
  if (pageUrl && pageUrl.includes('/pages/contact')) return pageUrl;
  if (lower.includes('/pages/contact')) {
    const match = html.match(/href=["']([^"']*\/pages\/contact[^"']*)["']/i);
    if (match) return match[1];
  }

  // Explicit <form> tags
  if (lower.includes('<form')) return pageUrl || null;

  // Embedded form services
  const formServices = ['typeform.com', 'jotform.com', 'wufoo.com', 'gravity', 'formstack'];
  if (formServices.some((s) => lower.includes(s))) return pageUrl || null;

  return null;
}

function findContactPageUrl(htmlByPage, baseUrl) {
  // Look for contact page in scraped pages
  for (const url of Object.keys(htmlByPage)) {
    const lower = url.toLowerCase();
    if (lower.includes('/contact') || lower.includes('/pages/contact')) {
      return url;
    }
  }

  // Check homepage HTML for contact link
  const homepageHtml = htmlByPage[baseUrl] || Object.values(htmlByPage)[0] || '';
  const contactLinkMatch = homepageHtml.match(/href=["']([^"']*\/contact[^"']*)["']/i);
  if (contactLinkMatch) {
    try {
      return new URL(contactLinkMatch[1], baseUrl).toString();
    } catch {
      return null;
    }
  }

  return null;
}

function resolveUrl(url, base) {
  if (!url || !base) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function findContacts(htmlByPage) {
  const allEmails = [];
  let phone = null;
  let contactFormUrl = null;
  let contactPageUrl = null;

  const baseUrl = Object.keys(htmlByPage)[0];

  for (const [pageUrl, html] of Object.entries(htmlByPage)) {
    // Emails
    const pageEmails = extractEmails(html);
    for (const e of pageEmails) {
      if (!allEmails.some((existing) => existing.email === e.email)) {
        allEmails.push(e);
      }
    }

    // Phone (take first found)
    if (!phone) {
      phone = extractPhone(html);
    }

    // Contact form
    if (!contactFormUrl) {
      const rawFormUrl = findContactForm(html, pageUrl);
      contactFormUrl = rawFormUrl ? resolveUrl(rawFormUrl, baseUrl) : null;
    }

    // Contact page
    const isContactPage =
      pageUrl.toLowerCase().includes('/contact') ||
      pageUrl.toLowerCase().includes('/pages/contact');
    if (isContactPage && !contactPageUrl) {
      contactPageUrl = pageUrl;
    }
  }

  if (!contactPageUrl) {
    contactPageUrl = findContactPageUrl(htmlByPage, baseUrl);
  }

  const best = pickBestEmail(allEmails);
  const additionalEmails = allEmails
    .filter((e) => e.email !== best?.email)
    .map((e) => e.email);

  const contactMethod = best
    ? 'email'
    : contactFormUrl
    ? 'form'
    : 'none';

  return {
    email: best?.email || null,
    emailType: best?.type || null,
    additionalEmails,
    phone,
    contactFormUrl,
    contactPageUrl,
    contactMethod,
  };
}

module.exports = {
  findContacts,
  extractEmails,
  pickBestEmail,
  extractPhone,
  findContactForm,
  isPlaceholderEmail,
};
